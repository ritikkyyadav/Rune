/**
 * The grammar law.
 *
 * The UI had one design system and four dialects that did not use it: the live
 * rung, the read-back and the composer blocks each hand-built their own layout,
 * so the screen accurately reported that it was assembled by separate parts.
 * That is not a thing you fix once — it is a thing that drifts back the next
 * time a subsystem needs a row and writes one itself.
 *
 * So the law is tested, not documented:
 *
 *   1. Nothing in the transcript right-aligns. One left edge, one flow.
 *   2. The indent ladder has exactly three rungs (MARK / BODY / RAIL_IN).
 *   3. Receipt parts are joined by one separator everywhere.
 *
 * The signature of right-alignment is a long run of spaces inside a rendered
 * row — that is what padding to the far margin looks like once the colour is
 * stripped. Verbatim content (diff bodies, command output) is exempt: a source
 * line's own indentation is content, not layout.
 */

import { describe, expect, it } from "bun:test";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";
import { renderToolActivity } from "../../../packages/orchestrator/src/bin/ui/activity";
import { autoApprovedChip } from "../../../packages/orchestrator/src/bin/ui/composer";
import { heldCloseReceipt, heldOutcomeRow } from "../../../packages/orchestrator/src/bin/ui/held";
import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";
import { renderReadBack } from "../../../packages/orchestrator/src/bin/ui/read-back";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../../packages/orchestrator/src/bin/ui/render";

const plain = (s: string) => stripAnsi(s);

/** A gap of four or more spaces after column 8 is padding to a far margin.
 *  Below that it is the fixed verb column, which is alignment inside a row
 *  rather than alignment to the window. */
function hasFarMarginGap(line: string): boolean {
  const body = plain(line).slice(8);
  return /\S {4,}\S/.test(body);
}

function rows(): Array<[string, string]> {
  return [
    [
      "read",
      renderToolActivity({
        toolName: "read_file",
        args: { path: "src/streaming.ts" },
        result: JSON.stringify({ path: "src/streaming.ts", total_lines: 319 }),
        success: true,
      }),
    ],
    [
      "grep",
      renderToolActivity({
        toolName: "grep",
        args: { pattern: "content_block_stop" },
        result: JSON.stringify({
          total_matches: 4,
          matches: [{ file: "src/a.ts", line_number: 42 }],
        }),
        success: true,
      }),
    ],
    [
      "list",
      renderToolActivity({
        toolName: "list_dir",
        args: { path: "src" },
        result: JSON.stringify({ path: "src", total_count: 52 }),
        success: true,
      }),
    ],
    [
      "checklist head",
      F.checklist("plan", [{ status: "ok", label: "Map the repository" }], {
        caption: "3 steps",
      })[0]!,
    ],
    [
      "checklist item",
      F.checklist("plan", [
        { status: "active", label: "Audit the backend", metric: "in progress" },
      ])[1]!,
    ],
    ["chip", autoApprovedChip({ toolName: "bash", risk: "high", kind: "contained" })],
    [
      "held outcome",
      heldOutcomeRow(
        { toolName: "bash", summary: "npm publish", reason: "outward", route: "publication" },
        "ran",
        "published",
      ),
    ],
    ["held close", heldCloseReceipt(["ran", "failed", "skipped"])],
  ];
}

describe("the grammar law — one left edge", () => {
  it("no transcript row pads to the right margin, at any terminal width", () => {
    for (const columns of [60, 100, 160, 240]) {
      setTermWidthOverride(columns);
      for (const [name, block] of rows()) {
        for (const line of block.split("\n")) {
          expect(
            hasFarMarginGap(line),
            `${name} @ ${columns}: ${JSON.stringify(plain(line))}`,
          ).toBe(false);
        }
      }
    }
    setTermWidthOverride(undefined as unknown as number);
  });

  it("the live rung reads like the rows it becomes", () => {
    setTermWidthOverride(120);
    const commits: string[] = [];
    const sink: TurnSink = { commit: (b) => commits.push(b), preview: () => {} };
    const turn = new TurnRenderer(sink, { getCost: () => 0 });
    turn.onEvent({ type: "usage", inputTokens: 10, outputTokens: 1800 });
    for (const line of turn.liveLines()) {
      expect(hasFarMarginGap(line), `rung: ${JSON.stringify(plain(line))}`).toBe(false);
    }
    // And it starts on the same left edge as everything else.
    expect(plain(turn.liveLines()[0]!).startsWith(F.MARK)).toBe(true);
    setTermWidthOverride(undefined as unknown as number);
  });

  it("the fleet panel stands on the rail, at any width", () => {
    for (const columns of [60, 100, 160, 240]) {
      setTermWidthOverride(columns);
      const commits: string[] = [];
      const sink: TurnSink = { commit: (b) => commits.push(b), preview: () => {} };
      const turn = new TurnRenderer(sink, { getCost: () => 0 });
      for (const [id, label] of [
        ["c1", "map the deploy surface"],
        ["c2", "find the auth store"],
      ] as const) {
        turn.onEvent({ type: "tool_call_start", callId: id, toolName: "task" });
        turn.onEvent({
          type: "tool_call_args_delta",
          callId: id,
          partialJson: JSON.stringify({ label, prompt: "…" }),
        });
        turn.onEvent({ type: "tool_progress", callId: id, note: "", state: "started" });
        turn.onEvent({ type: "tool_progress", callId: id, note: "grep content_block_stop" });
      }
      for (const line of turn.liveLines()) {
        expect(hasFarMarginGap(line), `fleet @ ${columns}: ${JSON.stringify(plain(line))}`).toBe(
          false,
        );
        // The panel earns rows, never columns: nothing here outruns the window.
        expect(plain(line).length).toBeLessThanOrEqual(columns);
      }
    }
    setTermWidthOverride(undefined as unknown as number);
  });

  it("the read-back stands on the same ladder, not its own", () => {
    setTermWidthOverride(120);
    const block = renderReadBack({
      reading: "You want the retry loop to surface a 429 instead of swallowing it.",
      touch: ["src/retry.ts"],
      leave: ["the gateway's cooldown table"],
      criteria: [{ text: "the suite passes" }],
    } as never);
    for (const line of block.split("\n").filter((l) => plain(l).trim())) {
      expect(hasFarMarginGap(line), `read-back: ${JSON.stringify(plain(line))}`).toBe(false);
      const indent = plain(line).match(/^ */)![0].length;
      expect([F.MARK.length, F.BODY.length, F.RAIL_IN.length]).toContain(indent);
    }
    setTermWidthOverride(undefined as unknown as number);
  });
});

describe("the grammar law — one separator", () => {
  it("joins receipt parts with the same mark everywhere", () => {
    const joined = plain(F.receiptOf(["5m 49s", "down 3.8k tokens", "thought for 5.2s"]));
    expect(joined).not.toContain("|");
    expect(joined.split(" ").filter((t) => t.length === 1 && t !== "").length).toBeGreaterThan(0);
  });

  it("drops empty parts rather than rendering a bare separator", () => {
    expect(plain(F.receiptOf([]))).toBe("");
    expect(plain(F.receiptOf(["only one", "", undefined, null]))).toBe("only one");
  });
});
