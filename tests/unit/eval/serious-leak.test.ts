// ─── The leak check on a mined task's prompt ───
//
// tests/eval/serious/leak.ts fails a task whose hand-written prompt carries a
// name the fix introduced: a new declaration, or a new string literal of 12
// characters or more, that exists neither at the parent nor in the hidden tests
// (which are the interface the prompt is allowed to name). These tests pin each
// half: what counts as introduced, and when an introduced name is a leak.

import { describe, expect, test } from "bun:test";

import {
  addedBlocks,
  addedNames,
  declarationsOn,
  findLeaks,
  interfaceProblems,
  interfaceSymbol,
  MIN_LITERAL,
  mentions,
  scan,
} from "../../eval/serious/leak";

const DIFF = [
  "diff --git a/packages/tool-registry/src/tools/background.ts b/packages/tool-registry/src/tools/background.ts",
  "index 1111111..2222222 100644",
  "--- a/packages/tool-registry/src/tools/background.ts",
  "+++ b/packages/tool-registry/src/tools/background.ts",
  "@@ -10,6 +10,20 @@ export class BackgroundShellManager {",
  "   private shells = new Map<string, Shell>();",
  "+  /**",
  "+   * Stop every shell this manager's engine started — it's the engine's job.",
  "+   */",
  "+  async stopAll(graceMs = 2_000): Promise<void> {",
  "+    const survivors = await escalateToKill([...this.shells.values()], graceMs);",
  '+    if (survivors.length) log("background shell outlived SIGKILL escalation");',
  "+  }",
  "   list() {",
  "+  const PROCESS_GROUP_GRACE_MS = 2_000;",
  "+  function escalateToKill(shells: Shell[], graceMs: number) {",
  "+    return shells.filter((shell) => !shell.stopped); // its short note",
  "+  }",
  "diff --git a/packages/tool-registry/package.json b/packages/tool-registry/package.json",
  "--- a/packages/tool-registry/package.json",
  "+++ b/packages/tool-registry/package.json",
  "@@ -1,3 +1,3 @@",
  '+  "description": "a package description that is long enough",',
].join("\n");

describe("what a fix introduces", () => {
  test("only the added lines of code files count; the diff's own headers do not", () => {
    const blocks = addedBlocks(DIFF);
    expect(blocks.map((b) => b.file)).toEqual([
      "packages/tool-registry/src/tools/background.ts",
      "packages/tool-registry/src/tools/background.ts",
    ]);
    expect(blocks.map((b) => b.text).join("\n")).not.toContain("private shells");
  });

  test("declared names: methods, functions and constants", () => {
    const names = addedNames(DIFF).identifiers;
    for (const name of ["stopAll", "survivors", "PROCESS_GROUP_GRACE_MS", "escalateToKill"])
      expect(names).toContain(name);
    // A call, a parameter and a property are not declarations.
    for (const name of ["log", "graceMs", "shells", "filter"]) expect(names).not.toContain(name);
  });

  test("long literals are collected; a doc comment's apostrophes open no string", () => {
    const literals = addedNames(DIFF).literals;
    expect(literals).toEqual(["background shell outlived SIGKILL escalation"]);
  });

  test(`a literal needs ${MIN_LITERAL} characters`, () => {
    const at = (n: number) => addedNames(`+++ b/x.ts\n+const a = "${"x".repeat(n)}";`).literals;
    expect(at(MIN_LITERAL - 1)).toEqual([]);
    expect(at(MIN_LITERAL)).toEqual(["x".repeat(MIN_LITERAL)]);
  });

  test("a template's fixed text is split at its expressions", () => {
    expect(
      scan("warn(`${path} is not valid TOML (${reason}); applying what it can`);").literals,
    ).toEqual([" is not valid TOML (", "); applying what it can"]);
  });

  test("a regular expression with quotes in it opens no string", () => {
    expect(scan(`const q = text.replace(/["']/g, "a long replacement");`).literals).toEqual([
      "a long replacement",
    ]);
    expect(scan(`const r = a / b; const s = "a long enough string";`).literals).toEqual([
      "a long enough string",
    ]);
  });

  test("the declaration shapes", () => {
    expect(declarationsOn("export async function resumePlan(id: string) {")).toEqual([
      "resumePlan",
    ]);
    expect(declarationsOn("export class ResumeStore extends Base {")).toEqual(["ResumeStore"]);
    expect(declarationsOn("export interface ResumeDeps {")).toEqual(["ResumeDeps"]);
    expect(declarationsOn("export type Transition = { from: string };")).toEqual(["Transition"]);
    expect(declarationsOn("enum Phase { A }")).toEqual(["Phase"]);
    expect(declarationsOn("const { claimed, stale: staleRow = null, ...others } = rows;")).toEqual([
      "claimed",
      "staleRow",
      "others",
    ]);
    expect(declarationsOn("  transition(from: Row, to: Row): boolean {")).toEqual(["transition"]);
    expect(declarationsOn("  stored(sessionId: string): Row | undefined;")).toEqual(["stored"]);
    expect(declarationsOn("  private async claimRow(")).toEqual(["claimRow"]);
    expect(declarationsOn("  onSettled: async (row) => {")).toEqual(["onSettled"]);
    expect(declarationsOn("  if (row.status === done) {")).toEqual([]);
    expect(declarationsOn("  await store.save(next);")).toEqual([]);
    expect(declarationsOn("  save(next);")).toEqual([]);
    expect(declarationsOn('  describe("x", () => {')).toEqual([]);
  });

  test("a new field is a name too: interface members, class fields, object keys", () => {
    expect(declarationsOn("  groupGone: boolean;")).toEqual(["groupGone"]);
    expect(declarationsOn("  leaderExited?: boolean;")).toEqual(["leaderExited"]);
    expect(declarationsOn("  private readonly foldedTails!: WeakMap<Message, string>;")).toEqual([
      "foldedTails",
    ]);
    expect(declarationsOn("      attemptStartedAt: stamp,")).toEqual(["attemptStartedAt"]);
    // Not members: a case label, a default, a ternary's tail, a type-only colon pair.
    expect(declarationsOn('    case "x":')).toEqual([]);
    expect(declarationsOn("    default:")).toEqual([]);
    expect(declarationsOn("      ? a : b")).toEqual([]);
    expect(declarationsOn("  cond ? a : b")).toEqual([]);
    expect(declarationsOn("  std::string name;")).toEqual([]);
  });
});

describe("a task's interface list", () => {
  test("an entry names its last symbol, or a module without its extension", () => {
    expect(interfaceSymbol("ResumePlanStore#transition")).toEqual({
      kind: "symbol",
      name: "transition",
    });
    expect(interfaceSymbol("CostEntry.attemptStartedAt")).toEqual({
      kind: "symbol",
      name: "attemptStartedAt",
    });
    expect(interfaceSymbol("reportCheckpoints(db, keep?): Report")).toEqual({
      kind: "symbol",
      name: "reportCheckpoints",
    });
    expect(interfaceSymbol("packages/shared/src/model-catalog.ts")).toEqual({
      kind: "module",
      name: "packages/shared/src/model-catalog",
    });
  });

  const tests = [
    'import { describeAge } from "../../../packages/shared/src/model-catalog";',
    "expect(store.transition(a, b, root)).toBe(true);",
  ].join("\n");
  const prompt =
    "Provide `ResumePlanStore#transition` and `describeAge` in packages/shared/src/model-catalog.ts.";

  test("every entry is used by the hidden tests and named in the prompt", () => {
    expect(
      interfaceProblems(
        ["ResumePlanStore#transition", "describeAge", "packages/shared/src/model-catalog.ts"],
        prompt,
        tests,
      ),
    ).toEqual([]);
  });

  test("an entry the tests never use is a licence to leak, and is refused", () => {
    expect(interfaceProblems(["escalateToKill"], "Use `escalateToKill`.", tests)).toEqual([
      "interface escalateToKill is not referenced by the hidden tests",
    ]);
    expect(interfaceProblems(["packages/x/src/other.ts"], "packages/x/src/other", tests)).toEqual([
      "interface packages/x/src/other.ts is not imported by the hidden tests",
    ]);
  });

  test("an entry the prompt never names is a promise the prompt does not keep", () => {
    expect(interfaceProblems(["describeAge"], "Cache the catalogue.", tests)).toEqual([
      "interface describeAge is not named in the prompt",
    ]);
    // A whole word, not a substring of a longer one.
    expect(interfaceProblems(["transition"], "Call transitionAll().", tests)).toEqual([
      "interface transition is not named in the prompt",
    ]);
  });
});

describe("when an introduced name is a leak", () => {
  const added = {
    identifiers: ["escalateToKill", "stopAll", "PROCESS_GROUP_GRACE_MS", "list"],
    literals: ["background shell outlived SIGKILL escalation", "not valid TOML anywhere"],
  };
  const base = new Set(["list"]);
  const inBase = (needle: string) => base.has(needle);
  const testText = 'manager.stopAll(50); expect(warning).toContain("not valid TOML anywhere");';
  const leaks = (prompt: string) => findLeaks({ prompt, added, testText, inBase });

  test("a new name in the prompt that the tests do not reference", () => {
    expect(leaks("Stop them with escalateToKill after a grace.").leaks).toEqual(["escalateToKill"]);
    expect(leaks("Use PROCESS_GROUP_GRACE_MS.").leaks).toEqual(["PROCESS_GROUP_GRACE_MS"]);
  });

  test("a name the parent already had is not new", () => {
    expect(leaks("The list of shells stays as it is.").leaks).toEqual([]);
  });

  test("a name the hidden tests reference is the interface, not a leak", () => {
    expect(leaks("Provide `BackgroundShellManager#stopAll(graceMs?)`.")).toEqual({
      leaks: [],
      interfaceNames: ["stopAll"],
    });
  });

  test("a name counts only as a whole word, case and all", () => {
    expect(leaks("Do not escalateToKillers or Escalatetokill.").leaks).toEqual([]);
    expect(mentions("call stopAll()", "stopAll")).toBe(true);
    expect(mentions("call stopAllShells()", "stopAll")).toBe(false);
  });

  test("a new literal in the prompt is a leak whatever its case, unless the tests use it", () => {
    expect(leaks("It logs 'Background shell outlived SIGKILL escalation'.").leaks).toEqual([
      "background shell outlived SIGKILL escalation",
    ]);
    expect(leaks("The warning says not valid TOML anywhere.")).toEqual({
      leaks: [],
      interfaceNames: ["not valid TOML anywhere"],
    });
  });

  test("a literal shorter than the minimum is never a leak", () => {
    const short = findLeaks({
      prompt: "It says too short.",
      added: { identifiers: [], literals: ["too short"] },
      testText: "",
      inBase: () => false,
    });
    expect(short.leaks).toEqual([]);
  });
});
