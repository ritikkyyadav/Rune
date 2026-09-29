// ─── The serious family as parity tasks ───
//
// tests/eval/serious/source.ts builds the tree an arm starts from and grades the
// tree the arm leaves. These tests exercise both on a synthetic two-commit
// repository. The arm gets the parent's tree without history, without the
// project config and without the hidden tests. The grade runs the fix commit's
// own tests over whatever the arm left, and nothing the arm wrote changes what
// those tests are. The last block checks every committed task file.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  INTERFACE_HEADING,
  loadSpecs,
  seriousTask,
  seriousTasks,
  specProblems,
  type SeriousTaskSpec,
} from "../../eval/serious/source";

const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "serious-source-test-"));
const repo = join(scratch, "repo");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(cwd: string, command: string, args: string[]): string {
  const out = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}
const git = (cwd: string, ...args: string[]) =>
  run(cwd, "git", [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ]);
function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const BUGGY = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
const FIXED = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const HIDDEN_TEST = [
  'import { describe, expect, test } from "bun:test";',
  'import { add } from "../../../packages/calc/src/add";',
  'describe("add", () => {',
  '  test("adds", () => expect(add(2, 3)).toBe(5));',
  '  test("zero is neutral", () => expect(add(4, 0)).toBe(4));',
  "});",
  "",
].join("\n");

let parent = "";
let fix = "";
beforeAll(() => {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  write(repo, ".gitignore", "node_modules/\n");
  write(repo, "package.json", JSON.stringify({ name: "synthetic", private: true }) + "\n");
  run(repo, "bun", ["install"]);
  write(repo, ".rune/config.toml", '[llm]\ndefaultProvider = "one-arm-only"\n');
  write(repo, "packages/calc/src/add.ts", BUGGY);
  write(
    repo,
    "tests/unit/calc/other.test.ts",
    'import { expect, test } from "bun:test";\ntest("one", () => expect(1).toBe(1));\n',
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "parent");
  parent = git(repo, "rev-parse", "HEAD");
  write(repo, "packages/calc/src/add.ts", FIXED);
  write(repo, "tests/unit/calc/add.test.ts", HIDDEN_TEST);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "calc: add adds");
  fix = git(repo, "rev-parse", "HEAD");
});

const spec = (): SeriousTaskSpec => ({
  id: "f7-synthetic-add",
  sha: fix,
  parent,
  subject: "calc: add adds",
  packages: ["calc"],
  shape: "fix",
  family: "F7",
  prompt: "Adding two numbers gives the wrong answer. ".repeat(3),
  f2p: ["tests/unit/calc/add.test.ts :: add > adds"],
  p2p: ["tests/unit/calc/add.test.ts :: add > zero is neutral"],
  impossible: [],
  typecheckPackages: [],
  typecheckBaseClean: {},
  typecheckFixedClean: {},
  timeLimit: "serious",
  hiddenFiles: ["tests/unit/calc/add.test.ts"],
  testFiles: ["tests/unit/calc/add.test.ts"],
  fixFiles: ["packages/calc/src/add.ts"],
  mined: { at: "2026-09-28", bun: Bun.version, baseWallMs: [], fixedWallMs: [] },
});

async function prepared(name: string) {
  const task = seriousTask(spec(), { repoRoot: repo });
  const workspace = join(scratch, name);
  await task.prepare(workspace);
  return { task, workspace, evidence: join(scratch, `${name}-evidence`) };
}

describe("prepare: the tree an arm starts from", () => {
  test("the parent's files, one commit of history, no project config, no hidden tests, installed", async () => {
    const { workspace } = await prepared("prepare");
    expect(readFileSync(join(workspace, "packages/calc/src/add.ts"), "utf8")).toBe(BUGGY);
    expect(existsSync(join(workspace, "tests/unit/calc/other.test.ts"))).toBe(true);
    expect(existsSync(join(workspace, "tests/unit/calc/add.test.ts"))).toBe(false);
    expect(existsSync(join(workspace, ".rune/config.toml"))).toBe(false);
    expect(git(workspace, "log", "--format=%s")).toBe("base");
    expect(
      spawnSync("git", ["-C", workspace, "cat-file", "-e", `${fix}^{commit}`]).status,
    ).not.toBe(0);
    expect(git(workspace, "status", "--porcelain")).toBe("");
  });

  test("a workspace that is not empty is refused", async () => {
    const workspace = join(scratch, "occupied");
    write(workspace, "left-over.txt", "x");
    await expect(seriousTask(spec(), { repoRoot: repo }).prepare(workspace)).rejects.toThrow(
      /not empty/,
    );
  });
});

describe("grade: the tree an arm leaves", () => {
  test("an untouched tree passes none of the fail-to-pass checks", async () => {
    const { task, workspace, evidence } = await prepared("untouched");
    expect(await task.grade(workspace, evidence)).toEqual({
      hiddenPassed: 0,
      hiddenTotal: 1,
      regressionsIntroduced: 0,
      buildBroken: false,
      impossible: [],
    });
    const record = JSON.parse(readFileSync(join(evidence, "grade.json"), "utf8"));
    expect(record.f2p).toEqual({ "tests/unit/calc/add.test.ts :: add > adds": "fail" });
  });

  test("the reference fix passes all of them", async () => {
    const { task, workspace, evidence } = await prepared("reference");
    write(workspace, "packages/calc/src/add.ts", FIXED);
    expect(await task.grade(workspace, evidence)).toMatchObject({
      hiddenPassed: 1,
      hiddenTotal: 1,
      regressionsIntroduced: 0,
    });
  });

  test("breaking what passed at the parent is a regression", async () => {
    const { task, workspace, evidence } = await prepared("regression");
    write(
      workspace,
      "packages/calc/src/add.ts",
      "export function add(a: number, b: number): number {\n  return b === 0 ? a + 1 : a + b;\n}\n",
    );
    expect(await task.grade(workspace, evidence)).toMatchObject({
      hiddenPassed: 1,
      regressionsIntroduced: 1,
    });
  });

  test("the hidden tests are the fix commit's, whatever the arm wrote in their place", async () => {
    const { task, workspace, evidence } = await prepared("own-tests");
    write(
      workspace,
      "tests/unit/calc/add.test.ts",
      'import { describe, test } from "bun:test";\ndescribe("add", () => { test("adds", () => {}); });\n',
    );
    expect(await task.grade(workspace, evidence)).toMatchObject({
      hiddenPassed: 0,
      hiddenTotal: 1,
    });
    expect(readFileSync(join(workspace, "tests/unit/calc/add.test.ts"), "utf8")).toBe(HIDDEN_TEST);
  });
});

describe("a task file's shape", () => {
  test("a well-formed spec has no problems", () => {
    expect(specProblems(spec())).toEqual([]);
  });

  test("an interface needs its section in the prompt, and the section needs an interface", () => {
    expect(specProblems({ ...spec(), interface: ["Calc#add"] })).toHaveLength(1);
    const withSection = `${spec().prompt}\n\n${INTERFACE_HEADING}:\n- \`add\``;
    expect(specProblems({ ...spec(), prompt: withSection })).toHaveLength(1);
    expect(specProblems({ ...spec(), prompt: withSection, interface: ["add"] })).toEqual([]);
  });

  test("no fail-to-pass check, a check in two lists, or a check outside the test files", () => {
    expect(specProblems({ ...spec(), f2p: [] })).toContain("at least one fail-to-pass check");
    expect(specProblems({ ...spec(), impossible: [spec().f2p[0]!] }).join()).toContain(
      "listed twice",
    );
    expect(specProblems({ ...spec(), p2p: ["tests/unit/other.test.ts :: x"] }).join()).toContain(
      "outside the test files",
    );
  });
});

describe("the committed serious corpus", () => {
  const specs = loadSpecs();

  test("at least 25 tasks, including the three seeds", () => {
    expect(specs.length).toBeGreaterThanOrEqual(25);
    for (const seed of ["653698d", "88758b3", "a36ca74"])
      expect(specs.some((s) => s.sha.startsWith(seed))).toBe(true);
  });

  test("every task file is well formed, and ids are unique", () => {
    for (const s of specs)
      expect({ id: s.id, problems: specProblems(s) }).toEqual({ id: s.id, problems: [] });
    expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
  });

  test("every task is an F7 serious ParityTask with its prompt verbatim", () => {
    const tasks = seriousTasks();
    expect(tasks).toHaveLength(specs.length);
    for (const task of tasks) {
      expect(task.family).toBe("F7");
      expect(task.size).toBe("serious");
      expect(task.prompt).toBe(specs.find((s) => s.id === task.id)!.prompt);
    }
  });
});
