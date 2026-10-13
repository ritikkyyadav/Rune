/**
 * A Codex stream is alive when the wire says so, and a model that is thinking
 * is not a dead socket.
 *
 * Recorded 2026-10-12, gpt-6.1-sol at `max`: a session was cut again and again
 * with "stream stalled — no data for 120s", each cut restarting the request
 * and throwing its thinking away. Two things were wrong, and both are pinned
 * here:
 *
 *  - The watchdog beat once per TRANSLATED event. Most of what the backend
 *    sends while a model thinks (`response.in_progress`, a reasoning item
 *    opening, a summary part, an empty delta) translates into nothing, so a
 *    stream could be talking and still be called silent.
 *  - Its generous first allowance ended at `response.created`, which is the
 *    backend's acknowledgement and arrives before any thinking. The thinking
 *    ran on the between-chunk allowance.
 *
 * The figures themselves belong to `codexSilenceAllowanceMs`; nothing here
 * names one, so the tests hold whatever it is set to. The one duration that
 * is written out, 150s, is the failure as it was recorded.
 *
 * Fake fetch throughout; the allowances run on fake timers.
 */
import { describe, test, expect, afterEach, jest } from "bun:test";
import {
  CodexProvider,
  codexSilenceAllowanceMs,
  parseResponsesStream,
  type CodexStreamPhase,
} from "../../../packages/llm-gateway/src/providers/codex";
import { ApiError } from "../../../packages/llm-gateway/src/types";
import type {
  InferenceRequest,
  ReasoningEffort,
  StreamEvent,
} from "../../../packages/llm-gateway/src/types";
import { DEFAULT_PROVIDER_DEADLINE_MS } from "../../../packages/orchestrator/src/agent-loop";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

const CREATED = { type: "response.created", response: { id: "r" } };
const COMPLETED = {
  type: "response.completed",
  response: { usage: { input_tokens: 1, output_tokens: 1 } },
};

const request = (over: Partial<InferenceRequest> = {}): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gpt-6.1-sol",
  provider: "codex",
  maxTokens: 100,
  stream: true,
  role: "primary",
  ...over,
});

/**
 * A 200 whose body the test feeds one wire event at a time, and which dies
 * with its signal as a real one does.
 */
function liveStream(): { push: (event: object) => void } {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let aborted = false;
  const push = (event: object) => {
    queue.push(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    wake?.();
  };
  globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      wake?.();
    });
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          async read() {
            for (;;) {
              if (aborted) throw new DOMException("The operation was aborted.", "AbortError");
              const value = queue.shift();
              if (value) return { value, done: false };
              await new Promise<void>((resolve) => (wake = resolve));
            }
          },
        }),
      },
    };
  }) as unknown as typeof fetch;
  return { push };
}

/** The stream's events, or the error that ended it. */
function run(req: InferenceRequest): Promise<{ events: StreamEvent[]; err?: ApiError }> {
  const events: StreamEvent[] = [];
  return (async () => {
    try {
      for await (const e of new CodexProvider("tok").inferStream(req)) events.push(e);
      return { events };
    } catch (err) {
      return { events, err: err as ApiError };
    }
  })();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

/**
 * How the run ended. If it has not ended, this throws instead of waiting:
 * under fake timers nothing times a test out, so awaiting a stream that was
 * wrongly left alive would hang the suite where it should fail it.
 */
async function ended(
  outcome: ReturnType<typeof run>,
): Promise<{ events: StreamEvent[]; err?: ApiError }> {
  await settle();
  const end = await Promise.race([outcome, Promise.resolve("running" as const)]);
  if (end === "running") throw new Error("the stream is still open");
  return end;
}

// ─── What the parser tells the watchdog ───

/** A structural byte stream carrying these SSE events, then EOF. */
function sse(events: object[]) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  let done = false;
  return {
    getReader() {
      return {
        async read() {
          if (done) return { value: undefined, done: true };
          done = true;
          return { value: new TextEncoder().encode(text), done: false };
        },
      };
    },
  };
}

describe("what the parser reports about the wire", () => {
  const WIRE: Array<[object, CodexStreamPhase]> = [
    [CREATED, "thinking"],
    [{ type: "response.in_progress", response: { id: "r" } }, "thinking"],
    [{ type: "response.output_item.added", item: { id: "rs", type: "reasoning" } }, "thinking"],
    [{ type: "response.reasoning_summary_part.added", item_id: "rs" }, "thinking"],
    [{ type: "response.reasoning_summary_text.delta", item_id: "rs", delta: "" }, "thinking"],
    [{ type: "response.output_item.done", item: { id: "rs", type: "reasoning" } }, "thinking"],
    [{ type: "response.output_item.added", item: { id: "m", type: "message" } }, "writing"],
    [{ type: "response.output_text.delta", delta: "On it." }, "writing"],
    // An event added to the backend after this was written changes nothing.
    [{ type: "response.something_new", item_id: "m" }, "writing"],
    [{ type: "response.output_item.done", item: { id: "m", type: "message" } }, "thinking"],
    [
      {
        type: "response.output_item.added",
        item: { id: "fc", type: "function_call", call_id: "c", name: "write_file" },
      },
      "writing",
    ],
    [{ type: "response.function_call_arguments.delta", item_id: "fc", delta: "{" }, "writing"],
  ];

  test("every event that arrives is heard, with what the stream is doing after it", async () => {
    const heard: CodexStreamPhase[] = [];
    for await (const _ of parseResponsesStream(sse(WIRE.map(([ev]) => ev)), (p) => heard.push(p))) {
      // drain
    }
    expect(heard).toEqual(WIRE.map(([, phase]) => phase));
  });

  test("most of a thinking model's events translate into nothing", async () => {
    // The five events before the reasoning item closes, which is to say while
    // the thinking is going on: only the acknowledgement becomes a
    // StreamEvent. A watchdog fed by the translation hears one beat where the
    // wire carried five.
    const thinking = WIRE.slice(0, 5).map(([ev]) => ev);
    let heard = 0;
    const translated: StreamEvent[] = [];
    for await (const e of parseResponsesStream(sse(thinking), () => heard++)) {
      if (e.type !== "message_stop") translated.push(e);
    }
    expect(heard).toBe(5);
    expect(translated.map((e) => e.type)).toEqual(["message_start"]);
  });

  test("anything at all on the wire means the request is no longer queued", async () => {
    const heard: CodexStreamPhase[] = [];
    for await (const _ of parseResponsesStream(sse([{ type: "response.something_new" }]), (p) =>
      heard.push(p),
    )) {
      // drain
    }
    expect(heard).toEqual(["thinking"]);
  });
});

// ─── The watchdog, fed by the wire ───

describe("a stream that is thinking", () => {
  test("is kept alive by events the parser makes nothing of", async () => {
    jest.useFakeTimers();
    const wire = liveStream();
    const outcome = run(request());
    await settle();
    wire.push(CREATED);
    await settle();

    // Twice over, nearly the whole allowance passes and then the backend says
    // something that is not a token. Measured from the acknowledgement — the
    // last event the parser translated — the silence is far past the allowance.
    const quiet = codexSilenceAllowanceMs("thinking", "high");
    jest.advanceTimersByTime(quiet - 1_000);
    wire.push({ type: "response.in_progress", response: { id: "r" } });
    await settle();
    jest.advanceTimersByTime(quiet - 1_000);
    wire.push({ type: "response.reasoning_summary_part.added", item_id: "rs" });
    await settle();
    jest.advanceTimersByTime(quiet - 1_000);

    wire.push(COMPLETED);
    const { events, err } = await ended(outcome);
    expect(err).toBeUndefined();
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  test("is still cut when the wire itself goes quiet for the whole allowance", async () => {
    jest.useFakeTimers();
    const wire = liveStream();
    const outcome = run(request());
    await settle();
    wire.push(CREATED);
    await settle();

    const quiet = codexSilenceAllowanceMs("thinking", "high");
    jest.advanceTimersByTime(quiet + 1);
    const { err } = await ended(outcome);
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.status).toBe(504); // >= 500: the gateway retries or falls back
    expect(err?.message).toBe(`stream stalled — no data for ${Math.round(quiet / 1000)}s`);
  });

  // What happened on 2026-10-12, as a test: the acknowledgement, then nothing
  // for longer than the 120s that stood, from a model that was still working.
  test("at max, 150s of silence after the acknowledgement is not a dead stream", async () => {
    jest.useFakeTimers();
    const wire = liveStream();
    const outcome = run(request({ thinking: { enabled: true, effort: "max" } }));
    await settle();
    wire.push(CREATED);
    await settle();

    jest.advanceTimersByTime(150_000);
    wire.push(COMPLETED);
    const { events, err } = await ended(outcome);
    expect(err).toBeUndefined();
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  test("a request that was not asked to think is not given a thinker's patience", async () => {
    // Thinking off (the fast classifier, utility calls): the effort that goes
    // out is "none", and the allowance asked for must be that one's.
    jest.useFakeTimers();
    const wire = liveStream();
    const outcome = run(request({ thinking: { enabled: false } }));
    await settle();
    wire.push(CREATED);
    await settle();

    const quiet = codexSilenceAllowanceMs("thinking", "none");
    expect(quiet).toBeLessThan(codexSilenceAllowanceMs("thinking", "max"));
    jest.advanceTimersByTime(quiet + 1);
    const { err } = await ended(outcome);
    expect(err?.status).toBe(504);
    expect(err?.message).toBe(`stream stalled — no data for ${Math.round(quiet / 1000)}s`);
  });
});

describe("a stream that was writing", () => {
  test("is cut on the writing allowance when the words stop", async () => {
    jest.useFakeTimers();
    const wire = liveStream();
    const outcome = run(request());
    await settle();
    wire.push(CREATED);
    wire.push({ type: "response.output_item.added", item: { id: "m", type: "message" } });
    wire.push({ type: "response.output_text.delta", delta: "Writing the rep" });
    await settle();

    const quiet = codexSilenceAllowanceMs("writing", "high");
    jest.advanceTimersByTime(quiet + 1);
    const { events, err } = await ended(outcome);
    expect(events.some((e) => e.type === "content_delta")).toBe(true);
    expect(err?.status).toBe(504);
    expect(err?.message).toBe(`stream stalled — no data for ${Math.round(quiet / 1000)}s`);
  });
});

// ─── The figures, whatever they are ───

describe("the silence allowance", () => {
  const PHASES: CodexStreamPhase[] = ["queued", "thinking", "writing"];
  const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

  test("never allows thinking less than writing", () => {
    for (const effort of EFFORTS) {
      expect(codexSilenceAllowanceMs("thinking", effort)).toBeGreaterThanOrEqual(
        codexSilenceAllowanceMs("writing", effort),
      );
    }
  });

  test("never allows a deeper effort less", () => {
    for (const phase of PHASES) {
      const along = EFFORTS.map((effort) => codexSilenceAllowanceMs(phase, effort));
      expect(along).toEqual([...along].sort((a, b) => a - b));
    }
  });

  test("always ends, and inside the deadline an unanswered request is held to", () => {
    // One silence longer than the whole outage deadline would outlast the
    // clock that is supposed to end the run.
    for (const phase of PHASES) {
      for (const effort of EFFORTS) {
        const ms = codexSilenceAllowanceMs(phase, effort);
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(DEFAULT_PROVIDER_DEADLINE_MS);
      }
    }
  });
});
