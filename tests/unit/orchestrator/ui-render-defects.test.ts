/**
 * The defects the 2026-09-08 render pass found, each pinned by the minimal
 * event sequence that reproduced it.
 *
 * They were found by replaying the five largest September sessions from the
 * founder's run DB through the real TurnRenderer (`scripts/render-live.ts`) at
 * 80, 100 and 120 columns and reading the result. Every one of them is a thing
 * the founder was looking at and nobody could see, because the TUI cannot look
 * at itself. The evidence is under `docs/evidence/ui-render-20260908/`.
 *
 * This file is the guard: the same shapes, small enough to read.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  TurnRenderer,
  type BlockHandle,
  type TurnSink,
} from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride, visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { formatEvent } from "../../../packages/orchestrator/src/bin/ui/events";
import { renderToolActivity } from "../../../packages/orchestrator/src/bin/ui/activity";
import { renderMarkdown } from "../../../packages/orchestrator/src/bin/ui/markdown";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";

afterEach(() => setTermWidthOverride(null));

/**
 * The sink the FIXED FRAME gives the renderer: it owns its buffer, so it can
 * amend. Without `amend` the renderer takes the commit-at-end path and none of
 * these defects exist -- which is exactly why they went unseen.
 */
function liveHarness() {
  const blocks = new Map<BlockHandle, string>();
  const order: BlockHandle[] = [];
  let seq = 0;
  const sink: TurnSink = {
    commit(block) {
      const handle = ++seq;
      blocks.set(handle, block);
      order.push(handle);
      return handle;
    },
    amend(handle, block) {
      if (block === "") blocks.delete(handle);
      else blocks.set(handle, block);
    },
    preview() {},
  };
  const turn = new TurnRenderer(sink, { getCost: () => 0 });
  return {
    turn,
    /** The transcript as the viewport would hold it, in buffer order. */
    output: () =>
      stripAnsi(
        order
          .map((handle) => blocks.get(handle))
          .filter((block): block is string => block != null)
          .join("\n"),
      ),
    rows: () =>
      stripAnsi(
        order
          .map((handle) => blocks.get(handle))
          .filter((block): block is string => block != null)
          .join("\n"),
      )
        .split("\n")
        .map((row) => row.trim())
        .filter(Boolean),
  };
}

const start = (callId: string, toolName: string) =>
  ({ type: "tool_call_start", callId, toolName }) as const;

const end = (callId: string, toolName: string, args: Record<string, unknown>, result: string) =>
  ({
    type: "tool_call_end",
    callId,
    args,
    output: { callId, toolName, success: true, result, durationMs: 3 },
  }) as const;

// ─── D1 ───

describe("D1 -- a parallel tool batch does not orphan its rows", () => {
  /**
   * The loop dispatches a model message's tool calls together: four starts,
   * then four ends. `pending` was ONE slot, so three rows were opened, never
   * amended into their finished form and never removed -- and the finished
   * rows were appended underneath them. 500 rows across the five September
   * sessions were orphaned that way.
   */
  it("lands each finished call on the row that call opened", () => {
    const h = liveHarness();
    h.turn.onEvent(start("c1", "read_file"));
    h.turn.onEvent(start("c2", "grep"));
    h.turn.onEvent(
      end(
        "c1",
        "read_file",
        { path: "src/a.ts" },
        JSON.stringify({ path: "src/a.ts", total_lines: 12 }),
      ),
    );
    h.turn.onEvent(
      end("c2", "grep", { pattern: "needle" }, JSON.stringify({ total_matches: 2, matches: [] })),
    );
    h.turn.finish();

    // Two calls, two rows. It used to be four: the two rows the calls opened
    // were orphaned where they stood and the finished rows were appended
    // underneath them.
    expect(h.rows()).toHaveLength(2);
    const out = h.output();
    expect(out.match(/src\/a\.ts/g) ?? []).toHaveLength(1);
    expect(out.match(/needle/g) ?? []).toHaveLength(1);
  });

  it("folds a gathering burst to one chamber row and leaves nothing behind it", () => {
    const h = liveHarness();
    for (const [id, name] of [
      ["c1", "read_file"],
      ["c2", "grep"],
      ["c3", "list_dir"],
    ] as const) {
      h.turn.onEvent(start(id, name));
    }
    h.turn.onEvent(
      end(
        "c1",
        "read_file",
        { path: "src/a.ts" },
        JSON.stringify({ path: "src/a.ts", total_lines: 12 }),
      ),
    );
    h.turn.onEvent(
      end("c2", "grep", { pattern: "x" }, JSON.stringify({ total_matches: 2, matches: [] })),
    );
    h.turn.onEvent(
      end("c3", "list_dir", { path: "src" }, JSON.stringify({ path: "src", total_count: 4 })),
    );
    h.turn.finish();
    // One row for the burst, and none of the three provisional rows survive it.
    expect(h.rows()).toHaveLength(1);
    expect(h.output()).toContain("read 1 file, listed 1 directory, 1 search");
  });

  it("does not let one call's result land on a sibling's row", () => {
    const h = liveHarness();
    h.turn.onEvent(start("c1", "read_file"));
    h.turn.onEvent(start("c2", "read_file"));
    // c2 comes back first -- the batch order is the loop's, not the model's.
    h.turn.onEvent(
      end(
        "c2",
        "read_file",
        { path: "second.ts" },
        JSON.stringify({ path: "second.ts", total_lines: 2 }),
      ),
    );
    h.turn.onEvent(
      end(
        "c1",
        "read_file",
        { path: "first.ts" },
        JSON.stringify({ path: "first.ts", total_lines: 1 }),
      ),
    );
    h.turn.finish();
    const out = h.output();
    expect(out).toContain("first.ts");
    expect(out).toContain("second.ts");
    expect(out.match(/first\.ts/g) ?? []).toHaveLength(1);
    expect(out.match(/second\.ts/g) ?? []).toHaveLength(1);
  });

  it("closes every call still open when the turn ends, not just the last one", () => {
    const h = liveHarness();
    h.turn.onEvent(start("c1", "bash"));
    h.turn.onEvent(start("c2", "bash"));
    h.turn.finish();
    expect(h.output().match(/no result/g) ?? []).toHaveLength(2);
  });
});

// ─── D2 ───

describe("D2 -- the handoff state-of-work block wraps to the measure", () => {
  /**
   * The block a run that DIED owes the reader was the one block set down
   * verbatim: 346 columns on an 80-column window. The fixed frame clips
   * rather than reflows, so it was guaranteed to be cut off mid-sentence.
   */
  const state = [
    "State of work:",
    `Goal: ${"rebuild the entire analysis pipeline ".repeat(6)}`,
    "Done (1):",
    `  x ${"audit the repository and record the scorecard ".repeat(4)}`,
    `Files touched: ${Array.from({ length: 12 }, (_, i) => `backend/evolab/module_${i}.py`).join(", ")}`,
    "Next step: finish the regression",
  ].join("\n");

  it("keeps every row inside the window at 80 columns", () => {
    setTermWidthOverride(80);
    const block = formatEvent({ type: "handoff", reason: "stalled", state });
    expect(block).not.toBeNull();
    for (const row of stripAnsi(block!).split("\n")) {
      expect(visLen(row.replace(/\s+$/, ""))).toBeLessThanOrEqual(80);
    }
  });

  it("hangs a step's continuation under the step, not back at the margin", () => {
    setTermWidthOverride(80);
    const rows = stripAnsi(formatEvent({ type: "handoff", reason: "open_steps", state })!).split(
      "\n",
    );
    const stepAt = rows.findIndex((row) => /^\s+x\s/.test(row));
    expect(stepAt).toBeGreaterThan(-1);
    const lead = rows[stepAt]!.match(/^\s*/)![0].length;
    const next = rows[stepAt + 1]!;
    expect(next.match(/^\s*/)![0].length).toBe(lead + 2);
  });

  it("loses no words -- wrapping is not truncation", () => {
    setTermWidthOverride(80);
    const rows = stripAnsi(formatEvent({ type: "handoff", reason: "stalled", state })!);
    expect(rows).toContain("backend/evolab/module_11.py");
    expect(rows).toContain("Next step: finish the regression");
  });
});

// ─── D3 ───

describe("D3 -- check rows are clipped by the window, not by a constant", () => {
  const longReport = [
    `$ ${"cd packages/orchestrator && bun run typecheck && bun run lint ".repeat(4)}`,
    `error TS2345: ${"argument of type Foo is not assignable to parameter of type Bar ".repeat(3)}`,
  ].join("\n");

  it("keeps a failing verification row inside 80 columns", () => {
    setTermWidthOverride(80);
    const h = liveHarness();
    h.turn.onEvent({
      type: "verification_completed",
      attempt: 1,
      ran: true,
      passed: false,
      report: longReport,
    });
    for (const row of h.output().split("\n")) {
      expect(visLen(row.replace(/\s+$/, ""))).toBeLessThanOrEqual(80);
    }
  });

  it("keeps a failing step check inside 80 columns", () => {
    setTermWidthOverride(80);
    const h = liveHarness();
    h.turn.onEvent({
      type: "step_check",
      step: "build the thing",
      ran: true,
      passed: false,
      report: longReport,
    });
    for (const row of h.output().split("\n")) {
      expect(visLen(row.replace(/\s+$/, ""))).toBeLessThanOrEqual(80);
    }
  });
});

// ─── D4 ───

describe("D4 -- an overflowing row sacrifices its argument, never its receipt", () => {
  /**
   * `flowRow` truncated the JOINED row, and the right-hand end is where the
   * outcome lives. On 80 columns a long path ate its own result and the rail
   * filled with rows ending `0...`, `4 fil...`. A row whose receipt is gone
   * has reported nothing; the path was already on the row above it.
   */
  it("keeps the receipt whole and cuts the left side instead", () => {
    setTermWidthOverride(60);
    const left = `${F.MARK}read  ${"a/very/deep/directory/".repeat(4)}file.ts`;
    const row = stripAnsi(F.flowRow(left, "319 lines"));
    expect(visLen(row)).toBeLessThanOrEqual(60);
    expect(row.endsWith("319 lines")).toBe(true);
  });

  it("still fits the row to the window when the receipt alone would fill it", () => {
    setTermWidthOverride(40);
    const row = stripAnsi(F.flowRow("  read  src/a.ts", "x".repeat(38)));
    expect(visLen(row)).toBeLessThanOrEqual(40);
  });

  it("leaves a row that already fits exactly as it was", () => {
    setTermWidthOverride(80);
    const row = F.flowRow("  read  src/a.ts", "12 lines");
    expect(stripAnsi(row)).toBe("  read  src/a.ts  12 lines");
  });
});

// ─── D5 ───

describe("D5 -- fenced code continues at a word boundary", () => {
  const fence = [
    "```",
    "cd /Users/someone/Project/code/bangla-sweets && python3 -m http.server 8765",
    "```",
  ].join("\n");

  it("does not split a command mid-token", () => {
    // 72 - 4 of indent = 68 columns, which is exactly where the founder's
    // answer split `http.server` in two.
    const rows = renderMarkdown(fence, { width: 72, indent: "    " }).map((row) =>
      stripAnsi(row).trim(),
    );
    expect(rows.some((row) => row.endsWith("http.serv"))).toBe(false);
    expect(rows.some((row) => row.startsWith("er 8765"))).toBe(false);
    // The token survives whole on one row; the break moved to the space.
    expect(rows.some((row) => row.includes("http.server"))).toBe(true);
    expect(rows.join(" ")).toContain("python3 -m http.server");
  });

  it("still cuts a genuinely unbreakable token at the column", () => {
    const blob = "x".repeat(200);
    const rows = renderMarkdown(["```", blob, "```"].join("\n"), {
      width: 40,
      indent: "",
    }).map((row) => stripAnsi(row));
    for (const row of rows) expect(visLen(row)).toBeLessThanOrEqual(40);
    expect(rows.join("").replace(/\s/g, "")).toContain(blob);
  });
});

// ─── D6 ───

describe("D6 -- an edit with no recorded diff still says what it did", () => {
  /**
   * A bare `edit index.html` -- no metric, no evidence -- reads exactly like a
   * call that did nothing. 22 of them stand in the September sessions, from
   * before multi_edit began returning a diff.
   */
  it("names the edits applied when the result carries no diff", () => {
    const row = stripAnsi(
      renderToolActivity({
        toolName: "multi_edit",
        args: { path: "index.html" },
        result: JSON.stringify({ path: "index.html", edits_applied: 2, edits: [] }),
        success: true,
      }),
    );
    expect(row).toContain("index.html");
    expect(row).toContain("2 edits applied");
  });

  it("says so plainly when nothing was applied either", () => {
    const row = stripAnsi(
      renderToolActivity({
        toolName: "edit_file",
        args: { path: "index.html" },
        result: JSON.stringify({ path: "index.html" }),
        success: true,
      }),
    );
    expect(row).toContain("no change");
  });

  it("still prefers the diff when the result has one", () => {
    const row = stripAnsi(
      renderToolActivity({
        toolName: "multi_edit",
        args: { path: "index.html" },
        result: JSON.stringify({
          path: "index.html",
          edits_applied: 1,
          diff: "@@ -1 +1 @@\n-a\n+b",
        }),
        success: true,
      }),
    );
    expect(row).not.toContain("edits applied");
    expect(row).toContain("hunk");
  });
});
