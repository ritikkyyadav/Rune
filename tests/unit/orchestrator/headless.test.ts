/**
 * Headless runs.
 *
 * The gap this closes: nothing could drive Rune without a terminal. Every CLI
 * path ended in the TUI, which is why the eval suite imports Engine and drives
 * it in-process, and why the external anchors the eval README scopes as P1 —
 * Terminal-Bench, SWE-bench — were never built. Those harnesses shell out to an
 * agent command; there was no command to shell out to.
 *
 * The contracts that matter to a machine caller: stdout carries the answer and
 * nothing else, a re-streamed turn does not duplicate it, and an exit code
 * distinguishes "the agent could not" from "the harness did not grant
 * permission" — a benchmark that conflates those scores the agent for its own
 * misconfiguration.
 */
import { describe, expect, test } from "bun:test";
import {
  headlessEnvelope,
  headlessExitCode,
  headlessPermissionHandler,
  runHeadless,
  HEADLESS_EXIT,
  type HeadlessResult,
} from "../../../packages/orchestrator/src/headless";
import type { Engine, PermissionPrompt } from "../../../packages/orchestrator/src/engine";
import type { CompletionVerdict } from "@rune/protocol";

/** An Engine stand-in that replays a fixed event stream. */
function fakeEngine(events: unknown[], throwAfter?: Error): Engine {
  return {
    setPermissionHandler() {},
    async *chat() {
      for (const e of events) yield e;
      if (throwAfter) throw throwAfter;
    },
  } as unknown as Engine;
}

const prompt: PermissionPrompt = {
  toolName: "bash",
  argsSummary: "rm -rf /",
  suggestedScope: "session",
  rawArgs: {},
} as PermissionPrompt;

describe("headless permission handling", () => {
  test("denies by default — a run with nobody watching grants nothing", async () => {
    let denied = 0;
    const h = headlessPermissionHandler(false, () => denied++);
    expect(await h(prompt)).toEqual({ kind: "deny" });
    expect(denied).toBe(1);
  });

  test("auto-approve is explicit and grants for the session", async () => {
    const h = headlessPermissionHandler(true, () => {
      throw new Error("should not be asked");
    });
    expect(await h(prompt)).toEqual({ kind: "allow_session" });
  });
});

describe("runHeadless", () => {
  test("collects the answer, the tool count, and the files touched", async () => {
    const r = await runHeadless(
      fakeEngine([
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        {
          type: "tool_call_end",
          output: { success: true, toolName: "write_file" },
          args: { path: "src/a.ts" },
        },
        { type: "tool_call_end", output: { success: false, toolName: "bash" }, args: {} },
        { type: "usage", inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 },
      ]),
      "s1",
      "hi",
    );
    expect(r.ok).toBe(true);
    expect(r.text).toBe("Hello world");
    expect(r.toolCalls).toBe(2);
    expect(r.toolErrors).toBe(1);
    expect(r.filesChanged).toEqual(["src/a.ts"]);
    expect(r.cacheReadTokens).toBe(900);
  });

  test("a re-streamed turn does not concatenate two answers", async () => {
    // A provider failover mid-turn replays the response from the top. Without
    // honouring stream_reset the caller receives the answer twice.
    const r = await runHeadless(
      fakeEngine([
        { type: "text_delta", text: "partial answer that got cut" },
        { type: "stream_reset" },
        { type: "text_delta", text: "the real answer" },
      ]),
      "s1",
      "hi",
    );
    expect(r.text).toBe("the real answer");
  });

  test("a thrown turn is reported, not swallowed, and keeps what it had", async () => {
    const r = await runHeadless(
      fakeEngine([{ type: "text_delta", text: "got this far" }], new Error("provider exploded")),
      "s1",
      "hi",
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("provider exploded");
    expect(r.text).toBe("got this far");
  });

  test("progress never reaches stdout — that channel is the answer", async () => {
    const lines: string[] = [];
    await runHeadless(
      fakeEngine([
        { type: "tool_call_start", toolName: "grep" },
        {
          type: "tool_call_end",
          callId: "c1",
          args: { pattern: "needle", path: "src" },
          output: {
            callId: "c1",
            toolName: "grep",
            success: true,
            result: JSON.stringify({ matches: [], count: 0 }),
            durationMs: 3,
          },
        },
        { type: "notice", message: "switched provider" },
        { type: "text_delta", text: "answer" },
      ]),
      "s1",
      "hi",
      { onProgress: (l) => lines.push(l) },
    );
    // An ordinary tool's start is no longer a "→ grep" line: the CLI prints
    // the finished row from the end event (this runner is engine-side and
    // draws nothing), so the runner's own progress is the notice alone.
    expect(lines).toEqual(["switched provider"]);
  });
});

describe("exit codes", () => {
  const base: HeadlessResult = {
    text: "",
    ok: true,
    toolCalls: 0,
    toolErrors: 0,
    filesChanged: [],
    permissionsDenied: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    durationMs: 0,
  };

  test("success is 0", () => {
    expect(headlessExitCode(base)).toBe(HEADLESS_EXIT.ok);
  });

  test("a plain failure is 1", () => {
    expect(headlessExitCode({ ...base, ok: false, error: "boom" })).toBe(HEADLESS_EXIT.failed);
  });

  test("blocked-on-permission gets its own code, not a capability failure", () => {
    // The distinction a benchmark needs: the fix here is a flag, not a retry,
    // and scoring it as a failed task measures the harness, not the agent.
    expect(headlessExitCode({ ...base, ok: false, permissionsDenied: 2 })).toBe(
      HEADLESS_EXIT.needsPermission,
    );
  });

  test("a COMPLETED turn that was blocked still reports blocked", () => {
    // Observed live: asked to create a file with no --auto-approve, the write
    // is refused, the model politely explains it could not, the turn ends
    // cleanly and ok is true. Nothing was created. A caller reading only the
    // exit code would have recorded a success.
    expect(headlessExitCode({ ...base, ok: true, permissionsDenied: 1 })).toBe(
      HEADLESS_EXIT.needsPermission,
    );
  });
});

describe("a verdict makes a finished run a failed one only where a promise was made about a change", () => {
  // The first version of this rule failed every `partial` and `unmet` run. A
  // plain "hello" ends `unmet` ("no criteria stated") by construction, and so
  // does a fresh install's first prompt and a pull-request review — all three
  // started exiting 1 (2026-10-06). The rule is about a promise: criteria the
  // run was held to, and a change they were about.
  const own = (text: string) => ({ text, rung: null, status: "unassessed" as const });
  const WROTE = {
    type: "tool_call_end",
    args: { path: "src/a.ts", content: "x" },
    output: { toolName: "write_file", success: true, result: "ok" },
  };
  const ended = (verdict: CompletionVerdict, ...before: unknown[]) =>
    runHeadless(
      fakeEngine([
        { type: "text_delta", text: "Implemented the change." },
        ...before,
        { type: "turn_complete", stopReason: "end_turn", totalTurns: 2, verdict },
      ]),
      "s",
      "fix the bug",
    );
  const unmet = (criteria: CompletionVerdict["criteria"]): CompletionVerdict => ({
    kind: "unmet",
    criteria,
    missing: criteria.map((c) => c.text),
  });
  const partial = (criteria: CompletionVerdict["criteria"]): CompletionVerdict => ({
    kind: "partial",
    criteria,
    gaps: [{ criterion: "tests", why: "not run" }],
  });
  const failedEverywhere = (result: Awaited<ReturnType<typeof runHeadless>>, kind: string) => {
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      `The task is ${kind}; the completion criteria were not all satisfied.`,
    );
    expect(result.text).toContain("Implemented the change.");
    expect(headlessExitCode(result)).toBe(HEADLESS_EXIT.failed);
    expect(JSON.parse(headlessEnvelope(result)).ok).toBe(false);
    // An embedder that still supplies execution-only `ok` cannot override it.
    expect(headlessExitCode({ ...result, ok: true })).toBe(HEADLESS_EXIT.failed);
    expect(JSON.parse(headlessEnvelope({ ...result, ok: true })).ok).toBe(false);
    expect(JSON.parse(headlessEnvelope({ ...result, ok: true, error: undefined })).error).toContain(
      kind,
    );
  };
  const succeeded = (result: Awaited<ReturnType<typeof runHeadless>>) => {
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(headlessExitCode(result)).toBe(HEADLESS_EXIT.ok);
    const envelope = JSON.parse(headlessEnvelope(result));
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeUndefined();
  };

  test("a change held to the run's own criteria, and not shown to meet them, is unsuccessful on every surface", async () => {
    const criteria = [own("the parser keeps the lines that follow an unterminated list")];
    failedEverywhere(await ended(unmet(criteria), WROTE), "unmet");
    failedEverywhere(await ended(partial(criteria), WROTE), "partial");
  });

  test("no criteria were stated: a greeting, a first prompt, a bare reply — judged by whether it ran", async () => {
    const said: CompletionVerdict = {
      kind: "unmet",
      criteria: [],
      missing: ["no criteria stated"],
    };
    succeeded(await ended(said));
    // Even when it wrote: nothing was promised about what it wrote.
    succeeded(await ended(said, WROTE));
    succeeded(await ended({ kind: "partial", criteria: [], gaps: [] }, WROTE));
  });

  test("only the run's own read-back and nothing changed: an answer, a review, a plan", async () => {
    // Its criteria describe an answer, there is nothing to run, and `partial`
    // is the best such a run can reach.
    const criteria = [own("every finding names a file and a line")];
    succeeded(await ended(partial(criteria)));
    succeeded(await ended(unmet(criteria)));
    // A source that is not written down is the read-back's, as it always was.
    succeeded(await ended(partial([{ text: "an older verdict's criterion", rung: null }])));
  });

  test("a criterion from outside the run is held whether or not anything changed", async () => {
    // Asked to build something, held to someone else's check, and changed nothing.
    for (const source of ["evaluator", "user"] as const) {
      const criteria = [{ ...own("the build exits 0"), source }];
      failedEverywhere(await ended(unmet(criteria)), "unmet");
      failedEverywhere(await ended(partial(criteria)), "partial");
    }
    // One outside criterion among the run's own is enough.
    const mixed = [
      own("a note is written"),
      { ...own("the build exits 0"), source: "evaluator" as const },
    ];
    failedEverywhere(await ended(partial(mixed)), "partial");
  });

  test("a failed tool call changed nothing, so it is not a change the criteria were about", async () => {
    const refused = { ...WROTE, output: { ...WROTE.output, success: false } };
    succeeded(await ended(unmet([own("the file is written")]), refused));
  });

  test.each([
    { kind: "met", criteria: [] },
    { kind: "met", criteria: [{ text: "the tests pass", rung: "verified", status: "satisfied" }] },
    { kind: "none", criteria: [], reason: "a conversational answer" },
  ] satisfies CompletionVerdict[])(
    "$kind remains successful, with a change or without",
    async (verdict) => {
      succeeded(await ended(verdict));
      succeeded(await ended(verdict, WROTE));
    },
  );

  test("a terminal failure retains its cause even with an unmet verdict", async () => {
    const result = await runHeadless(
      fakeEngine([
        { type: "error", error: "provider disconnected", recoverable: false },
        WROTE,
        {
          type: "turn_complete",
          stopReason: "provider_lost",
          totalTurns: 2,
          verdict: unmet([own("the tests pass")]),
        },
      ]),
      "s",
      "fix the bug",
    );
    expect(result.error).toBe("provider disconnected");
    expect(headlessExitCode({ ...result, permissionsDenied: 1 })).toBe(
      HEADLESS_EXIT.needsPermission,
    );
  });
});

describe("the JSON envelope", () => {
  test("carries everything a harness needs to score a run", () => {
    const env = JSON.parse(
      headlessEnvelope({
        text: "done",
        ok: true,
        toolCalls: 3,
        toolErrors: 0,
        filesChanged: ["a.ts"],
        permissionsDenied: 0,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 90,
        durationMs: 1234,
      }),
    );
    expect(env.ok).toBe(true);
    expect(env.text).toBe("done");
    expect(env.filesChanged).toEqual(["a.ts"]);
    expect(env.usage).toEqual({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 90 });
    expect(env.durationMs).toBe(1234);
  });
});

describe("a terminal error fails the run", () => {
  // Observed live at v0.3.0-dev+927205d: `rune -P "..." -p ollama-turbo` emitted
  // {"type":"error","error":"No credits on ollama-turbo...","recoverable":false}
  // and then reported {"ok":true,...,"text":""} and exited 0. The error case sat
  // in the reducer's ignored group, so every provider failure — no credits, a
  // retired model, a bad key — scored as a pass with an empty answer.
  test("a non-recoverable error sets ok:false, the reason, and exit 1", async () => {
    const r = await runHeadless(
      fakeEngine([{ type: "error", error: "No credits on ollama-turbo.", recoverable: false }]),
      "s",
      "hi",
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("No credits on ollama-turbo.");
    expect(headlessExitCode(r)).toBe(HEADLESS_EXIT.failed);
  });

  test("a RECOVERABLE error does not fail a turn the engine went on to finish", async () => {
    // The engine retries and falls back on its own; counting a recovered error
    // as a failure would fail runs that in fact produced their answer.
    const r = await runHeadless(
      fakeEngine([
        { type: "error", error: "429 from provider; retrying", recoverable: true },
        { type: "text_delta", text: "done" },
      ]),
      "s",
      "hi",
    );
    expect(r.ok).toBe(true);
    expect(r.text).toBe("done");
    expect(headlessExitCode(r)).toBe(HEADLESS_EXIT.ok);
  });

  test("the FIRST fatal error is reported — later ones are its consequences", async () => {
    const r = await runHeadless(
      fakeEngine([
        { type: "error", error: "root cause", recoverable: false },
        { type: "error", error: "downstream", recoverable: false },
      ]),
      "s",
      "hi",
    );
    expect(r.error).toBe("root cause");
  });
});

/**
 * The terminal verdict.
 *
 * `ok` is one bit and the outcomes are five. A run the user CANCELLED, one the
 * supervisor HALTED and one that ran out of turns each ended with a
 * turn_complete the reducer ignored, so all three came back ok:true, exit 0,
 * with whatever partial text they had — the same answer a finished task gives.
 * A benchmark harness scores that as a pass.
 */
describe("how the turn ended reaches the caller", () => {
  const run = (stopReason: string, text = "partial work") =>
    runHeadless(
      fakeEngine([
        { type: "text_delta", text },
        { type: "turn_complete", stopReason, totalTurns: 3 },
      ]),
      "s",
      "hi",
    );

  test("a completed turn is a success and says so", async () => {
    const r = await run("end_turn", "done");
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("end_turn");
    expect(r.error).toBeUndefined();
    expect(headlessExitCode(r)).toBe(HEADLESS_EXIT.ok);
  });

  test.each([
    ["aborted", "cancelled"],
    ["halted", "halted"],
    ["max_turns", "turn ceiling"],
    ["max_tokens", "output-token limit"],
  ])("%s is not a completed task", async (stopReason, reason) => {
    const r = await run(stopReason);
    expect(r.stopReason).toBe(stopReason);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(reason);
    expect(headlessExitCode(r)).not.toBe(HEADLESS_EXIT.ok);
    // The partial result survives: stdout still carries what the run produced.
    expect(r.text).toBe("partial work");
  });

  test("a provider failure keeps the provider's own reason, not a generic one", async () => {
    const r = await runHeadless(
      fakeEngine([
        { type: "text_delta", text: "got this far" },
        { type: "error", error: "No credits on ollama-turbo.", recoverable: false },
        { type: "turn_complete", stopReason: "provider_lost", totalTurns: 2 },
      ]),
      "s",
      "hi",
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("No credits on ollama-turbo.");
    expect(r.stopReason).toBe("provider_lost");
    expect(r.text).toBe("got this far");
  });

  test("the envelope carries the stop reason", () => {
    const env = JSON.parse(
      headlessEnvelope({
        text: "partial",
        ok: false,
        error: "cancelled",
        stopReason: "aborted",
        toolCalls: 1,
        toolErrors: 0,
        filesChanged: [],
        permissionsDenied: 0,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        durationMs: 1,
      }),
    );
    expect(env.stopReason).toBe("aborted");
    expect(env.ok).toBe(false);
  });
});
