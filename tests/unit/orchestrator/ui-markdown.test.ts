/**
 * Unit tests for the markdown → ANSI renderer — the response partition's
 * typography. The model's final answer must read as set type, never as raw
 * markup (`###`, ``` fences, ** markers).
 */

import { describe, it, expect } from "bun:test";
import {
  renderMarkdown,
  wrapInline,
  parseInline,
} from "../../../packages/orchestrator/src/bin/ui/markdown";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

const plain = (lines: string[]): string[] => lines.map(stripAnsi);

describe("renderMarkdown — block structure", () => {
  it("renders headings as type, not markup", () => {
    const out = plain(renderMarkdown("## What I built\n\nA site.", { width: 60 }));
    expect(out.join("\n")).not.toContain("#");
    expect(out[0]).toContain("What I built");
    // h1/h2 carry a hairline underneath
    expect(out[1]).toMatch(/-+/);
  });

  it("frames fenced code the way the rail frames a tool's record", () => {
    // The founder, 2026-09-15, put the framed diffs and the unframed answer
    // side by side and named which one was right. Code in an answer is a
    // record being quoted, and a record closes on both edges: the same
    // corners, rule and gutter as flow.box, with the language on the top rule.
    const md = "Run this:\n\n```bash\ncd atlas-studio\npython3 -m http.server 8000\n```\nDone.";
    const out = plain(renderMarkdown(md, { width: 60, indent: "" }));
    const joined = out.join("\n");
    expect(joined).not.toContain("```");
    expect(out[2]).toMatch(/^┌ bash ─+┐$/); // the language is the frame's label
    expect(out[3]).toMatch(/^│ cd atlas-studio\s+│$/);
    expect(out[4]).toMatch(/^│ python3 -m http\.server 8000\s+│$/);
    expect(out[5]).toMatch(/^└─+┘$/);
    // Every row of the frame is the same width: the box closes.
    expect(new Set(out.slice(2, 6).map((l) => l.length)).size).toBe(1);
    expect(out[out.length - 1]).toBe("Done.");
  });

  it("labels an unlabelled fence `code`, so the frame still says what it holds", () => {
    const out = plain(renderMarkdown("```\nx = 1\n```", { width: 40, indent: "" }));
    expect(out[0]).toMatch(/^┌ code ─+┐$/);
  });

  it("never eats an underscore inside an identifier", () => {
    // A coding agent prints snake_case constantly; treating those underscores
    // as emphasis silently rewrites the very names the reader needs.
    const out = plain(
      renderMarkdown("The loop breaks on content_block_stop, so call read_file.", {
        width: 100,
        indent: "",
      }),
    ).join("\n");
    expect(out).toBe("The loop breaks on content_block_stop, so call read_file.");
  });

  it("still reads a standalone underscore run as emphasis", () => {
    const out = plain(
      renderMarkdown("This is _really_ important, and __very__ so.", { width: 100, indent: "" }),
    ).join("\n");
    expect(out).toBe("This is really important, and very so.");
  });

  it("closes the frame of a fence the model never terminated", () => {
    const out = plain(renderMarkdown("```\ncode", { width: 60, indent: "" }));
    expect(out).toHaveLength(3);
    expect(out[1]).toMatch(/^│ code\s+│$/);
    expect(out[2]).toMatch(/^└─+┘$/);
  });

  it("renders list items with real bullets and hanging indents", () => {
    const md =
      "- first item that is long enough to wrap onto a second line for sure here\n- second";
    const out = plain(renderMarkdown(md, { width: 40, indent: "" }));
    expect(out[0]!.startsWith("· ")).toBe(true);
    // continuation aligns under the text, not under the bullet
    expect(out[1]!.startsWith("  ")).toBe(true);
    expect(out.join("\n")).toContain("· second");
  });

  it("keeps ordered-list numbers", () => {
    const out = plain(renderMarkdown("1. Navigate\n2. Start server", { width: 60 }));
    expect(out[0]).toContain("1.");
    expect(out[1]).toContain("2.");
  });

  it("wraps paragraphs to the width budget", () => {
    const md = "word ".repeat(30).trim();
    const out = plain(renderMarkdown(md, { width: 40, indent: "" }));
    expect(out.length).toBeGreaterThan(1);
    for (const ln of out) expect(ln.length).toBeLessThanOrEqual(40);
  });

  it("collapses runs of blank lines", () => {
    const out = plain(renderMarkdown("a\n\n\n\n\nb", { width: 60 }));
    expect(out.filter((l) => l.trim() === "").length).toBe(1);
  });
});

describe("inline styling", () => {
  it("strips **bold**, `code` and [link](url) markers", () => {
    const out = stripAnsi(
      wrapInline("Use **npm** and `bun test` then [docs](https://x.dev)", 80).join("\n"),
    );
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
    expect(out).toContain("npm");
    expect(out).toContain("bun test");
    expect(out).toContain("docs (https://x.dev)");
  });

  it("parses segments without losing text", () => {
    const segs = parseInline("plain **bold** `code` end");
    expect(segs.map((s) => s.t).join("")).toBe("plain bold code end");
  });

  it("hard-breaks a single over-wide word instead of overflowing", () => {
    const out = wrapInline("x".repeat(100), 30).map(stripAnsi);
    for (const ln of out) expect(ln.length).toBeLessThanOrEqual(30);
    expect(out.join("")).toBe("x".repeat(100));
  });
});

// ─── Tables ───
//
// The founder, 2026-09-15 night, on an audit answer whose tables were set down
// as raw pipes and cut at the right edge: "how badly it has structured the
// data ... solve it properly". A table is the one block whose meaning IS its
// geometry, so it is measured and laid out: columns fitted to the measure, the
// widest column wrapping inside itself, the header ruled, the markers parsed.

import {
  fitColumns,
  renderTable,
  splitTableRow,
} from "../../../packages/orchestrator/src/bin/ui/markdown";

describe("renderMarkdown — tables", () => {
  const audit = [
    "| Agent | Score | Position |",
    "|---|---:|---|",
    "| Claude Code | **100** | Reference baseline |",
    "| Codex | **90** | Strongest hosted/cloud workflow |",
    "| **Rune** | **78** | Strong safety, auditability, routing and verification; behind on proven model quality, ecosystem maturity and cloud execution |",
  ].join("\n");

  it("lays the columns out, parses the markers, and rules the header", () => {
    const out = plain(renderMarkdown(audit, { width: 100, indent: "" }));
    // No source pipes and no bold markers survive.
    expect(out.join("\n")).not.toContain("|");
    expect(out.join("\n")).not.toContain("**");
    expect(out[0]).toMatch(/^Agent\s+│\s+Score\s+│\s+Position$/);
    expect(out[1]).toMatch(/^─+$/);
    // Every cell of a column starts in the same column of the screen.
    const gutter = (line: string) => line.indexOf("│");
    const first = gutter(out[0]!);
    for (const line of out.slice(2)) expect(gutter(line), line).toBe(first);
  });

  it("right-aligns a `---:` column so the numbers line up on their last digit", () => {
    const out = plain(renderMarkdown(audit, { width: 100, indent: "" }));
    const score = (line: string) => line.split("│")[1]!;
    expect(score(out[2]!).trimEnd().endsWith("100")).toBe(true);
    expect(score(out[3]!).trimEnd().endsWith("90")).toBe(true);
    expect(score(out[2]!).trimEnd().length).toBe(score(out[3]!).trimEnd().length);
  });

  it("wraps the widest column inside itself instead of cutting the row", () => {
    const out = plain(renderMarkdown(audit, { width: 72, indent: "" }));
    for (const line of out) expect(line.length, line).toBeLessThanOrEqual(72);
    const joined = out.join("\n");
    expect(joined).toContain("cloud execution"); // the tail of the long cell survives
    expect(joined).toContain("Reference baseline");
    // The long cell continues on rows of its own, under its column: the
    // first two columns of a continuation row are blank.
    const continuation = out.find((line) => /^\s+│\s+│\s+\S/.test(line));
    expect(continuation).toBeDefined();
  });

  it("keeps a short column whole while the long one wraps", () => {
    const widths = fitColumns([11, 5, 120], 60, 3);
    expect(widths[0]).toBe(11);
    expect(widths[1]).toBe(5);
    expect(widths[2]).toBe(60 - 11 - 5 - 6);
  });

  it("stops squeezing at the floor rather than dropping a column", () => {
    const widths = fitColumns([40, 40, 40], 20, 3);
    expect(widths).toEqual([8, 8, 8]);
  });

  it("splits cells on pipes but not inside code or after a backslash", () => {
    expect(splitTableRow("| a | `x | y` | c \\| d |")).toEqual(["a", "`x | y`", "c | d"]);
  });

  it("sets a table with no header as body rows", () => {
    const out = plain(renderTable(["| a | b |", "| c | d |"], 40, "primary"));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^a\s+│\s+b$/);
  });

  it("sits between paragraphs without swallowing them", () => {
    const md = `Before.\n\n${audit}\n\nAfter.`;
    const out = plain(renderMarkdown(md, { width: 100, indent: "" }));
    expect(out[0]).toBe("Before.");
    expect(out[out.length - 1]).toBe("After.");
  });
});

describe("renderMarkdown — setext headings", () => {
  it("sets a title with a line of dashes under it as a heading, not a paragraph and a rule", () => {
    const out = plain(renderMarkdown("Rune audit\n----------\n\nBody.", { width: 60, indent: "" }));
    expect(out[0]).toBe("Rune audit");
    expect(out[1]).toBe("-".repeat("Rune audit".length));
    expect(out[out.length - 1]).toBe("Body.");
    expect(out.join("\n")).not.toContain("-".repeat(40));
  });

  it("does not leave a dangling divider on an empty last cell", () => {
    const out = plain(
      renderMarkdown("| a | b |\n|---|---|\n| **Total** | |", { width: 40, indent: "" }),
    );
    expect(out[2]).toBe("Total │");
  });
});
