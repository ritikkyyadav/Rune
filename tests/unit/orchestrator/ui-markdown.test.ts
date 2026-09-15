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
