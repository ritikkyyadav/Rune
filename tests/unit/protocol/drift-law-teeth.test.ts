/**
 * The drift law, asked whether it can fail — and whether its manifests
 * describe what replay actually does. Written by an independent verifier.
 *
 * Two questions the existing `tests/unit/protocol/exhaustiveness.test.ts`
 * does not answer:
 *   1. Can it fail? A test that cannot fail is not a test. The law's own
 *      logic is re-run here against a manifest carrying a member no reducer
 *      names, and must report it.
 *   2. Do the three persistence manifests describe what `replayEvents`
 *      actually does? Today they are only checked as SETS covering the union;
 *      nothing asserts that a member in `REPLAYED_FROM_ROW` comes back, or
 *      that a `run_trace` row unpacks.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  NOT_REPLAYED_EVENTS,
  REPLAYED_FROM_ROW,
  RUN_TRACE_EVENTS,
  replayEvents,
} from "../../../packages/orchestrator/src/engine";
import { AGENT_TURN_EVENT_TYPES } from "../../../packages/protocol/src/index";

const ROOT = join(import.meta.dir, "..", "..", "..");

const REDUCERS = [
  ["packages/orchestrator/src/bin/ui/turn.ts", "onEvent(event: AgentTurnEvent | ResearchEvent)"],
  ["packages/orchestrator/src/bin/ui/events.ts", "export function formatEvent("],
  ["packages/orchestrator/src/headless.ts", "for await (const event of engine.chat("],
  [
    "packages/orchestrator/src/bin/ui/tui.ts",
    "for await (const ev of engine.chat(this.ctx.sessionId, input))",
  ],
] as const;

function labelsAfter(file: string, from: string): Set<string> {
  const source = readFileSync(join(ROOT, file), "utf8");
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const labels = new Set<string>();
  for (const m of source.slice(start).matchAll(/case\s+"([a-z_]+)"\s*:/g)) labels.add(m[1]!);
  return labels;
}

describe("the drift law can fail", () => {
  test("a member no reducer names is reported missing by every reducer", () => {
    const manifest = [...AGENT_TURN_EVENT_TYPES, "quantum_flux"];
    for (const [file, from] of REDUCERS) {
      const labels = labelsAfter(file, from);
      expect(manifest.filter((t) => !labels.has(t))).toEqual(["quantum_flux"]);
    }
  });

  test("the persistence law is not vacuous either", () => {
    const covered = new Set<string>([
      ...RUN_TRACE_EVENTS,
      ...REPLAYED_FROM_ROW,
      ...NOT_REPLAYED_EVENTS.keys(),
    ]);
    expect([...AGENT_TURN_EVENT_TYPES, "quantum_flux"].filter((t) => !covered.has(t))).toEqual([
      "quantum_flux",
    ]);
    // The three sets are disjoint apart from the two the manifests share by
    // design (`notice` and `checkpoint_saved` have both a run_trace row and a
    // row of their own), so a member cannot be "covered" by contradiction.
    const both = [...RUN_TRACE_EVENTS].filter((t) => REPLAYED_FROM_ROW.has(t));
    expect(both.sort()).toEqual(["checkpoint_saved", "notice"]);
    expect(
      [...NOT_REPLAYED_EVENTS.keys()].filter((t) => covered.has(t) && RUN_TRACE_EVENTS.has(t)),
    ).toEqual([]);
  });
});

describe("the persistence manifests describe real behaviour", () => {
  test("every RUN_TRACE_EVENTS member unpacks from a run_trace row", () => {
    const sample: Record<string, Record<string, unknown>> = {
      usage: { inputTokens: 1, outputTokens: 2 },
      fallback: { from: "a", to: "b", reason: "r" },
      retry: { attempt: 1, delayMs: 10, reason: "r" },
      verification_started: {},
      verification_completed: { ran: true, passed: true, report: "ok" },
      handoff: { reason: "open_steps", summary: "s" },
      step_check: { command: "bun test", passed: true },
      replanning: { reason: "r" },
      todo_updated: { items: [] },
      checkpoint_saved: { runId: "s#1", version: 1, turnCount: 1 },
      notice: { message: "m" },
      context_warning: { message: "m", usedTokens: 1, limitTokens: 2 },
      turn_complete: { stopReason: "end_turn", totalTurns: 1 },
      lifecycle: { moment: "start", lifecycle: { id: "s" } },
    };
    const rows = [...RUN_TRACE_EVENTS].map((type, i) => ({
      seq: i + 1,
      event: { type: "run_trace", payload: { type, ...(sample[type] ?? {}) } },
    }));
    const replayed: string[] = replayEvents(rows).frames.map((f) => f.event.type);
    expect([...RUN_TRACE_EVENTS].filter((t) => !replayed.includes(t))).toEqual([]);
  });

  test("every REPLAYED_FROM_ROW member comes back from the row type that carries it", () => {
    const rows = [
      {
        seq: 1,
        event: {
          type: "assistant_msg",
          payload: {
            content: "hello",
            toolUses: [{ callId: "c1", toolName: "bash", toolInput: { command: "ls" } }],
          },
        },
      },
      { seq: 2, event: { type: "tool_result", payload: { callId: "c1", content: "ok" } } },
      { seq: 3, event: { type: "auto_compaction", payload: { beforeTokens: 9, afterTokens: 4 } } },
      { seq: 4, event: { type: "system_note", payload: { content: "note" } } },
      { seq: 5, event: { type: "error", payload: { error: "boom", recoverable: false } } },
      {
        seq: 6,
        event: { type: "checkpoint_saved", payload: { runId: "s#1", version: 2, turnCount: 3 } },
      },
      {
        seq: 7,
        event: { type: "decision_record", payload: { record: { goal: "g", steps: [] } } },
      },
    ];
    const replayed = new Set<string>(replayEvents(rows).frames.map((f) => f.event.type));
    expect([...REPLAYED_FROM_ROW].filter((t) => !replayed.has(t))).toEqual([]);
  });

  test("no NOT_REPLAYED member is reconstructed anyway, and each has a reason", () => {
    for (const [type, reason] of NOT_REPLAYED_EVENTS) {
      expect(reason.length).toBeGreaterThan(10);
      const replayed = replayEvents([
        { seq: 1, event: { type, payload: {} } },
        { seq: 2, event: { type: `${type}_row`, payload: {} } },
      ]).frames;
      expect(replayed.map((f) => f.event.type)).not.toContain(type);
    }
  });
});
