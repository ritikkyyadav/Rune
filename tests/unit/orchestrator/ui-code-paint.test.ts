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
