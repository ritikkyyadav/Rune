/**
 * parseDiff reads the diff a tool answered with, not the diff it wished for.
 *
 * Two shapes it must survive (2026-09-10): a diff whose text ends in a newline,
 * which used to grow a phantom empty context row numbered one past the last
 * real line; and the native edit tool's older output, which glued the hunk's
 * first line onto the hunk header ("@@ -1,3 +1,5 @@ export function greet…")
 * so the gutter started one row early. A git-style header, whose trailer is a
 * function name from ABOVE the hunk, must not be mistaken for that.
 */

import { describe, expect, test } from "bun:test";
import { parseDiff } from "../../../packages/orchestrator/src/bin/ui/flow";

const HEADERLESS = [
  "--- a/greet.ts",
  "+++ b/greet.ts",
  "@@ -1,3 +1,5 @@",
  " export function greet(name: string): string {",
  '-  return "hi " + name;',
  "+  const trimmed = name.trim();",
  "+  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);",
  '+  return "hi " + capitalized;',
  " }",
  "",
].join("\n");

describe("parseDiff", () => {
  test("a trailing newline is the end of the text, not an empty context row", () => {
    const { rows, added, removed } = parseDiff(HEADERLESS);
    expect(added).toBe(3);
    expect(removed).toBe(1);
    expect(rows.at(-1)).toEqual({ kind: "context", line: 5, text: "}" });
    expect(rows.filter((r) => r.kind === "context" && r.text === "")).toHaveLength(0);
  });

  test("numbers rows from the header: the removed line is old line 2, the first added is new line 2", () => {
    const { rows } = parseDiff(HEADERLESS);
    expect(rows[0]).toEqual({
      kind: "context",
      line: 1,
      text: "export function greet(name: string): string {",
    });
    expect(rows[1]).toMatchObject({ kind: "remove", line: 2 });
    expect(rows[2]).toMatchObject({ kind: "add", line: 2 });
    expect(rows[4]).toMatchObject({ kind: "add", line: 4 });
  });

  test("an older native diff with the first line glued onto the header reads the same", () => {
    const glued = HEADERLESS.replace(
      "@@ -1,3 +1,5 @@\n export function greet(name: string): string {",
      "@@ -1,3 +1,5 @@ export function greet(name: string): string {",
    );
    expect(glued).not.toBe(HEADERLESS);
    expect(parseDiff(glued)).toEqual(parseDiff(HEADERLESS));
  });

  test("a git header's function trailer is not a line of the hunk", () => {
    const git = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10,3 +10,4 @@ export function outer() {",
      "   const a = 1;",
      "-  const b = 2;",
      "+  const b = 3;",
      "+  const c = 4;",
      "   return a;",
    ].join("\n");
    const { rows, added, removed } = parseDiff(git);
    expect(added).toBe(2);
    expect(removed).toBe(1);
    expect(rows[0]).toEqual({ kind: "context", line: 10, text: "  const a = 1;" });
    expect(rows.some((r) => r.text.includes("outer()"))).toBe(false);
  });
});
