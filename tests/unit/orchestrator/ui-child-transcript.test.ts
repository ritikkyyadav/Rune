/**
 * A sub-agent's transcript: what is in it, and what order it is in.
 *
 * Before this module a child's pane held its prose, its thinking, and -- for
 * every tool it ran -- one row carrying the tool's verb and nothing else. No
 * path, no command, no result, no failure. Nothing tested the pane's content at
 * all, which is how it shipped that way: the buffer had no reader in the suite.
 *
 * These tests feed the writer the events a child's own loop emits and read the
 * rows back. The claims that matter:
 *
 *   - a call's row lands when it OPENS, names its target as the arguments
 *     arrive, and becomes its result IN PLACE -- including when the child ran
 *     two calls at once and the first to open is not the last row;
 *   - a paragraph is one block however many deltas it arrived in;
 *   - a transcript read back from the record matches one that was watched;
 *   - what the transcript does not hold, it says.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AgentTurnEvent } from "../../../packages/protocol/src/index";
import {
  CHILD_LOG_ROWS,
  ChildLog,
  ChildTranscript,
  fillFromRecord,
} from "../../../packages/orchestrator/src/bin/ui/child-transcript";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../../packages/orchestrator/src/bin/ui/render";
import { FleetLedger, renderCard } from "../../../packages/orchestrator/src/bin/ui/agents-panel";
import type { DelegationEntry } from "../../../packages/orchestrator/src/delegation-replay";

beforeEach(() => setTermWidthOverride(100));
afterEach(() => setTermWidthOverride(null));

const plain = (log: ChildLog): string[] => log.lines.map((row) => stripAnsi(row).trimEnd());
const ev = (event: Record<string, unknown>): AgentTurnEvent => event as unknown as AgentTurnEvent;

const start = (callId: string, toolName: string) =>
  ev({ type: "tool_call_start", callId, toolName });
const args = (callId: string, partialJson: string) =>
  ev({ type: "tool_call_args_delta", callId, partialJson });
const end = (
  callId: string,
  toolName: string,
  a: Record<string, unknown>,
  result: unknown,
  success = true,
) =>
  ev({
    type: "tool_call_end",
    callId,
    args: a,
    output: {
      callId,
      toolName,
      success,
      result: typeof result === "string" ? result : JSON.stringify(result),
      ...(success ? {} : { error: String(result) }),
      durationMs: 40,
    },
  });

describe("a call, from the moment it opens", () => {
  test("lands as a running row, names its target, then becomes its result in place", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(start("t1", "read_file"));
    // It is on screen before a single argument has arrived.
    expect(plain(log)).toHaveLength(1);
    expect(plain(log)[0]).toContain("read");
    expect(plain(log)[0]).toContain("›");

    // The path, the moment the arguments have finished saying it -- not one
    // amendment per token.
    const before = log.revision;
    t.absorb(args("t1", '{"pa'));
    t.absorb(args("t1", 'th":"src/au'));
    expect(log.revision).toBe(before);
    t.absorb(args("t1", 'th.ts"'));
    expect(plain(log)).toHaveLength(1);
    expect(plain(log)[0]).toContain("src/auth.ts");

    t.absorb(
      end(
        "t1",
        "read_file",
        { path: "src/auth.ts" },
        { path: "src/auth.ts", total_lines: 2, content: "   1\texport const token = 1;" },
      ),
    );
    const rows = plain(log).join("\n");
    // The same box the lead's transcript draws for a read: path and content.
    expect(rows).toContain("src/auth.ts");
    expect(rows).toContain("export const token = 1;");
    // One block: the running row is gone, not left above its result.
    expect(plain(log).filter((row) => row.includes("› read"))).toHaveLength(0);
  });

  test("two calls at once keep the order they opened in", () => {
    // A child runs calls in parallel, and every `tool_call_end` of a batch
    // arrives after the last one resolves. So when the first result lands, the
    // row it replaces is NOT the last row -- which is what "replace the tail"
    // gets wrong.
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(start("a", "grep"));
    t.absorb(start("b", "list_dir"));
    t.absorb(end("a", "grep", { pattern: "ALPHA" }, { total_matches: 0, matches: [] }));
    t.absorb(end("b", "list_dir", { path: "BETA" }, { path: "BETA", total_count: 4 }));
    const rows = plain(log);
    const alpha = rows.findIndex((row) => row.includes("ALPHA"));
    const beta = rows.findIndex((row) => row.includes("BETA"));
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(beta).toBeGreaterThan(alpha);
    expect(rows.join("\n")).not.toContain("›");
  });

  test("a call that failed says so, with what it was about", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(start("t1", "bash"));
    t.absorb(end("t1", "bash", { command: "bun test auth" }, "exit 1: 2 failed", false));
    const rows = plain(log).join("\n");
    expect(rows).toContain("bun test auth");
    expect(rows).toContain("✗");
  });

  test("a call left open when the child stopped loses the running mark", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(start("t1", "bash"));
    t.absorb(args("t1", '{"command":"bun test slow"}'));
    t.absorb(ev({ type: "turn_complete", stopReason: "aborted", totalTurns: 2 }));
    const rows = plain(log);
    const row = rows.find((r) => r.includes("bun test slow"))!;
    // Not the active mark: a finished agent's last row must not read as work
    // still in progress.
    expect(row).not.toContain("›");
    expect(row).toContain("no result");
    // And the transcript says how it stopped.
    expect(rows.join("\n")).toContain("interrupted");
  });

  test("a clean finish adds no closing row", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(ev({ type: "text_delta", text: "All done." }));
    t.absorb(ev({ type: "turn_complete", stopReason: "end_turn", totalTurns: 1 }));
    expect(plain(log).join("\n")).not.toContain("stopped");
  });
});

describe("prose", () => {
  test("a paragraph is one block however many deltas it came in", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    for (const piece of ["Found ", "the ", "table ", "in ", "one ", "file."]) {
      t.absorb(ev({ type: "text_delta", text: piece }));
    }
    // One row of prose, under the one blank row a transcript that opens on a
    // body gets -- so the pane's header rule never touches it.
    expect(plain(log)).toHaveLength(2);
    expect(plain(log)[0]).toBe("");
    expect(plain(log)[1]).toContain("Found the table in one file.");
    expect(plain(log)[1]!.startsWith(`${F.MARK}◇`)).toBe(true);
  });

  test("a transcript that opens on a call is not pushed down a row", () => {
    const log = new ChildLog();
    new ChildTranscript(log).absorb(start("t1", "grep"));
    // The blank row is air around a BODY. A one-row call has none to need.
    expect(plain(log)).toHaveLength(1);
    expect(plain(log)[0]).not.toBe("");
  });

  test("thinking and prose are separate blocks, and thinking is marked as such", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(ev({ type: "thinking_delta", text: "Probably one table." }));
    t.absorb(ev({ type: "text_delta", text: "It is one table." }));
    const rows = plain(log).filter((row) => row !== "");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.startsWith(`${F.MARK}~`)).toBe(true);
    expect(rows[1]!.startsWith(`${F.MARK}◇`)).toBe(true);
  });

  test("a settled paragraph is rendered as Markdown, not left as markup", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(ev({ type: "text_delta", text: "The loader is `loadConfig`." }));
    // While it streams the backticks are still on screen: a half-typed fence
    // has no closed form to render.
    expect(plain(log).join("\n")).toContain("`loadConfig`");
    t.absorb(start("t1", "grep"));
    expect(plain(log).join("\n")).toContain("loadConfig");
    expect(plain(log).join("\n")).not.toContain("`loadConfig`");
  });

  test("a stream reset takes back what the abandoned message wrote", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(ev({ type: "text_delta", text: "Kept paragraph." }));
    t.absorb(start("k", "grep"));
    t.absorb(end("k", "grep", { pattern: "KEEP" }, { total_matches: 0, matches: [] }));
    t.absorb(ev({ type: "text_delta", text: "Half a senten" }));
    t.absorb(start("x", "bash"));
    t.absorb(ev({ type: "stream_reset" }));
    const rows = plain(log).join("\n");
    expect(rows).toContain("Kept paragraph.");
    expect(rows).toContain("KEEP");
    // The open paragraph and the call that never ran are gone: they are about
    // to arrive again.
    expect(rows).not.toContain("Half a senten");
    expect(rows).not.toContain("run");

    // The re-streamed message then lands once, not twice.
    t.absorb(ev({ type: "text_delta", text: "Half a sentence, whole this time." }));
    t.absorb(start("x2", "bash"));
    const again = plain(log).join("\n");
    expect(again.match(/Half a senten/g)).toHaveLength(1);
  });

  test("a reset does not reach back past a message that finished", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(ev({ type: "text_delta", text: "First message." }));
    // Usage is the provider's account of a request that is over.
    t.absorb(ev({ type: "usage", inputTokens: 1, outputTokens: 1 }));
    t.absorb(ev({ type: "text_delta", text: "Second, abandon" }));
    t.absorb(ev({ type: "stream_reset" }));
    const rows = plain(log).join("\n");
    expect(rows).toContain("First message.");
    expect(rows).not.toContain("abandon");
  });
});

describe("the brief", () => {
  test("stands first, once, whenever it is learned", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(ev({ type: "text_delta", text: "Working." }));
    // Learned late: a provider that delivers a call's input whole streams no
    // arguments, so the brief is only readable when the call lands.
    t.asked("Map the settings surface.");
    t.asked("Map the settings surface.");
    const rows = plain(log).filter((row) => row !== "");
    expect(rows[0]).toContain("Map the settings surface.");
    expect(rows.filter((row) => row.includes("Map the settings surface."))).toHaveLength(1);
  });

  test("a long brief folds and says how much it folded", () => {
    const log = new ChildLog();
    new ChildTranscript(log).asked(Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n"));
    const rows = plain(log);
    expect(rows.length).toBeLessThan(14);
    expect(rows.at(-1)).toMatch(/30 more lines of the brief/);
  });
});

describe("the log", () => {
  test("hands a pane the same array for its whole life", () => {
    const log = new ChildLog();
    const held = log.lines;
    log.push(["a"]);
    log.set("k", ["b", "c"]);
    log.set("k", ["d"]);
    log.prepend(["first"]);
    // By reference: a pane opened mid-run keeps filling.
    expect(log.lines).toBe(held);
    expect(held).toEqual(["first", "a", "d"]);
  });

  test("air between bodies, none between one-row calls -- and it follows a replacement", () => {
    const log = new ChildLog();
    log.push(["call one"]);
    log.push(["call two"], { key: "two" });
    log.push(["call three"]);
    // A run of calls reads as a list.
    expect(log.lines).toEqual(["call one", "call two", "call three"]);
    // The middle one becomes a box: it gets air on BOTH sides, including
    // before a row that was set down when it was still one line.
    log.set("two", ["┌ box", "└ box"]);
    expect(log.lines).toEqual(["call one", "", "┌ box", "└ box", "", "call three"]);
    // And loses it again if it goes back.
    log.set("two", ["call two"]);
    expect(log.lines).toEqual(["call one", "call two", "call three"]);
  });

  test("past the ceiling the oldest rows leave, and the first row says how many", () => {
    const log = new ChildLog();
    for (let i = 0; i < CHILD_LOG_ROWS + 500; i++) log.push([`row ${i}`]);
    expect(log.lines.length).toBeLessThanOrEqual(CHILD_LOG_ROWS);
    expect(log.trimmed).toBeGreaterThan(0);
    // The newest row is always kept.
    expect(log.lines.at(-1)).toBe(`row ${CHILD_LOG_ROWS + 499}`);
    // A transcript whose first row is silently the middle of the run is the
    // same lie as a diff that stops without saying it stopped.
    const note = stripAnsi(log.lines.find((row) => row.trim() !== "")!);
    expect(note).toMatch(/\d+ earlier rows not kept in this view/);
    const said = Number(/(\d+) earlier/.exec(note)![1]);
    expect(said).toBe(log.trimmed);
    // Every row that existed is either still here or counted.
    const kept = log.lines.filter((row) => row.startsWith("row ")).length;
    expect(kept + log.trimmed).toBe(CHILD_LOG_ROWS + 500);
  });

  test("every change moves the revision a painter watches", () => {
    const log = new ChildLog();
    const seen = new Set<number>([log.revision]);
    log.push(["a"]);
    seen.add(log.revision);
    log.set("k", ["b"]);
    seen.add(log.revision);
    log.set("k", ["c"]);
    seen.add(log.revision);
    log.drop("k");
    seen.add(log.revision);
    expect(seen.size).toBe(5);
  });
});

describe("the rows this module authors stand on the one ladder", () => {
  test("no far-margin padding, and only the three indents", () => {
    const log = new ChildLog();
    const t = new ChildTranscript(log);
    t.absorb(start("t1", "bash"));
    t.absorb(args("t1", '{"command":"bun test"}'));
    t.absorb(ev({ type: "retry", provider: "p", model: "m", attempt: 1, of: 3, waitMs: 10 }));
    t.absorb(ev({ type: "step_check", step: "typecheck", ran: true, passed: false, report: "" }));
    t.absorb(
      ev({ type: "verification_completed", attempt: 1, ran: true, passed: true, report: "" }),
    );
    t.absorb(ev({ type: "turn_complete", stopReason: "max_turns", totalTurns: 16 }));
    const rows = plain(log).filter((row) => row !== "");
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      // A long run of spaces inside a row is padding to a far margin.
      expect(/\S {4,}\S/.test(row.slice(8)), row).toBe(false);
      const indent = row.match(/^ */)![0].length;
      expect([F.MARK.length, F.BODY.length, F.RAIL_IN.length], row).toContain(indent);
    }
    expect(rows.join("\n")).toContain("out of turns");
  });
});

// ─── From the record ───

describe("a finished child, read back", () => {
  const entries: DelegationEntry[] = [
    { kind: "prompt", text: "Map the settings surface." },
    { kind: "note", text: "[Budget: turn 1 of 16]" },
    { kind: "thinking", text: "Probably one table." },
    { kind: "text", text: "Starting from `config-settings.ts`." },
    {
      kind: "tool",
      toolName: "read_file",
      args: { path: "src/config-settings.ts" },
      result: JSON.stringify({
        path: "src/config-settings.ts",
        total_lines: 2,
        content: "   1\texport const A = 1;",
      }),
      isError: false,
    },
    {
      kind: "tool",
      toolName: "bash",
      args: { command: "bun test" },
      result: "boom",
      isError: true,
    },
    {
      kind: "tool",
      toolName: "grep",
      args: { pattern: "NEVER_ANSWERED" },
      result: "",
      isError: false,
      unanswered: true,
    },
    { kind: "text", text: "The table is one array." },
  ];

  test("draws the same rows a watched transcript holds", () => {
    const stored = new ChildLog();
    fillFromRecord(stored, entries);
    const live = new ChildLog();
    const t = new ChildTranscript(live);
    t.asked("Map the settings surface.");
    t.absorb(ev({ type: "thinking_delta", text: "Probably one table." }));
    t.absorb(ev({ type: "text_delta", text: "Starting from `config-settings.ts`." }));
    t.absorb(start("t1", "read_file"));
    t.absorb(
      end(
        "t1",
        "read_file",
        { path: "src/config-settings.ts" },
        {
          path: "src/config-settings.ts",
          total_lines: 2,
          content: "   1\texport const A = 1;",
        },
      ),
    );
    // The box a read draws is the same box from either producer. (Durations
    // are not in the record, so the receipt's clock is the one difference.)
    const box = (log: ChildLog) => plain(log).filter((row) => /^ {2}[┌│]/.test(row));
    expect(box(stored).slice(0, 2)).toEqual(box(live).slice(0, 2));
    const rows = plain(stored).join("\n");
    expect(rows).toContain("Map the settings surface.");
    expect(rows).toContain("Probably one table.");
    expect(rows).toContain("export const A = 1;");
    expect(rows).toContain("The table is one array.");
  });

  test("says what the record does not hold", () => {
    const log = new ChildLog();
    fillFromRecord(log, entries);
    const rows = plain(log);
    // A call with no answer on record is kept and marked, never dropped.
    const orphan = rows.find((row) => row.includes("NEVER_ANSWERED"))!;
    expect(orphan).toContain("no result recorded");
    // A failed call reads as failed.
    expect(rows.find((row) => row.includes("bun test"))).toContain("✗");
    // The harness's own line is in the record, quietly, and not on the band.
    expect(rows.join("\n")).toContain("[Budget: turn 1 of 16]");
  });

  test("replaces what a log held rather than appending to it", () => {
    const log = new ChildLog();
    log.push(["stale"]);
    fillFromRecord(log, entries);
    expect(plain(log).join("\n")).not.toContain("stale");
  });
});

describe("restoring a session's agents", () => {
  test("each stored child comes back as a finished card under the name it ran as", () => {
    const ledger = new FleetLedger();
    const restored = ledger.restore([
      {
        id: "task_a",
        kind: "task",
        callId: "c1",
        name: "planner",
        label: "map the settings surface",
        status: "end_turn",
        at: "2026-10-02T10:00:30.000Z",
        startedAt: "2026-10-02T10:00:00.000Z",
      },
      {
        id: "task_b",
        kind: "worker",
        callId: "c2",
        // No name on a row from an older build: derived, not `agent-2`.
        promptHead: "Build the settings page for the dashboard",
        status: "max_turns",
        at: "2026-10-02T10:02:00.000Z",
        elapsedMs: 60_000,
      },
      // No terminal status at all: its process ended mid-run.
      { id: "task_c", kind: "task", name: "verifier", at: "2026-10-02T10:03:00.000Z" },
    ]);
    expect(restored).toBe(3);
    const view = ledger.view(false);
    // Nothing is running in a log that is being read back.
    expect(view.running).toHaveLength(0);
    // `build-settings` would not fit the name column, and a name clipped
    // mid-word reads as damage: the verb is dropped before the subject is.
    expect(view.finished.map((c) => c.name)).toEqual(["planner", "settings", "verifier"]);

    const [planner, builder, verifier] = view.finished as [any, any, any];
    expect(planner.id).toBe("c1");
    expect(planner.taskId).toBe("task_a");
    expect(planner.state).toBe("done");
    expect(planner.endedAt - planner.startedAt).toBe(30_000);
    // It returned what it had, so it is done -- and the card says how it stopped.
    expect(builder.state).toBe("done");
    expect(builder.receipt.text).toBe("stopped: max turns");
    expect(builder.endedAt - builder.startedAt).toBe(60_000);
    // It never returned.
    expect(verifier.state).toBe("failed");
    expect(verifier.receipt.text).toBe("ended mid-run");
    // With no call id on record the durable id is the card's key.
    expect(verifier.id).toBe("task_c");
  });

  test("restoring twice does not duplicate, and a live card is not overwritten", () => {
    const ledger = new FleetLedger();
    const live = ledger.register({ id: "c1", kind: "task", brief: "live", written: "planner" });
    live.state = "running";
    const stored = [
      {
        id: "task_a",
        kind: "task" as const,
        callId: "c1",
        name: "planner",
        at: "2026-10-02T10:00:00Z",
      },
    ];
    expect(ledger.restore(stored)).toBe(0);
    expect(ledger.get("c1")!.state).toBe("running");
    expect(ledger.all()).toHaveLength(1);
  });

  test("a restored card does not state a token count nobody measured", () => {
    const ledger = new FleetLedger();
    ledger.restore([
      {
        id: "task_a",
        kind: "task",
        callId: "c1",
        name: "planner",
        status: "end_turn",
        at: "2026-10-02T10:00:00Z",
      },
    ]);
    const card = ledger.get("c1")!;
    const rows = renderCard(card, 1, ledger.view(false), "full", 38, Date.now()).map(stripAnsi);
    expect(rows.join("\n")).toContain("from the session log");
    expect(rows.join("\n")).not.toContain("0 tok");
  });
});
