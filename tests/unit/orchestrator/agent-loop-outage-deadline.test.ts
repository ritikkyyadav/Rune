/**
 * T1 — a run has a deadline for how long its provider may go unanswered.
 *
 * `maxConsecutiveErrors` bounds how many times a request is re-sent. Nothing
 * bounded how long that takes: a provider that stalls instead of failing costs
 * a first-byte timeout per attempt, under a gateway that retries each one, and
 * the plan this card comes from cites a run that sat sixteen minutes that way.
 * The count is still there. This is the clock beside it.
 *
 * What is held here:
 *   · a stall is cut at the deadline, mid-call, and ends `provider_lost` —
 *     the resumable ending, not a plain error;
 *   · retries stacked under a generous count are cut by the clock;
 *   · an answer is not an outage however slow it is, and an outage ends the
 *     moment the provider says anything;
 *   · the person's cancel is a cancel, never an outage and never a retry;
 *   · a wait that would outlast the deadline is not sat through;
 *   · with the controller owning `transport`, the decision is the same one.
 *
 * Scripted gateways and short real waits. Zero model calls.
 */

import { describe, expect, test } from "bun:test";

import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import { ApiError } from "../../../packages/llm-gateway/src/types";
import type { LlmProvider, StreamEvent } from "../../../packages/llm-gateway/src/types";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import {
  decide,
  makeShadowEvent,
  type AppliedDecisionRow,
  type GuardInputs,
} from "../../../packages/orchestrator/src/arbiter";
import {
  DEFAULT_RELIABILITY,
  policyForModel,
} from "../../../packages/orchestrator/src/reliability-policy";
import { emptyRunState } from "../../../packages/orchestrator/src/run-state";
import { ShadowArbiter, type ShadowRow } from "../../../packages/orchestrator/src/shadow-arbiter";

/** One answer from the scripted gateway. The last one repeats. */
type Step =
  /** A whole answer, in `chunks` pieces `everyMs` apart, optionally after a reported retry. */
  | { kind: "text"; text: string; chunks?: number; everyMs?: number; afterRetry?: boolean }
  | { kind: "tool"; tool: string }
  /** The gateway gave up after `afterMs` and says so. */
  | { kind: "error"; error: string; retryable?: boolean; afterMs?: number }
  /** The call itself throws after `afterMs`, as a dropped connection does. */
  | { kind: "throw"; error: string; afterMs: number }
  /** One attempt failed after `retryAtMs`; the next never says anything. */
  | { kind: "stall"; retryAtMs: number; swallowsCancel?: boolean }
  /** Nothing at all — not even the report of a failed attempt. */
  | { kind: "silence" };

/** Resolves after `ms`, or rejects the moment `signal` fires — as an aborted request does. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("request aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("request aborted"));
      },
      { once: true },
    );
  });
}

/**
 * "Never", for a provider that has gone silent: far past every deadline and
 * every test timeout here, and short enough that a run nothing cancels still
 * lets the process end.
 */
const NEVER_MS = 20_000;

const RETRY = {
  type: "retry",
  provider: "anthropic",
  model: "m",
  attempt: 1,
  of: 3,
  status: 504,
  waitMs: 1,
  reason: "stream stalled",
};

interface Call {
  /** Whether the call's own signal fired while it was in flight. */
  aborted: boolean;
}

function makeGateway(script: Step[], calls: Call[]) {
  let next = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inferStream: async function* (_request: any, opts?: { signal?: AbortSignal }) {
      const step = script[Math.min(next++, script.length - 1)]!;
      const call: Call = { aborted: false };
      calls.push(call);
      const signal = opts?.signal;
      signal?.addEventListener("abort", () => (call.aborted = true), { once: true });
      switch (step.kind) {
        case "text": {
          if (step.afterRetry) yield RETRY;
          const chunks = step.chunks ?? 1;
          for (let n = 0; n < chunks; n++) {
            if (step.everyMs) await wait(step.everyMs, signal);
            yield { type: "content_delta", delta: { type: "text_delta", text: step.text } };
          }
          yield { type: "message_stop", stopReason: "end_turn" };
          return;
        }
        case "tool":
          yield { type: "tool_use_start", toolCallId: `c${next}`, toolName: step.tool };
          yield { type: "tool_use_stop", toolCallId: `c${next}`, toolInput: { path: `f${next}` } };
          yield { type: "message_stop", stopReason: "tool_use" };
          return;
        case "error":
          if (step.afterMs) await wait(step.afterMs, signal);
          yield {
            type: "error",
            error: step.error,
            ...(step.retryable === undefined ? {} : { retryable: step.retryable }),
          };
          return;
        case "throw":
          await wait(step.afterMs, signal);
          throw new Error(step.error);
        case "stall":
          await wait(step.retryAtMs, signal);
          yield RETRY;
          // The provider never says another word. Only a cancel ends this —
          // by throwing, as an aborted request does, or by just stopping.
          if (step.swallowsCancel) await wait(NEVER_MS, signal).catch(() => {});
          else await wait(NEVER_MS, signal);
          return;
        case "silence":
          await wait(NEVER_MS, signal);
      }
    },
    infer: async () => ({
      content: [{ type: "text", text: "s" }],
      model: "m",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    registerProvider: () => {},
    getProvider: () => null,
    getTotalCost: () => 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeRegistry() {
  return {
    toLlmTools: () => [],
    get: (name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: "read",
        permissionLevel: "auto",
      },
    }),
    execute: async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

interface RunOptions {
  script: Step[];
  /** `providerDeadlineMs`. Omitted: the loop's own default. */
  deadlineMs?: number;
  maxConsecutiveErrors?: number;
  /** "transport" present: the controller owns the decision. */
  authority?: string[];
  /** Cancel, as the person would, this long after the run starts. */
  cancelAtMs?: number;
}

async function runLoop(options: RunOptions) {
  const calls: Call[] = [];
  const decisions: AppliedDecisionRow[] = [];
  const rows: ShadowRow[] = [];
  const shadow = new ShadowArbiter({
    runId: "run#1",
    emit: (row) => rows.push(row),
    now: () => "2026-10-04T00:00:00.000Z",
  });
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      maxConsecutiveErrors: options.maxConsecutiveErrors ?? 3,
      systemPrompt: "s",
      shadow,
      controller: {
        runId: "run#1",
        authority: new Set(options.authority ?? []),
        record: (row: AppliedDecisionRow) => decisions.push(row),
      },
      ...(options.deadlineMs === undefined ? {} : { providerDeadlineMs: options.deadlineMs }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    makeGateway(options.script, calls),
    makeRegistry(),
  );
  const cancel = new AbortController();
  if (options.cancelAtMs !== undefined) setTimeout(() => cancel.abort(), options.cancelAtMs);
  const startedAt = performance.now();
  const events: AgentTurnEvent[] = [];
  for await (const event of loop.run("do the thing", "s1", "/tmp", cancel.signal)) {
    events.push(event);
  }
  shadow.finish();
  const terminal = events.find((e) => e.type === "turn_complete") as
    { stopReason: string } | undefined;
  const summary = rows.find((row) => row.type === "shadow_summary") as
    { disagreementList: unknown[] } | undefined;
  return {
    calls,
    decisions,
    /** Where the shadow controller would have done something else. */
    disagreements: summary?.disagreementList ?? null,
    events,
    tookMs: performance.now() - startedAt,
    stopReason: terminal?.stopReason,
    errors: events
      .filter((e): e is Extract<AgentTurnEvent, { type: "error" }> => e.type === "error")
      .map((e) => e.error),
    text: events
      .filter((e): e is Extract<AgentTurnEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join(""),
  };
}

const STALL: Step[] = [{ kind: "stall", retryAtMs: 30 }];
/** The count alone would allow fifty of these: three seconds of them. */
const SLOW_FAILURES: Step[] = [{ kind: "error", error: "fetch failed", afterMs: 60 }];

describe("a provider that stops answering", () => {
  test("is given the deadline and no longer: the call is cut where it stands", async () => {
    for (const authority of [[], ["transport"]]) {
      const run = await runLoop({ script: STALL, deadlineMs: 200, authority });
      expect(run.stopReason).toBe("provider_lost");
      // Cut mid-call by the deadline — not left to end by itself, and not re-sent.
      expect(run.calls).toEqual([{ aborted: true }]);
      // From the request being SENT, not from the first reported retry.
      expect(run.tookMs).toBeGreaterThanOrEqual(195);
      expect(run.tookMs).toBeLessThan(1_500);
      // One error, and it is the deadline's: the cut call's own "aborted" is
      // this loop's cancel coming back, not something the provider said.
      expect(run.errors).toHaveLength(1);
      expect(run.errors[0]).toMatch(
        /^No answer from the provider for \d+s — past the outage deadline \(0s\)/,
      );
      // The shadow controller, reading the same clock, would have done the same.
      expect(run.disagreements).toEqual([]);
    }
  });

  test("the clock starts when the request is sent, not when its failure is reported", async () => {
    // The failed attempt is reported 400 ms in. A 600 ms deadline counted from
    // that report would end at a second; counted from the send, at 600 ms.
    const run = await runLoop({ script: [{ kind: "stall", retryAtMs: 400 }], deadlineMs: 600 });
    expect(run.stopReason).toBe("provider_lost");
    expect(run.tookMs).toBeGreaterThanOrEqual(595);
    expect(run.tookMs).toBeLessThan(900);
  });

  test("an outage carries into the next request, which is held to what is left of it", async () => {
    // The first request fails at 100 ms. The second says nothing at all — no
    // retry is ever reported — and is cut when the SAME outage reaches 400 ms.
    const run = await runLoop({
      script: [{ kind: "error", error: "fetch failed", afterMs: 100 }, { kind: "silence" }],
      deadlineMs: 400,
    });
    expect(run.stopReason).toBe("provider_lost");
    expect(run.calls).toEqual([{ aborted: false }, { aborted: true }]);
    expect(run.tookMs).toBeGreaterThanOrEqual(395);
    expect(run.tookMs).toBeLessThan(1_000);
  });

  test("a cut call that just stops, instead of throwing, was cut all the same", async () => {
    const run = await runLoop({
      script: [{ kind: "stall", retryAtMs: 30, swallowsCancel: true }],
      deadlineMs: 200,
    });
    expect(run.stopReason).toBe("provider_lost");
    // Not read as an empty answer and asked for again.
    expect(run.calls).toEqual([{ aborted: true }]);
    expect(run.errors).toHaveLength(1);
  });

  test("a call that is over is not cancelled afterwards", async () => {
    // Three quick failures end the run on the count, well inside the deadline.
    const run = await runLoop({
      script: [{ kind: "error", error: "fetch failed" }],
      deadlineMs: 150,
    });
    expect(run.errors.at(-1)).toBe("Too many consecutive errors (3)");
    // Past the deadline, nothing fires: every call's timer went with the call.
    await wait(300);
    expect(run.calls).toEqual([{ aborted: false }, { aborted: false }, { aborted: false }]);
  });

  test("retries stacked under a generous count are cut by the clock", async () => {
    for (const authority of [[], ["transport"]]) {
      const run = await runLoop({
        script: SLOW_FAILURES,
        deadlineMs: 200,
        maxConsecutiveErrors: 50,
        authority,
      });
      expect(run.stopReason).toBe("provider_lost");
      // Fifty were allowed. The clock allowed the few that fit in 200 ms.
      expect(run.calls.length).toBeGreaterThanOrEqual(2);
      expect(run.calls.length).toBeLessThanOrEqual(5);
      expect(run.tookMs).toBeLessThan(1_500);
    }
  });

  test("a call that throws is on the clock too, not only one that reports its error", async () => {
    const run = await runLoop({
      script: [{ kind: "throw", error: "socket hang up", afterMs: 60 }],
      deadlineMs: 200,
      maxConsecutiveErrors: 50,
    });
    expect(run.stopReason).toBe("provider_lost");
    expect(run.calls.length).toBeLessThanOrEqual(5);
    expect(run.errors.at(-1)).toMatch(/^No answer from the provider/);
  });

  test("with no deadline the count alone decides, as it always did", async () => {
    const run = await runLoop({
      script: [{ kind: "error", error: "fetch failed" }],
      deadlineMs: 0,
    });
    expect(run.stopReason).toBe("provider_lost");
    expect(run.calls).toHaveLength(3);
    expect(run.errors.at(-1)).toBe("Too many consecutive errors (3)");
  });

  test("the count still ends a run the clock has not: three quick failures", async () => {
    const run = await runLoop({
      script: [{ kind: "error", error: "fetch failed" }],
      deadlineMs: 60_000,
    });
    expect(run.calls).toHaveLength(3);
    expect(run.errors.at(-1)).toBe("Too many consecutive errors (3)");
  });
});

describe("retries stacked across the layers, through the real gateway", () => {
  /**
   * A provider whose every attempt waits 100 ms and then fails as a stalled
   * stream does — under the real gateway, which retries each call three times
   * with a back-off between, under a loop that re-sends the call three times.
   * Unbounded that is twelve attempts and about two seconds.
   */
  function stalling() {
    const attempts: Array<{ aborted: boolean }> = [];
    const provider = {
      name: "anthropic",
      infer: async () => {
        throw new Error("not used");
      },
      inferStream(_request: unknown, opts?: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
        const attempt = { aborted: false };
        attempts.push(attempt);
        opts?.signal?.addEventListener("abort", () => (attempt.aborted = true), { once: true });
        return (async function* (): AsyncGenerator<StreamEvent> {
          await wait(100, opts?.signal);
          throw new ApiError({
            status: 504,
            provider: "anthropic",
            message: "stream stalled — no data for 90s",
          });
        })();
      },
      countTokens: async () => 0,
      healthCheck: async () => true,
    } as unknown as LlmProvider;
    const gateway = new LlmGateway({
      providers: {},
      defaultProvider: "anthropic",
      maxRetries: 3,
      retryBaseMs: 40,
    });
    gateway.registerProvider(provider);
    return { gateway, attempts };
  }

  async function run(deadlineMs: number) {
    const { gateway, attempts } = stalling();
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 12,
        maxConsecutiveErrors: 3,
        systemPrompt: "s",
        providerDeadlineMs: deadlineMs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      gateway,
      makeRegistry(),
    );
    const startedAt = performance.now();
    const events: AgentTurnEvent[] = [];
    for await (const event of loop.run("do the thing", "s1", "/tmp")) events.push(event);
    const tookMs = performance.now() - startedAt;
    const terminal = events.find((e) => e.type === "turn_complete") as
      { stopReason: string } | undefined;
    return { attempts, tookMs, stopReason: terminal?.stopReason };
  }

  test("the count alone lets all twelve attempts run", async () => {
    const out = await run(0);
    expect(out.stopReason).toBe("provider_lost");
    expect(out.attempts).toHaveLength(12);
    expect(out.tookMs).toBeGreaterThanOrEqual(1_900);
  });

  test("the clock cuts them at the deadline, wherever in the ladder that falls", async () => {
    const out = await run(1_000);
    expect(out.stopReason).toBe("provider_lost");
    // The first call's four attempts and their back-offs take ~700 ms; the
    // second call is cut inside its own ladder.
    expect(out.attempts.length).toBeGreaterThanOrEqual(5);
    expect(out.attempts.length).toBeLessThanOrEqual(8);
    expect(out.tookMs).toBeGreaterThanOrEqual(995);
    expect(out.tookMs).toBeLessThan(1_600);
    // And nothing is sent after it: the cancelled back-off does not try again.
    const sent = out.attempts.length;
    await wait(400);
    expect(out.attempts).toHaveLength(sent);
  });
});

describe("what is not an outage", () => {
  test("an answer, however slow: longer than the deadline and never cut", async () => {
    const run = await runLoop({
      script: [{ kind: "text", text: "word ", chunks: 12, everyMs: 25 }],
      deadlineMs: 100,
    });
    expect(run.stopReason).toBe("end_turn");
    expect(run.text).toBe("word ".repeat(12));
    expect(run.calls).toEqual([{ aborted: false }]);
  });

  test("an answer that follows a failed attempt: the provider's first word stops the clock", async () => {
    const run = await runLoop({
      script: [{ kind: "text", text: "word ", chunks: 12, everyMs: 25, afterRetry: true }],
      deadlineMs: 100,
    });
    expect(run.stopReason).toBe("end_turn");
    expect(run.text).toBe("word ".repeat(12));
  });

  test("two outages with an answer between them: each has its own clock", async () => {
    // 150 ms twice is past a 250 ms deadline if the clock were never reset.
    const run = await runLoop({
      script: [
        { kind: "error", error: "fetch failed", afterMs: 150 },
        { kind: "tool", tool: "read_file" },
        { kind: "error", error: "fetch failed", afterMs: 150 },
        { kind: "text", text: "done" },
      ],
      deadlineMs: 250,
      maxConsecutiveErrors: 5,
    });
    expect(run.stopReason).toBe("end_turn");
    expect(run.calls).toHaveLength(4);
  });
});

describe("the person's cancel", () => {
  test("is a cancel: not an outage, not a retry, and not made to wait for the deadline", async () => {
    for (const authority of [[], ["transport"]]) {
      // The retry is reported at 30 ms, so the outage clock is already running.
      const run = await runLoop({ script: STALL, deadlineMs: 5_000, cancelAtMs: 80, authority });
      expect(run.stopReason).toBe("aborted");
      expect(run.calls).toEqual([{ aborted: true }]);
      expect(run.tookMs).toBeLessThan(1_500);
      expect(run.decisions.filter((row) => row.guard === "REPAIR_TRANSPORT")).toEqual([]);
    }
  });
});

describe("a wait that would outlast the deadline", () => {
  test("is not sat through: the run ends now, resumable, with the provider's words", async () => {
    const throttled = "All providers rate limited (anthropic). Retry in ~60s, or switch models.";
    const run = await runLoop({
      script: [{ kind: "error", error: throttled, retryable: false }],
      deadlineMs: 300,
    });
    expect(run.stopReason).toBe("provider_lost");
    expect(run.calls).toHaveLength(1);
    expect(run.tookMs).toBeLessThan(1_500);
    expect(run.errors.at(-1)).toBe(throttled);
  });
});

describe("a wait that fits inside the deadline", () => {
  test("is waited out, and is on the clock: what follows is held to what is left", async () => {
    // A throttle is not an answer. The provider asks for a second, the loop
    // waits its five-second floor, and the request after it says nothing: it
    // is cut when the outage that began at the throttle reaches seven seconds
    // — two seconds in — not left to run with a clock that never started.
    const run = await runLoop({
      script: [
        {
          kind: "error",
          error: "Rate limited on anthropic. Retry in ~1s, or switch models.",
          retryable: false,
        },
        { kind: "silence" },
      ],
      deadlineMs: 7_000,
    });
    expect(run.stopReason).toBe("provider_lost");
    expect(run.calls).toEqual([{ aborted: false }, { aborted: true }]);
    expect(run.tookMs).toBeGreaterThanOrEqual(6_950);
    expect(run.tookMs).toBeLessThan(9_000);
  }, 15_000);
});

describe("the decision, when the controller owns it", () => {
  const ask = (inputs: GuardInputs) =>
    decide(
      emptyRunState("r"),
      makeShadowEvent("r", 1, "REPAIR_TRANSPORT", inputs, "2026-10-04T00:00:00Z"),
    );

  test("past the deadline it is the environment, whatever the count says", () => {
    const d = ask({ attempts: 1, maxAttempts: 3, outageMs: 600_000, deadlineMs: 600_000 });
    expect(d.transition).toBe("abandoned(environment)");
    expect(d.reason).toBe(
      "no answer from the provider for 600s — past the 600s outage deadline; the work is not what failed",
    );
  });

  test("inside the deadline the count decides", () => {
    expect(
      ask({ attempts: 1, maxAttempts: 3, outageMs: 599_999, deadlineMs: 600_000 }).transition,
    ).toBe("working");
    expect(ask({ attempts: 3, maxAttempts: 3, outageMs: 10, deadlineMs: 600_000 }).transition).toBe(
      "abandoned(environment)",
    );
  });

  test("no deadline, or a row written before there was one: the count decides", () => {
    expect(
      ask({ attempts: 1, maxAttempts: 3, outageMs: 9_999_999, deadlineMs: 0 }).transition,
    ).toBe("working");
    expect(ask({ attempts: 1, maxAttempts: 3 }).transition).toBe("working");
    expect(ask({ attempts: 1, maxAttempts: 3, outageMs: 9_999_999 }).transition).toBe("working");
  });

  test("the row it writes carries the clock it decided from", async () => {
    const run = await runLoop({ script: STALL, deadlineMs: 200, authority: ["transport"] });
    const row = run.decisions.filter((d) => d.guard === "REPAIR_TRANSPORT").at(-1)!;
    expect(row.transition).toBe("abandoned(environment)");
    expect(row.inputs).toMatchObject({ attempts: 1, maxAttempts: 3, deadlineMs: 200 });
    expect(Number(row.inputs.outageMs)).toBeGreaterThanOrEqual(200);
  });
});

describe("the setting", () => {
  test("ten minutes unless `[reliability] providerDeadlineSecs` says otherwise; 0 turns it off", () => {
    expect(DEFAULT_RELIABILITY.providerDeadlineSecs).toBe(600);
    expect(policyForModel("claude-sonnet-5").providerDeadlineSecs).toBe(600);
    expect(policyForModel("m", { providerDeadlineSecs: 45 }).providerDeadlineSecs).toBe(45);
    expect(policyForModel("m", { providerDeadlineSecs: 0 }).providerDeadlineSecs).toBe(0);
  });
});
