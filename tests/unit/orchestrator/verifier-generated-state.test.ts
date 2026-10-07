/**
 * What a check the harness ran leaves behind in the tree.
 *
 * B1, 2026-10-05: on the serious task the verifier's own end-of-turn
 * `bun run typecheck` was `turbo typecheck`, which builds every package — and
 * left 129 new git-ignored paths (`.turbo/`, `packages/<each>/dist/`) in the
 * person's repository. H1b sends cargo's and Python's generated state somewhere
 * else through the environment; a JavaScript build has no such switch.
 *
 * The founder's rule for it: after a pass of checks the harness ran, remove the
 * git-ignored paths that were not there when the pass began. Only those. What
 * was there before stays as the check left it; a new file git does NOT ignore is
 * a visible change and stays for the person to see; installed dependencies and
 * other tools' state are never taken; a command the person wrote in `[verify]
 * commands` keeps what it builds; and `[verify] keepGenerated` turns the whole
 * thing off.
 *
 * "Not there when the pass began" is held three ways, because a path git lists
 * as newly ignored is not always a new path: it was in neither of git's
 * listings before, and the file system says it was created during the pass.
 *
 * Real git repositories, the project's own declared scripts as the detected
 * checks, and real child processes. No model.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CommandVerifier,
  ignoredPaths,
  removeGenerated,
  removedNote,
  treeBefore,
  type TreeBefore,
} from "../../../packages/orchestrator/src/verifier";

// Real repositories and real processes: a commit's write to disk, or a child's
// start, can take seconds on a busy machine. The default five would then fail a
// test about a two-second deadline for a reason that has nothing to do with it.
setDefaultTimeout(60_000);

/**
 * POSIX-only where a check is run or a link is made: `CommandVerifier` runs
 * each check through `bash -c`, and Rune has no Windows shell contract yet
 * (see `verifier.test.ts`). The listing and the audit line are held everywhere.
 */
const POSIX_SHELL = process.platform !== "win32";

/**
 * Whether this file system says when a path was created. One guard reads it;
 * where there is none it decides nothing, and the test of it has nothing to hold.
 */
const BIRTH_TIMES = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "rune-born-"));
  try {
    const born = lstatSync(probe).birthtimeMs;
    return born > 0 && Math.abs(Date.now() - born) < 60_000;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

let root: string;
let outside: string;

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@localhost", "-c", "commit.gpgSign=false", ...args],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

function put(rel: string, text = "x\n"): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const there = (rel: string): boolean => existsSync(join(root, rel));

/**
 * A check, as a node script: writes each `path` it is given (a trailing `/` is
 * an empty directory), then waits `sleepMs`, then exits `exit`.
 */
const WRITES = `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
const [exit, sleepMs, ...paths] = process.argv.slice(2);
for (const path of paths) {
  const full = isAbsolute(path) ? path : join(process.cwd(), path);
  if (path.endsWith("/")) mkdirSync(full, { recursive: true });
  else {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "generated\\n");
  }
}
if (Number(sleepMs) > 0) await new Promise((resolve) => setTimeout(resolve, Number(sleepMs)));
process.exit(Number(exit));
`;
/** A check that is green only when every path it is given exists. */
const NEEDS = `import { existsSync } from "node:fs";
process.exit(process.argv.slice(2).every((path) => existsSync(path)) ? 0 : 1);
`;
/** A check that writes an ignore rule for each name it is given. */
const IGNORES = `import { appendFileSync } from "node:fs";
for (const rule of process.argv.slice(2)) appendFileSync(".gitignore", rule + "\\n");
`;

const writes = (paths: string[], opts: { exit?: number; sleepMs?: number } = {}): string =>
  `node writes.mjs ${opts.exit ?? 0} ${opts.sleepMs ?? 0} ${paths.join(" ")}`;

/** What git ignores in the fixture. */
const IGNORED = [
  "dist/",
  ".turbo/",
  "node_modules/",
  ".venv/",
  "venv/",
  "vendor/",
  "Pods/",
  "*.egg-info/",
  ".rune/",
  ".claude/",
  ".idea/",
  ".vscode/",
  ".env*",
  ".DS_Store",
  "*.log",
  "*.tmp",
  "cache-link",
];

/** The files of a project whose declared scripts are `scripts`, under `dir`. */
function projectFiles(scripts: Record<string, string>, dir = ""): void {
  put(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }, null, 2) + "\n");
  // Its package manager: the scripts are run as `bun run <name>`.
  put(join(dir, "bun.lock"), "");
  put(join(dir, "writes.mjs"), WRITES);
  put(join(dir, "needs.mjs"), NEEDS);
  put(join(dir, "ignores.mjs"), IGNORES);
}

/**
 * Make the fixture a committed project with these scripts, and return the
 * verifier for it. `typecheck`, `test` and `lint` are what detection reads,
 * and the order a pass runs them in.
 */
function project(
  scripts: Record<string, string>,
  config: Record<string, unknown> = {},
): CommandVerifier {
  projectFiles(scripts);
  git("add", ".");
  git("commit", "-m", "project");
  return new CommandVerifier({ workspaceRoot: root, ...config });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rune-generated-"));
  outside = mkdtempSync(join(tmpdir(), "rune-generated-outside-"));
  put(".gitignore", IGNORED.join("\n") + "\n");
  put("src/a.ts", "export const a = 1;\n");
  put("packages/a/index.ts", "export const a = 1;\n");
  git("init", "--initial-branch=main");
  git("add", ".");
  git("commit", "-m", "base");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** A listing with nothing in it, taken `agoMs` ago: everything ignored now is a candidate. */
const emptyBefore = (agoMs = 0): TreeBefore => ({
  at: Date.now() - agoMs,
  ignored: new Set(),
  unignored: new Set(),
});

describe.skipIf(!POSIX_SHELL)("after a pass of the checks Rune chose", () => {
  test("the git-ignored paths it created are gone, wherever in the tree they were made", async () => {
    const result = await project({
      typecheck: writes([
        "dist/out.js",
        ".turbo/cache/a.json",
        "packages/a/dist/index.js",
        "build.log",
      ]),
    }).verify();

    expect(result.runs?.map((run) => run.command)).toEqual(["bun run typecheck"]);
    expect(result.status).toBe("passed");
    for (const path of ["dist", ".turbo", "packages/a/dist", "build.log"]) {
      expect(there(path)).toBe(false);
    }
    // And the tree reads to git exactly as it did before the check.
    expect(git("status", "--porcelain", "--ignored")).toBe("");
  });

  test("it says what it removed beside the result, and the report stays the checks' own words", async () => {
    const result = await project({
      typecheck: writes(["dist/out.js", ".turbo/cache/a.json"]),
    }).verify();
    expect(result.removed).toEqual([".turbo/", "dist/"]);
    // The report's last line is what a surface shows as a failure's own words.
    expect(result.report).toBe("$ bun run typecheck  (ok)");
  });

  test("a pass that generated nothing says nothing about it", async () => {
    const result = await project({ typecheck: writes([]) }).verify();
    expect(result.status).toBe("passed");
    expect(result.removed).toBeUndefined();
    expect("removed" in result).toBe(false);
  });

  test("what was already there stays, as the check left it", async () => {
    const verifier = project({ typecheck: writes(["dist/new.js", "build.log"]) });
    put("dist/old.js");
    put("debug.log");
    const result = await verifier.verify();

    // The directory existed: what the check added inside it is not "new".
    expect(readdirSync(join(root, "dist")).sort()).toEqual(["new.js", "old.js"]);
    expect(there("debug.log")).toBe(true);
    // The file beside it did not.
    expect(there("build.log")).toBe(false);
    expect(result.removed).toEqual(["build.log"]);
  });

  test("a new file git does NOT ignore is a visible change, and is left for the person to see", async () => {
    await project({ typecheck: writes(["generated.txt", "dist/out.js"]) }).verify();
    expect(there("generated.txt")).toBe(true);
    expect(git("status", "--porcelain")).toBe("?? generated.txt");
    expect(there("dist")).toBe(false);
  });

  test("every check of the pass is covered, and the build one made is there for the next", async () => {
    const result = await project({
      typecheck: writes(["dist/out.js"]),
      // Green only if the first check's output is still there.
      test: "node needs.mjs dist/out.js",
      lint: writes(["late.log"]),
    }).verify();
    expect(result.runs?.map((run) => [run.command, run.passed])).toEqual([
      ["bun run typecheck", true],
      ["bun run test", true],
      ["bun run lint", true],
    ]);
    expect(result.removed).toEqual(["dist/", "late.log"]);
    expect(git("status", "--porcelain", "--ignored")).toBe("");
  });
});

describe.skipIf(!POSIX_SHELL)("what is never taken, whatever git says about it", () => {
  const kept = async (paths: string[]): Promise<void> => {
    const result = await project({ typecheck: writes([...paths, "dist/out.js"]) }).verify();
    for (const path of paths) expect([path, there(path)]).toEqual([path, true]);
    // Not because nothing was removed at all.
    expect(result.removed).toEqual(["dist/"]);
  };

  test("installed dependencies, at the root or under a package", async () => {
    await kept([
      "node_modules/x/index.js",
      "packages/a/node_modules/y/index.js",
      ".venv/bin/python",
      "venv/bin/python",
      "vendor/bundle/a.rb",
      "Pods/A/a.h",
      "src/pkg.egg-info/PKG-INFO",
    ]);
  });

  test("Rune's own state in the workspace, and another agent's", async () => {
    await kept([".rune/search.db", ".claude/settings.local.json"]);
  });

  test("a person's environment files and their editor's folder", async () => {
    await kept([
      ".env",
      ".env.local",
      "packages/a/.env.test",
      ".idea/workspace.xml",
      ".vscode/settings.json",
      ".DS_Store",
    ]);
  });

  test("inside a new folder that holds only ignored things: those stay, the rest of it goes", async () => {
    // No rule names `fresh/` or `gone/`. Git lists each as ignored because
    // everything in it is — and lists what is in it, which is decided there.
    const result = await project({
      typecheck: writes([
        "fresh/.env",
        "fresh/node_modules/y/index.js",
        "fresh/run.log",
        "gone/deep/x.log",
      ]),
    }).verify();
    expect(there("fresh/.env")).toBe(true);
    expect(there("fresh/node_modules/y/index.js")).toBe(true);
    expect(there("fresh/run.log")).toBe(false);
    expect(there("gone")).toBe(false);
    expect(result.removed).toEqual(["fresh/run.log", "gone/"]);
  });

  test("a name that only resembles one of those is the checks' like any other", async () => {
    const lookalikes = [
      "vendor.log",
      "node_modules.tmp",
      "a.env.tmp",
      "x.idea.tmp",
      ".ideas.tmp",
      "my.DS_Store.tmp",
      "pkg.egg-info.tmp",
    ];
    const result = await project({ typecheck: writes(lookalikes) }).verify();
    for (const path of lookalikes) expect([path, there(path)]).toEqual([path, false]);
    expect(result.removed).toEqual([...lookalikes].sort());
  });
});

describe.skipIf(!POSIX_SHELL)("a link", () => {
  test("the checks left is unlinked, never followed", async () => {
    writeFileSync(join(outside, "precious.txt"), "keep\n");
    const link = join(root, "cache-link");
    symlinkSync(outside, link);
    expect(await removeGenerated(root, emptyBefore())).toEqual(["cache-link"]);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep\n");
  });

  test("inside a folder the checks made goes with the folder, and what it points at stays", async () => {
    writeFileSync(join(outside, "precious.txt"), "keep\n");
    put("dist/out.js");
    symlinkSync(outside, join(root, "dist", "linked"));
    expect(await removeGenerated(root, emptyBefore())).toEqual(["dist/"]);
    expect(there("dist")).toBe(false);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep\n");
  });
});

describe.skipIf(!POSIX_SHELL)("however the pass ends", () => {
  test("a failing check is cleaned up after, and its report ends on its own last line", async () => {
    const result = await project({ typecheck: writes(["dist/out.js"], { exit: 1 }) }).verify();
    expect(result.status).toBe("failed");
    expect(there("dist")).toBe(false);
    expect(result.removed).toEqual(["dist/"]);
    expect(result.report.startsWith("$ bun run typecheck  (exit 1)")).toBe(true);
    expect(result.report).not.toContain("removed");
  });

  test("a check cut at its deadline is cleaned up after", async () => {
    const result = await project(
      { typecheck: writes(["dist/out.js"], { sleepMs: 20_000 }) },
      { timeoutMs: 2_000 },
    ).verify();
    expect(result).toMatchObject({ status: "inconclusive", reason: "timeout" });
    expect(there("dist")).toBe(false);
    expect(result.removed).toEqual(["dist/"]);
  });

  test("a cancelled pass is cleaned up after", async () => {
    const verifier = project({ typecheck: writes(["dist/out.js"], { sleepMs: 20_000 }) });
    const cancel = new AbortController();
    // Once the check has written: a cancel that lands before it has is a pass
    // that generated nothing.
    const written = setInterval(() => {
      if (!there("dist/out.js")) return;
      clearInterval(written);
      cancel.abort();
    }, 20);
    const result = await verifier.verify(cancel.signal);
    expect(result).toMatchObject({ status: "inconclusive", reason: "cancelled" });
    expect(there("dist")).toBe(false);
    expect(result.removed).toEqual(["dist/"]);
  });
});

describe.skipIf(!POSIX_SHELL)("what is not the pass's to remove", () => {
  test("an ignored path that was made before the pass began — by the model, or by anyone", async () => {
    const verifier = project({ typecheck: writes([]) });
    put("dist/models-own-build.js");
    put(".turbo/cache/earlier.json");
    const result = await verifier.verify();
    expect(there("dist/models-own-build.js")).toBe(true);
    expect(there(".turbo/cache/earlier.json")).toBe(true);
    expect(result.removed).toBeUndefined();
  });

  test("a folder that was there, empty: the checks' file in it goes, the folder stays", async () => {
    // To git an empty folder is not ignored — and one holding only ignored
    // files is. So `logs/` reads as newly ignored once the check has run.
    const verifier = project({ typecheck: writes(["logs/run.log"]) });
    mkdirSync(join(root, "logs"));
    const result = await verifier.verify();
    expect(there("logs")).toBe(true);
    expect(there("logs/run.log")).toBe(false);
    expect(result.removed).toEqual(["logs/run.log"]);
  });

  test("a folder that was there, when a check writes the rule that ignores it", async () => {
    const verifier = project({ typecheck: "node ignores.mjs notes/" });
    put("notes/keep.md", "a person's\n");
    const result = await verifier.verify();
    expect(result.status).toBe("passed");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toEndWith("\nnotes/\n");
    expect(readFileSync(join(root, "notes/keep.md"), "utf8")).toBe("a person's\n");
    expect(result.removed).toBeUndefined();
  });

  test.skipIf(!BIRTH_TIMES)(
    "a file that was on disk before the pass began, in a folder git listed whole",
    async () => {
      // `scratch/` is one entry to git while nothing in it is tracked, so the
      // listing from before cannot say `old.tmp` was in it. Its creation time can.
      put("scratch/a.txt");
      put("scratch/old.tmp", "a person's\n");
      const before = (await treeBefore(root))!;
      expect([...before.unignored]).toEqual(["scratch/"]);
      expect([...before.ignored]).toEqual(["scratch/old.tmp"]);
      // The same tree, as a pass that began ten seconds later would have found
      // it had the rule for `*.tmp` not been written yet.
      const pass: TreeBefore = { ...before, at: before.at + 10_000, ignored: new Set() };
      expect(await removeGenerated(root, pass)).toEqual([]);
      expect(there("scratch/old.tmp")).toBe(true);
    },
  );

  test("a clock that keeps time to the second does not make a new path an old one", async () => {
    put("dist/out.js");
    // Born a second before the pass's own clock read, as such a clock would put it.
    const pass: TreeBefore = { ...emptyBefore(), at: Date.now() + 1_000 };
    expect(await removeGenerated(root, pass)).toEqual(["dist/"]);
    expect(there("dist")).toBe(false);
  });

  test("anything outside the workspace", async () => {
    // The check writes beside the workspace, not in it.
    const sibling = join(outside, "a.log");
    const result = await project({ typecheck: writes([sibling]) }).verify();
    expect(result.status).toBe("passed");
    expect(existsSync(sibling)).toBe(true);
    expect(result.removed).toBeUndefined();
  });

  test("a tree that is not a git repository: nothing is listed, nothing is removed", async () => {
    const verifier = project({ typecheck: writes(["dist/out.js", "build.log"]) });
    rmSync(join(root, ".git"), { recursive: true, force: true });
    expect(await ignoredPaths(root)).toBeNull();
    expect(await treeBefore(root)).toBeNull();
    const result = await verifier.verify();
    expect(result.status).toBe("passed");
    expect(there("dist/out.js")).toBe(true);
    expect(there("build.log")).toBe(true);
    expect(result.removed).toBeUndefined();
  });

  test("with no listing from before, nothing is removed", async () => {
    put("dist/out.js");
    expect(await removeGenerated(root, null)).toEqual([]);
    expect(there("dist/out.js")).toBe(true);
  });
});

describe("the listing taken before a pass", () => {
  test("is the ignored paths, a directory as one entry", async () => {
    put("dist/a.js");
    put("dist/deep/b.js");
    put("x.log");
    put("src/new.ts");
    expect([...(await ignoredPaths(root))!].sort()).toEqual(["dist/", "x.log"]);
  });

  test("holds what git ignores, what it would offer to add, and when it was taken", async () => {
    put("dist/a.js");
    put("src/new.ts");
    put("drafts/one.md");
    const from = Date.now();
    const before = (await treeBefore(root))!;
    expect([...before.ignored]).toEqual(["dist/"]);
    expect([...before.unignored].sort()).toEqual(["drafts/", "src/new.ts"]);
    expect(before.at).toBeGreaterThanOrEqual(from);
    expect(before.at).toBeLessThanOrEqual(Date.now());
  });

  test.skipIf(!POSIX_SHELL)(
    "is of the workspace, when the workspace is a folder of a larger repository",
    async () => {
      projectFiles({ typecheck: writes(["dist/out.js"]) }, "packages/a");
      git("add", ".");
      git("commit", "-m", "project");
      put("elsewhere.log");
      const workspace = join(root, "packages", "a");
      expect([...(await ignoredPaths(workspace))!]).toEqual([]);
      const result = await new CommandVerifier({ workspaceRoot: workspace }).verify();
      expect(result.removed).toEqual(["dist/"]);
      expect(there("packages/a/dist")).toBe(false);
      expect(there("elsewhere.log")).toBe(true);
    },
  );
});

describe.skipIf(!POSIX_SHELL)("a command the person wrote in `[verify] commands`", () => {
  test("is theirs, and so is what it builds", async () => {
    projectFiles({});
    git("add", ".");
    git("commit", "-m", "project");
    const result = await new CommandVerifier({
      workspaceRoot: root,
      commands: [writes(["dist/out.js", "build.log"])],
    }).verify();
    expect(result.status).toBe("passed");
    expect(there("dist/out.js")).toBe(true);
    expect(there("build.log")).toBe(true);
    expect(result.removed).toBeUndefined();
  });

  test("at a step check too", async () => {
    // `tsc` in its name makes this a compile-class command: what a step check runs.
    projectFiles({});
    put("tsc.mjs", WRITES);
    git("add", ".");
    git("commit", "-m", "project");
    const result = await new CommandVerifier({
      workspaceRoot: root,
      commands: ["node tsc.mjs 0 0 dist/out.js"],
    }).verifyFast();
    expect(result.status).toBe("passed");
    expect(there("dist/out.js")).toBe(true);
    expect(result.removed).toBeUndefined();
  });
});

describe.skipIf(!POSIX_SHELL)("`[verify] keepGenerated`", () => {
  test("leaves everything the checks made, and says nothing", async () => {
    const result = await project(
      { typecheck: writes(["dist/out.js", "build.log"]) },
      { keepGenerated: true },
    ).verify();
    expect(result.status).toBe("passed");
    expect(there("dist/out.js")).toBe(true);
    expect(there("build.log")).toBe(true);
    expect(result.removed).toBeUndefined();
  });
});

describe.skipIf(!POSIX_SHELL)("the step check", () => {
  test("is a pass like any other", async () => {
    const result = await project({
      typecheck: writes(["dist/out.js", ".turbo/cache/a.json"]),
      test: writes(["never-run.log"]),
    }).verifyFast();
    // The compile-class check, and only it.
    expect(result.runs?.map((run) => run.command)).toEqual(["bun run typecheck"]);
    expect(result.status).toBe("passed");
    expect(there("dist")).toBe(false);
    expect(there(".turbo")).toBe(false);
    expect(result.removed).toEqual([".turbo/", "dist/"]);
  });
});

describe("the line for the audit trail", () => {
  test("names what went", () => {
    expect(removedNote(["dist/"])).toBe("removed 1 git-ignored path the checks generated: dist/");
    expect(removedNote([".turbo/", "dist/"])).toBe(
      "removed 2 git-ignored paths the checks generated: .turbo/, dist/",
    );
  });

  test("names six, and counts the rest", () => {
    const many = ["a/", "b/", "c/", "d/", "e/", "f/", "g/", "h/"];
    expect(removedNote(many)).toBe(
      "removed 8 git-ignored paths the checks generated: a/, b/, c/, d/, e/, f/, and 2 more",
    );
    expect(removedNote(many.slice(0, 7))).toBe(
      "removed 7 git-ignored paths the checks generated: a/, b/, c/, d/, e/, f/, and 1 more",
    );
    expect(removedNote(many.slice(0, 6))).toBe(
      "removed 6 git-ignored paths the checks generated: a/, b/, c/, d/, e/, f/",
    );
  });
});
