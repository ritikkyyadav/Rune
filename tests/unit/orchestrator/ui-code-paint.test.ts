// The painter recolours; it never rewrites. Colour is off in a test process
// (no tty), which makes the invariant the whole test surface: whatever the
// language and whatever the line, stripping the paint must give back the line.

import { describe, expect, it } from "bun:test";
import { langOfPath, paintCode } from "../../../packages/orchestrator/src/bin/ui/code-paint";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

const identity = (s: string) => s;

describe("langOfPath", () => {
  it("maps the extensions this repo actually prints", () => {
    expect(langOfPath("src/bin/ui/turn.ts")).toBe("ts");
    expect(langOfPath("apps/api/main.py")).toBe("py");
    expect(langOfPath("crates/core/lib.rs")).toBe("rs");
    expect(langOfPath("scripts/install.sh")).toBe("sh");
    expect(langOfPath("package.json")).toBe("json");
    expect(langOfPath("README")).toBe(null);
    expect(langOfPath("noext")).toBe(null);
  });
});

describe("paintCode", () => {
  const lines: Array<[string, ReturnType<typeof langOfPath>]> = [
    ['const x = "a \\" quoted"; // trailing note', "ts"],
    ["  return doc.length > MAX ? doc.slice(0, MAX) : doc;", "ts"],
    ["def handler(self, n=42):  # comment", "py"],
    ["    pub fn new() -> Self {", "rs"],
    ['echo "hi" # done', "sh"],
    ['{"key": 12, "on": true}', "json"],
    ["totally unknown language text", null],
  ];

  it("never changes the text, only its colour", () => {
    for (const [line, lang] of lines) {
      expect(stripAnsi(paintCode(line, lang, identity))).toBe(line);
    }
  });

  it("paints a whole comment line as one comment", () => {
    // With colour off the paints are identity, so equality with the raw line
    // is the strongest portable assertion; the invariant above carries it.
    expect(stripAnsi(paintCode("  // all comment", "ts", identity))).toBe("  // all comment");
    expect(stripAnsi(paintCode("# python note", "py", identity))).toBe("# python note");
  });

  it("survives an unterminated string without dropping the tail", () => {
    const line = 'out.push("broken literal';
    expect(stripAnsi(paintCode(line, "ts", identity))).toBe(line);
  });
});

// The classification, tested where colour cannot hide it: tokenize is pure.
import { langOfLabel, tokenize } from "../../../packages/orchestrator/src/bin/ui/code-paint";

const roleOf = (line: string, lang: Parameters<typeof tokenize>[1], text: string) =>
  tokenize(line, lang).find((t) => t.text === text)?.role ?? null;

describe("tokenize", () => {
  it("is lossless: the tokens join back into the line", () => {
    for (const [line, lang] of [
      ["export function projectsForRun(projects: DetectedProject[]): DetectedProject[] {", "ts"],
      ["    const scoped = projectForFiles(this.config.workspaceRoot, touched ?? []);", "ts"],
      ["def upgma_newick(aligned: dict[str, str]) -> str:  # tree", "py"],
      ["cd frontend && bun test tests/runner.test.ts | tail -3", "sh"],
      ['{"key": 12, "on": true}', "json"],
      ['<div class="card" id=main>', "html"],
    ] as const) {
      expect(
        tokenize(line, lang)
          .map((t) => t.text)
          .join(""),
      ).toBe(line);
    }
  });

  it("tells keywords, types, functions, properties and constants apart (ts)", () => {
    const line =
      "export function projectsForRun(projects: DetectedProject[]): DetectedProject[] { return null; }";
    expect(roleOf(line, "ts", "export")).toBe("keyword");
    expect(roleOf(line, "ts", "function")).toBe("keyword");
    expect(roleOf(line, "ts", "projectsForRun")).toBe("function");
    expect(roleOf(line, "ts", "DetectedProject")).toBe("type");
    expect(roleOf(line, "ts", "null")).toBe("constant");
    const dotted = "const p = this.config.workspaceRoot.trim();";
    expect(roleOf(dotted, "ts", "this")).toBe("constant");
    expect(roleOf(dotted, "ts", "config")).toBe("property");
    expect(roleOf(dotted, "ts", "trim")).toBe("function");
    expect(roleOf("@Injectable() class A {}", "ts", "@Injectable")).toBe("decorator");
    expect(roleOf("const MAX_ROWS = 40;", "ts", "MAX_ROWS")).toBe(null); // SCREAMING_CASE is not a type
  });

  it("paints python and rust with the same vocabulary", () => {
    const py = "def upgma_newick(aligned: dict[str, str]) -> Tree:";
    expect(roleOf(py, "py", "def")).toBe("keyword");
    expect(roleOf(py, "py", "upgma_newick")).toBe("function");
    expect(roleOf(py, "py", "Tree")).toBe("type");
    expect(roleOf("return None", "py", "None")).toBe("constant");
    const rs = "pub fn new(name: String) -> Option<Self> { Some(Self { name }) }";
    expect(roleOf(rs, "rs", "fn")).toBe("keyword");
    expect(roleOf(rs, "rs", "new")).toBe("function");
    expect(roleOf(rs, "rs", "String")).toBe("type");
    expect(roleOf(rs, "rs", "Some")).toBe("constant");
  });

  it("paints shell commands in command position, not their arguments", () => {
    const line = "cd frontend && bun test tests/runner.test.ts | tail -3";
    const t = tokenize(line, "sh");
    const roles = t.filter((x) => x.role === "function").map((x) => x.text);
    expect(roles).toEqual(["cd", "bun", "tail"]);
    expect(roleOf(line, "sh", "frontend")).toBe(null);
  });

  it("paints json keys as names and json values as strings", () => {
    const line = '{"key": "value", "n": 12, "on": true}';
    expect(roleOf(line, "json", '"key"')).toBe("property");
    expect(roleOf(line, "json", '"value"')).toBe("string");
    expect(roleOf(line, "json", "12")).toBe("number");
    expect(roleOf(line, "json", "true")).toBe("constant");
  });

  it("paints html tags as keywords and attributes as properties", () => {
    const line = '<div class="card" id=main>text</div>';
    expect(roleOf(line, "html", "div")).toBe("keyword");
    expect(roleOf(line, "html", "class")).toBe("property");
    expect(roleOf(line, "html", '"card"')).toBe("string");
    expect(roleOf(line, "html", "text")).toBe(null);
  });

  it("comments win over everything after their marker", () => {
    const t = tokenize("let x = 1; // const y", "ts");
    expect(t.at(-1)).toEqual({ text: "// const y", role: "comment" });
    expect(tokenize("# whole line", "py")).toEqual([{ text: "# whole line", role: "comment" }]);
  });
});

describe("langOfLabel", () => {
  it("maps fence labels the way the diffs map extensions", () => {
    expect(langOfLabel("typescript")).toBe("ts");
    expect(langOfLabel("ts")).toBe("ts");
    expect(langOfLabel("python")).toBe("py");
    expect(langOfLabel("bash")).toBe("sh");
    expect(langOfLabel("Shell")).toBe("sh");
    expect(langOfLabel("rust")).toBe("rs");
    expect(langOfLabel("html")).toBe("html");
    expect(langOfLabel("text")).toBe(null);
    expect(langOfLabel("")).toBe(null);
  });
});
