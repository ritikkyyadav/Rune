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

describe("the grammar law — a row is words, never an object", () => {
  // Every tool the harness ships, succeeding and failing, plus an MCP tool
  // with nested arguments: no committed row may contain the opening of a
  // JSON object. The old default case printed `compactArgs`, and the
  // harness's own tools -- record_evidence, ask_user, read_back,
  // note_hypothesis -- all fell through to it.
  const args: Record<string, Record<string, unknown>> = {
    read_file: { path: "src/a.ts" },
    list_dir: { path: "src" },
    grep: { pattern: "x", path: "src" },
    glob: { pattern: "**/*.ts" },
    write_file: { path: "src/n.ts", content: "x" },
    edit_file: { path: "src/a.ts", old_text: "a", new_text: "b" },
    multi_edit: { path: "src/a.ts", edits: [{ old_text: "a", new_text: "b" }] },
    apply_patch: { patch: "*** Begin Patch" },
    bash: { command: "ls" },
    web_search: { query: "q" },
    web_fetch: { url: "https://x" },
    todo_write: { items: [{ content: "a", status: "completed" }] },
    task: { label: "scout", prompt: "p" },
    worker: { label: "build", prompt: "p", files: ["a"] },
    ask_user: { questions: [{ question: "Which?", options: ["a", "b"] }] },
    read_back: { kind: "build", reading: "r", done_when: ["d"] },
    record_evidence: { criterion: 0, command: "bun test" },
    note_hypothesis: { text: "t" },
    record_decision: { text: "d", based_on: [] },
    read_many: { paths: ["a", "b"] },
    team: { action: "status" },
    update_config: { key: "k", value: "v" },
    interactive_dashboard: { action: "create", title: "T", spec: { a: { b: 1 } } },
    mcp_browser_click: { selector: { css: "#x" }, options: { force: true } },
  };
  for (const [toolName, a] of Object.entries(args)) {
    for (const success of [true, false]) {
      it(`${toolName} ${success ? "succeeded" : "failed"}: no row contains {"`, () => {
        const block = renderToolActivity({
          toolName,
          args: a,
          result: success ? "ok — the tool's own report, in prose" : "",
          success,
          // A tool's own error text is content, like a diff line; the rule is
          // about what the RENDERER builds from arguments.
          error: success ? undefined : "Validation failed: field is not allowed",
        });
        for (const line of block.split("\n")) {
          expect(plain(line), `${toolName}: ${JSON.stringify(plain(line))}`).not.toContain('{"');
        }
      });
    }
  }
});

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

// ─── The box grammar (P4 §2.3) ───
//
// The second register. Prose is never boxed — it is the agent talking, and it
// starts at MARK with the diamond. Everything a tool produced IS boxed, because
// a closed rectangle is the visible difference between "the agent is saying
// this" and "a program printed this".
//
// The property a box has that the rail it replaced did not is that it CLOSES.
// That is also the property a width change breaks, silently, in the one
// direction nobody is looking — which is why it is the thing tested here at
// four widths rather than looked at once in a capture.

/** The boxed forms the product ships, each drawn from a real tool result. */
function boxes(): Array<[string, string]> {
  const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c";
  return [
    [
      "run",
      renderToolActivity({
        toolName: "bash",
        args: { command: "bun test tests/unit/orchestrator/ui-frame.test.ts" },
        durationMs: 1900,
        result: JSON.stringify({
          stdout: "bun test v1.2.4\n17 pass  0 fail  41 expect() calls",
          stderr: "",
          exit_code: 0,
          timed_out: false,
        }),
        success: true,
      }),
    ],
    [
      "read",
      renderToolActivity({
        toolName: "read_file",
        args: { path: "src/streaming.ts" },
        result: JSON.stringify({
          path: "src/streaming.ts",
          total_lines: 319,
          lines_shown: 40,
          offset: 0,
          content: "   1\timport { x } from './y';\n   2\t\n   3\texport const z = 1;",
        }),
        success: true,
      }),
    ],
    [
      "edit",
      renderToolActivity({
        toolName: "edit_file",
        args: { path: "src/a.ts" },
        result: JSON.stringify({ path: "src/a.ts", diff }),
        success: true,
      }),
    ],
    [
      "write",
      renderToolActivity({
        toolName: "write_file",
        args: { path: "src/new.ts", content: "const a = 1;\nconst b = 2;\n" },
        result: JSON.stringify({ path: "src/new.ts" }),
        success: true,
      }),
    ],
    [
      "apply_patch",
      renderToolActivity({
        toolName: "apply_patch",
        args: { patch: "*** Begin Patch" },
        result: JSON.stringify({ files: [{ path: "src/a.ts", action: "modified", diff }] }),
        success: true,
      }),
    ],
    [
      "fetch",
      renderToolActivity({
        toolName: "web_fetch",
        args: { url: "https://example.com/docs/streaming" },
        result: "# Streaming\n\nThe endpoint returns server-sent events.\n",
        success: true,
      }),
    ],
  ];
}

/** Rows that open, close and stand between the two edges of a box. */
const isTop = (l: string) => /^ {2}[┌+] /.test(plain(l));
const isBottom = (l: string) => /^ {2}[└+] /.test(plain(l));
const isSide = (l: string) => /^ {2}[│|] /.test(plain(l));

describe("the box grammar — a frame closes, at every width", () => {
  it("opens and closes every box on both edges at 60, 80, 120 and 241 columns", () => {
    for (const columns of [60, 80, 120, 241]) {
      setTermWidthOverride(columns);
      for (const [name, block] of boxes()) {
        const lines = block.split("\n").map(plain);
        const tops = lines.filter(isTop);
        const bottoms = lines.filter(isBottom);
        expect(tops.length, `${name} @ ${columns}: no title row`).toBeGreaterThan(0);
        // One receipt per title: `apply_patch` draws a box per file, and a
        // patch that opened two frames and closed one is the failure this
        // counts rather than the one it describes.
        expect(bottoms.length, `${name} @ ${columns}`).toBe(tops.length);
        for (const line of lines) {
          if (isTop(line)) expect(line, `${name} @ ${columns}`).toMatch(/[┐+]$/);
          else if (isBottom(line)) expect(line, `${name} @ ${columns}`).toMatch(/[┘+]$/);
          else if (isSide(line)) expect(line, `${name} @ ${columns}`).toMatch(/[│|]$/);
        }
        // Every row of one box is the same width, so the right edge is a
        // column and not a ragged margin.
        const framed = lines.filter((l) => isTop(l) || isBottom(l) || isSide(l));
        expect(new Set(framed.map((l) => l.length)).size, `${name} @ ${columns}`).toBe(1);
      }
    }
    setTermWidthOverride(undefined as unknown as number);
  });

  it("never lets a box row exceed the measure it was drawn at", () => {
    for (const columns of [60, 80, 120, 241]) {
      setTermWidthOverride(columns);
      // What the workspace gives a row: MARK on the left and the same on the
      // right (`flow.measure`). A box that overran it would push its own right
      // edge onto the next line and stop being a rectangle.
      const measure = F.measure();
      for (const [name, block] of boxes()) {
        for (const line of block.split("\n")) {
          expect(
            plain(line).length,
            `${name} @ ${columns}: ${JSON.stringify(plain(line))}`,
          ).toBeLessThanOrEqual(measure);
        }
      }
    }
    setTermWidthOverride(undefined as unknown as number);
  });

  it("holds the right edge at a width no argument can fit", () => {
    // The interesting case is the one where the title has to give way: at 60
    // columns a 90-character command cannot be shown, and the frame is what
    // must survive, not the argument.
    setTermWidthOverride(60);
    const block = renderToolActivity({
      toolName: "bash",
      args: { command: `bun test ${"tests/unit/orchestrator/a-very-long-path".repeat(4)}` },
      result: JSON.stringify({ stdout: "ok", stderr: "", exit_code: 0 }),
      success: true,
    });
    const lines = block.split("\n").map(plain);
    expect(lines[0]).toMatch(/[┐+]$/);
    expect(lines.at(-1)).toMatch(/[┘+]$/);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    setTermWidthOverride(undefined as unknown as number);
  });

  it("folds a body over twelve rows and counts what it held back", () => {
    setTermWidthOverride(120);
    const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const block = F.box({ verb: "run", arg: "seq 1 40" }, body, { status: "ok" });
    const inner = block.slice(1, -1);
    // Nothing larger than ~12 rows enters the workspace without a keystroke.
    expect(inner.length).toBeLessThanOrEqual(F.BOX_BODY_ROWS);
    const last = plain(inner.at(-1)!);
    // Counted, and naming the key: never `...`, and never silently.
    expect(last).toMatch(/\d+ more lines/);
    expect(last).toContain("ctrl+o");
    // The count is the truth about what is missing, not a round number.
    const held = Number(last.match(/(\d+) more lines/)![1]);
    expect(held).toBe(body.length - (F.BOX_BODY_ROWS - 1));
    setTermWidthOverride(undefined as unknown as number);
  });

  it("keeps the frame closed when the tool printed a cursor-moving byte", () => {
    // Found by replaying a real session through scripts/render-live.ts: a
    // command that printed HTTP headers put a bare CR in a box body, and a CR
    // sends the cursor back to column 0 -- so the pad and the closing edge were
    // drawn over the start of the row. On the page it read as
    // `| HTTP/1.0 200 OK` with its right edge on a line of its own.
    setTermWidthOverride(80);
    const block = F.box({ verb: "run", arg: "curl -I localhost:8000" }, [
      "HTTP/1.0 200 OK\r",
      "Server: SimpleHTTP/0.6\r",
      "bell\x07 and a backspace\b",
    ]);
    for (const line of block) {
      const p = plain(line);
      expect(p).not.toMatch(/[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f]/);
      expect(p.length).toBe(plain(block[0]!).length);
    }
    expect(plain(block[1]!)).toContain("HTTP/1.0 200 OK");
    // A tab is the other character whose width the frame cannot predict.
    setTermWidthOverride(80);
    expect(plain(F.boxRow("a\tb"))).toContain("a  b");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("draws the same box with + - | on the ASCII rung", async () => {
    // The rung is resolved once at module load, so this is the one case that
    // needs its own process rather than a parameter. Everything the founder
    // would see on a seven-bit terminal is what comes back. The specifiers go
    // through JSON.stringify: pasted raw, Windows' `D:\a\…` became escape
    // sequences, the import failed, and the child printed nothing.
    const ui = (m: string) =>
      JSON.stringify(`${process.cwd()}/packages/orchestrator/src/bin/ui/${m}`);
    const script = `
      import { setTermWidthOverride } from ${ui("render")};
      import * as F from ${ui("flow")};
      setTermWidthOverride(80);
      process.stdout.write(
        F.box({ verb: "run", arg: "bun test" }, ["17 pass  0 fail"], { status: "pass", parts: ["exit 0", "1.9s"] }).join("\\n") +
        "\\n" + F.claimed("the frame holds at 80 columns", "verified") +
        "\\n" + F.rungMark("suspected") + F.rungMark("observed") + F.rungMark("reproduced") + F.rungMark("verified"),
      );
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, NO_COLOR: "1", RUNE_ASCII: "1", TERM: "dumb", LC_ALL: "C" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const lines = out.split("\n");
    // Not one byte outside 7-bit ASCII, which is the whole of the promise.
    expect(out).not.toMatch(/[^\x00-\x7f]/);
    expect(lines[0]).toMatch(/^ {2}\+ run {3}bun test -+\+$/);
    expect(lines[1]).toMatch(/^ {2}\| 17 pass {2}0 fail +\|$/);
    expect(lines[2]).toMatch(/^ {2}\+ \+ exit 0 . 1\.9s -+\+$/);
    // Every row of the ASCII box is the same width as its UTF-8 twin would be:
    // each mark has a ONE-CELL twin, so the columns land identically.
    expect(new Set(lines.slice(0, 3).map((l) => l.length)).size).toBe(1);
    // The claim ladder folds too — four rungs, four single cells.
    expect(lines.at(-1)).toBe("~.=+");
  });
});

describe("the claim ladder — never stronger than the ledger", () => {
  it("renders one cell per rung, in whichever mode is in force", () => {
    for (const rung of ["suspected", "observed", "reproduced", "verified"] as const) {
      expect(plain(F.rungMark(rung)).length, rung).toBe(1);
    }
    // `unproven` is not a rung the ledger awards — it is the absence of one,
    // and it renders as the weakest mark rather than as a blank, because a
    // missing mark reads as "no claim was made" and this is a claim with
    // nothing behind it.
    expect(plain(F.rungMark("unproven")).length).toBe(1);
    expect(F.rungMark("unproven")).toBe(F.rungMark("suspected"));
  });

  it("caps what a surface may claim at what the ledger holds", () => {
    // The rule the whole narration contract rests on: the prose can never be
    // more certain than the evidence behind it.
    expect(F.capRung("verified", "observed")).toBe("observed");
    expect(F.capRung("reproduced", "suspected")).toBe("suspected");
    expect(F.capRung("observed", "verified")).toBe("observed");
    expect(F.capRung("verified", "verified")).toBe("verified");
    // No ledger rung at all is not a weak claim; it is no claim.
    expect(F.capRung("verified", null)).toBe("unproven");
    expect(F.capRung("suspected", undefined)).toBe("unproven");
  });

  it("marks an assertive sentence with its rung instead of the agent's diamond", () => {
    setTermWidthOverride(120);
    const line = plain(F.claimed("the retry loop surfaces the 429", "verified")).split("\n")[0]!;
    expect(line.startsWith(F.MARK)).toBe(true);
    expect(line).toContain(plain(F.rungMark("verified")));
    // The diamond says "the agent is speaking"; a rung says "the agent is
    // making a claim, and here is what stands behind it". One or the other,
    // never both, and in the same column at no cost in width.
    expect(line).not.toContain("◇");
    // …and the sentence still starts in the body column, so a claim and a
    // plain sentence read down the same edge.
    expect(line.indexOf("the retry")).toBe(F.BODY.length);
    setTermWidthOverride(undefined as unknown as number);
  });

  it("wraps a claim's continuation rows onto the body rung, not under the mark", () => {
    setTermWidthOverride(80);
    const rows = plain(F.claimed("word ".repeat(60).trim(), "observed")).split("\n");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]!.match(/^ */)![0].length).toBe(F.MARK.length);
    for (const row of rows.slice(1)) {
      expect(row.match(/^ */)![0].length).toBe(F.BODY.length);
    }
    setTermWidthOverride(undefined as unknown as number);
  });
});

describe("the chrome exemption list", () => {
  /**
   * The files allowed to right-align, and why each one is on the list.
   *
   * `flow.row` puts a value on the right edge; `flow.flowRow` does not. The
   * one-edge law is about the WORKSPACE — a transcript with two columns is a
   * transcript you read twice. Chrome is a different surface: a panel heading
   * with its count on the right, a status strip, the header's version tag. §2.9
   * says so, and this list is what stops a new file quietly joining them.
   */
  const CHROME = new Set([
    "agents-panel.ts", // the panel: a section heading and its member count
    "composer.ts", // the permission card's target row and its edit metric
    "held.ts", // the held panel's `N of M decided`
    "status.ts", // `/status`'s own header row
    "tui-frame.ts", // the frame: the panel heading and the collapsed strip
  ]);

  it("names every module that right-aligns, and nothing else does", async () => {
    const { readdirSync, readFileSync } = await import("fs");
    const { join } = await import("path");
    const UI = join(import.meta.dir, "../../../packages/orchestrator/src/bin/ui");
    const users = new Set<string>();
    for (const file of readdirSync(UI).filter((n) => n.endsWith(".ts") && n !== "flow.ts")) {
      // `F.row(` is the import shape every module in this directory uses; the
      // definition itself lives in flow.ts and is excluded above.
      if (/\bF\.row\(/.test(readFileSync(join(UI, file), "utf8"))) users.add(file);
    }
    expect([...users].sort()).toEqual([...CHROME].sort());
  });

  it("keeps the workspace's own rows on one edge", () => {
    // The other half of the same law: what the transcript renders must use
    // `flowRow`, whose right-hand argument is dropped rather than aligned.
    expect(plain(F.flowRow("left", "right", 40))).not.toMatch(/\S {4,}\S/);
    expect(plain(F.row("left", "right", 40))).toMatch(/\S {4,}\S/);
  });
});
