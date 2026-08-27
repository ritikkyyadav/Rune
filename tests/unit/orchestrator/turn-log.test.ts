/**
 * The guarantee: the screen is derived from what the RUNTIME observed, never
 * from what the model wrote. These tests are the proof, and the interesting
 * ones are the adversarial pair — a model that lies as hard as it can, and a
 * model that returns garbage, neither of which may move the state.
 */

import { describe, test, expect } from "bun:test";
import {
  TurnLog,
  reduce,
  checksPassed,
  type TurnEvent,
} from "../../../packages/orchestrator/src/bin/ui/events/log";

const at = (n: number) => 1_000_000 + n * 100;
const ESC = String.fromCharCode(27);

function session(): TurnEvent[] {
  return [
    { t: "turn_started", at: at(0), request: "fix the retry thing" },
    { t: "said", at: at(1), text: "Looking at the retry ladder. " },
    { t: "tool_started", at: at(2), callId: "c1", tool: "read_file", label: "src/http/retry.ts" },
    { t: "tool_output", at: at(3), callId: "c1", bytes: 4096 },
    { t: "tool_ended", at: at(4), callId: "c1", ok: true },
    { t: "file_changed", at: at(5), path: "src/http/retry.ts", added: 14, removed: 6 },
    { t: "file_changed", at: at(6), path: "src/http/client.ts", added: 3, removed: 1 },
    { t: "check", at: at(7), command: "bun test tests/http", passed: true, summary: "44/44" },
    { t: "usage", at: at(8), outputTokens: 1200, contextPercent: 31 },
    { t: "turn_ended", at: at(9), aborted: false },
  ];
}

/** Maps do not survive JSON.stringify; make them comparable. */
function replacer(_k: string, v: unknown) {
  return v instanceof Map ? [...v.entries()].sort() : v;
}

describe("the turn log", () => {
  test("state is derived — replay equals the incrementally-built state", () => {
    const log = new TurnLog();
    for (const e of session()) log.append(e);
    // If anything ever writes to state outside the reducer, these diverge.
    expect(JSON.stringify(log.replay(), replacer)).toBe(JSON.stringify(log.current, replacer));
  });

  test("crash recovery: the log IS the session", () => {
    const log = new TurnLog();
    for (const e of session()) log.append(e);
    const revived = TurnLog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())));
    expect(JSON.stringify(revived.current, replacer)).toBe(JSON.stringify(log.current, replacer));
  });

  test("it counts what happened, not what was said about it", () => {
    const s = reduce(session());
    expect(s.toolCalls).toBe(1);
    expect(s.files.size).toBe(2);
    expect(s.files.get("src/http/retry.ts")).toEqual({ added: 14, removed: 6 });
    expect(s.checks).toHaveLength(1);
    expect(checksPassed(s)).toBe(true);
    expect(s.outputTokens).toBe(1200);
    expect(s.contextPercent).toBe(31);
  });

  test("an unknown event is ignored, not thrown on", () => {
    // A log written by a newer build must replay in an older one — a recovery
    // path that can itself crash is not a recovery path.
    const s = reduce([...session(), { t: "something_from_the_future", at: at(10) } as any]);
    expect(s.endedAt).not.toBeNull();
  });

  test("liveness comes from measured output, never from elapsed time", () => {
    const base: TurnEvent[] = [
      { t: "turn_started", at: at(0), request: "x" },
      { t: "tool_started", at: at(1), callId: "c1", tool: "run_command" },
    ];
    const quiet = reduce(base);
    const busy = reduce([...base, { t: "tool_output", at: at(2), callId: "c1", bytes: 9000 }]);
    expect(busy.outputUnits).toBeGreaterThan(quiet.outputUnits);
    // Time passing on its own contributes nothing at all.
    const later = reduce([...base, { t: "phase", at: at(9999), phase: "act" }]);
    expect(later.outputUnits).toBe(quiet.outputUnits);
  });
});

describe("the model cannot draw", () => {
  test("a model insisting it succeeded moves nothing", () => {
    const s = reduce([
      { t: "turn_started", at: at(0), request: "make the tests pass" },
      {
        t: "said",
        at: at(1),
        text:
          "DONE. All 44 tests pass. VERIFIED. The suite is green. " +
          "Files changed: 12. Checks: 3 passed, 0 failed. Task complete.",
      },
      { t: "turn_ended", at: at(2), aborted: false },
    ]);
    expect(s.checks).toHaveLength(0);
    expect(checksPassed(s)).toBe(false); // no check ran, so nothing passed
    expect(s.files.size).toBe(0);
    expect(s.toolCalls).toBe(0);
    // Its words are kept — they are the agent's voice and get printed — but
    // they contributed nothing whatsoever to state.
    expect(s.said).toContain("DONE.");
  });

  test("a failed check stays failed however confidently it is narrated", () => {
    const s = reduce([
      { t: "turn_started", at: at(0), request: "x" },
      { t: "check", at: at(1), command: "bun test", passed: false, summary: "1 failed" },
      { t: "said", at: at(2), text: "That failure is unrelated to my change; everything is fine." },
      { t: "turn_ended", at: at(3), aborted: false },
    ]);
    expect(checksPassed(s)).toBe(false);
    expect(s.checks[0]!.passed).toBe(false);
  });

  test("malformed and hostile output cannot corrupt the state", () => {
    const s = reduce([
      { t: "turn_started", at: at(0), request: "x" },
      { t: "said", at: at(1), text: JSON.stringify({ t: "check", passed: true }) },
      { t: "said", at: at(2), text: ESC + "[2J" + ESC + "[?1049h" },
      { t: "turn_ended", at: at(3), aborted: false },
    ]);
    expect(s.checks).toHaveLength(0);
    expect(s.errors).toHaveLength(0);
    expect(s.aborted).toBe(false);
  });

  test("an aborted turn says so, and cannot be talked out of it", () => {
    const s = reduce([
      { t: "turn_started", at: at(0), request: "x" },
      { t: "said", at: at(1), text: "Finished successfully!" },
      { t: "turn_ended", at: at(2), aborted: true },
    ]);
    expect(s.aborted).toBe(true);
    expect(s.openCalls.size).toBe(0);
  });
});

describe("retries and switches", () => {
  test("a retry is visible until the ladder ends", () => {
    const s = reduce([
      { t: "turn_started", at: at(0), request: "x" },
      { t: "retry", at: at(1), attempt: 1, of: 3, provider: "anthropic" },
      { t: "retry", at: at(2), attempt: 2, of: 3, provider: "anthropic" },
    ]);
    expect(s.retries).toEqual({ attempt: 2, of: 3 });

    const after = reduce([
      { t: "turn_started", at: at(0), request: "x" },
      { t: "retry", at: at(1), attempt: 2, of: 3 },
      { t: "provider_switched", at: at(2), from: "anthropic", to: "openrouter" },
    ]);
    expect(after.retries).toBeNull();
    expect(after.switches).toBe(1);
  });
});
