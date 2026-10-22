/**
 * The project's own format check, run at the end of a turn (2026-10-22).
 *
 * The dogfood run: Rune and Codex CLI both left a new row of the table in
 * `docs/ci.md` wider than its column, and CI's format gate refused both trees.
 * Rune never ran the format check. Now a `format:check` script that runs
 * prettier is a check, and a red one is read file by file: a file the run did
 * not change was not unformatted by it, so formatting debt the run was handed
 * never costs it a repair turn.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CommandVerifier,
  attributeUnformatted,
  detectVerifyCommands,
  prettierUnformatted,
  type FailureAttribution,
} from "../../../packages/orchestrator/src/verifier";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}
function dir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rune-format-"));
  made.push(root);
  put(root, files);
  return root;
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "app", scripts });

describe("detection: a format check that runs prettier", () => {
  test("format:check after lint, last of all", () => {
    const root = dir({
      "package.json": pkg({
        typecheck: "tsc --noEmit",
        test: "bun test",
        lint: "eslint .",
        "format:check": "prettier --check .",
      }),
      "bun.lock": "",
    });
    expect(detectVerifyCommands(root)).toEqual([
      "bun run typecheck",
      "bun run test",
      "bun run lint",
      "bun run format:check",
    ]);
  });

  test("the other names it goes by, and -c for --check", () => {
    const root = dir({
      "package.json": pkg({ "prettier:check": "prettier -c src" }),
      "bun.lock": "",
    });
    expect(detectVerifyCommands(root)).toEqual(["bun run prettier:check"]);
  });

  test("a format script that does not run prettier in check mode is not one", () => {
    for (const body of ["biome format .", "prettier --write .", "dprint check"]) {
      const root = dir({ "package.json": pkg({ "format:check": body }), "bun.lock": "" });
      expect(detectVerifyCommands(root), body).toEqual([]);
    }
  });

  test("it never takes the build fallback's place", () => {
    const root = dir({
      "package.json": pkg({ build: "tsc", "format:check": "prettier --check ." }),
      "bun.lock": "",
    });
    expect(detectVerifyCommands(root)).toEqual(["bun run build", "bun run format:check"]);
  });
});

describe("reading a prettier --check report", () => {
  test("the files it names, without its summary line", () => {
    const one =
      "Checking formatting...\n[warn] docs/ci.md\n" +
      "[warn] Code style issues found in the above file. Run Prettier with --write to fix.\n";
    expect(prettierUnformatted(one)).toEqual(["docs/ci.md"]);
    const two =
      "Checking formatting...\n[warn] a.md\n[warn] src/b.ts\n" +
      "[warn] Code style issues found in 2 files. Run Prettier with --write to fix.\n";
    expect(prettierUnformatted(two)).toEqual(["a.md", "src/b.ts"]);
  });

  test("a clean report, a parse error, or something else entirely: no list", () => {
    expect(
      prettierUnformatted("Checking formatting...\nAll matched files use Prettier code style!\n"),
    ).toBeNull();
    expect(
      prettierUnformatted(
        "Checking formatting...\n[error] src/a.ts: SyntaxError: Unexpected token\n",
      ),
    ).toBeNull();
    // The case the rule is for: an old unformatted file AND a file prettier
    // could not parse. Read as a list, it would name only the old file, call
    // the whole red the run's inheritance, and hide the run's syntax error.
    expect(
      prettierUnformatted(
        "Checking formatting...\n[warn] old.md\n" +
          "[error] src/a.ts: SyntaxError: Unexpected token (3:1)\n" +
          "[warn] Code style issues found in the above file. Run Prettier with --write to fix.\n",
      ),
    ).toBeNull();
    expect(prettierUnformatted("[warn] something, from some other tool\n")).toBeNull();
  });

  test("file by file: untouched files predate the run, touched ones are the run's", () => {
    const a = attributeUnformatted(["old.md", "./docs/new.md"], new Set(["docs/new.md"]));
    expect(a).toEqual({
      known: true,
      existing: ["old.md"],
      introduced: ["./docs/new.md"],
      of: "files",
    });
  });
});

// ─── The whole path, on a real tree ───

const POSIX = process.platform !== "win32";
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Stands in for prettier: names the files listed in `.fmt-bad`, as prettier --check does. */
const FAKE_PRETTIER = `#!/bin/sh
echo "Checking formatting..."
bad=$(cat .fmt-bad 2>/dev/null)
if [ -z "$bad" ]; then echo "All matched files use Prettier code style!"; exit 0; fi
for f in $bad; do echo "[warn] $f"; done
echo "[warn] Code style issues found in the above file. Run Prettier with --write to fix."
exit 1
`;

/** A committed project whose format check already names `old.md`. */
function project(): string {
  const root = dir({
    "package.json": pkg({ "format:check": "prettier --check ." }),
    "bun.lock": "",
    ".gitignore": "node_modules/\n",
    "old.md": "an unformatted file, from before\n",
    ".fmt-bad": "old.md\n",
    "src/a.ts": "export const a = 1;\n",
    "node_modules/.bin/prettier": FAKE_PRETTIER,
  });
  chmodSync(join(root, "node_modules/.bin/prettier"), 0o755);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}
const known = (a: FailureAttribution | undefined) => {
  if (!a?.known) throw new Error(`expected a known attribution, got ${a ? a.why : "none"}`);
  return a;
};

describe.skipIf(!POSIX)("CommandVerifier: a red format check, attributed", () => {
  test("the debt it was handed: red, and every file named predates the run", async () => {
    const root = project();
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
    const r = await v.verify(undefined, [join(root, "src/a.ts")]);
    expect(r.status).toBe("failed");
    const a = known(r.attribution);
    expect(a.existing).toEqual(["old.md"]);
    expect(a.introduced).toEqual([]);
    expect(a.of).toBe("files");
  });

  test("a file the run wrote, left unformatted: that one is the run's", async () => {
    const root = project();
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    put(root, { "docs/new.md": "the run's table\n", ".fmt-bad": "old.md docs/new.md\n" });
    const r = await v.verify(undefined, [join(root, "docs/new.md")]);
    const a = known(r.attribution);
    expect(a.existing).toEqual(["old.md"]);
    expect(a.introduced).toEqual(["docs/new.md"]);
  });

  test("the run changed prettier's own setup: no file can be said to predate it", async () => {
    const root = project();
    const v = new CommandVerifier({ workspaceRoot: root });
    v.beginChanges();
    put(root, { ".prettierrc": '{ "printWidth": 40 }\n' });
    const r = await v.verify(undefined, [join(root, ".prettierrc")]);
    expect(r.attribution?.known).toBe(false);
    expect(r.attribution && !r.attribution.known ? r.attribution.why : "").toContain(
      "formatter's setup changed",
    );
  });
});
