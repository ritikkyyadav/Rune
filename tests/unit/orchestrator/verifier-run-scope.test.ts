/**
 * End-of-turn verification is scoped to what the run actually wrote.
 *
 * The failure this pins (session 01a067b8): a static site was built in
 * `bangla-sweets/` inside a workspace root that also held a dozen unrelated
 * projects. `verify()` graded every one of them, so the run was told
 * "verification failed" by a Python suite needing pandas, a gradle build with
 * no JDK, and a socket test the sandbox denies — then spent roughly fifty
 * completions and eight minutes trying to fix code it had never opened.
 *
 * `verifyFast` already scoped by touched files, but only in principle: it
 * compared absolute paths against workspace-relative project dirs, which never
 * matched, so every step check quietly widened to the whole tree too.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join } from "path";
import {
  CommandVerifier,
  detectProjects,
  projectsForRun,
  relativizeTouched,
} from "../../../packages/orchestrator/src/verifier";

/**
 * A folder of unrelated projects with a plain static site beside them — the
 * shape a person gets by running the agent in their general "code" directory.
 */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rune-scope-"));
  await mkdir(join(root, "site"), { recursive: true });
  await writeFile(join(root, "site", "index.html"), "<h1>shop</h1>");
  await writeFile(join(root, "site", "styles.css"), "body{}");
  await mkdir(join(root, "api"), { recursive: true });
  await writeFile(join(root, "api", "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  await mkdir(join(root, "cruncher"), { recursive: true });
  await writeFile(join(root, "cruncher", "requirements.txt"), "pandas\n");
  await mkdir(join(root, "cruncher", "tests"), { recursive: true });
  await writeFile(join(root, "cruncher", "tests", "test_it.py"), "import pandas\n");
  return root;
}

describe("relativizeTouched", () => {
  test("absolute, ~-prefixed and dot-relative paths all land on the same relative path", () => {
    const root = join(homedir(), "Project", "code");
    expect(relativizeTouched(root, [join(root, "site/index.html")])).toEqual(["site/index.html"]);
    expect(relativizeTouched(root, ["~/Project/code/site/index.html"])).toEqual([
      "site/index.html",
    ]);
    expect(relativizeTouched(root, ["./site/index.html"])).toEqual(["site/index.html"]);
    expect(relativizeTouched(root, ["site/index.html"])).toEqual(["site/index.html"]);
  });

  test("files outside the workspace, and the root itself, are dropped", () => {
    const root = join(homedir(), "Project", "code");
    expect(relativizeTouched(root, ["/etc/hosts", join(homedir(), "notes.md"), root])).toEqual([]);
  });

  test("duplicates and blanks collapse", () => {
    const root = "/ws";
    expect(relativizeTouched(root, ["a.ts", "/ws/a.ts", "./a.ts", "", "  "])).toEqual(["a.ts"]);
  });
});

describe("projectsForRun", () => {
  test("a run inside one project selects only that project", async () => {
    const root = await workspace();
    const projects = detectProjects(root);
    const dirs = projects.map((p) => p.dir).sort();
    expect(dirs).toEqual(["api", "cruncher"]);

    const picked = projectsForRun(projects, relativizeTouched(root, [join(root, "api/index.js")]));
    expect(picked.map((p) => p.dir)).toEqual(["api"]);
    await rm(root, { recursive: true, force: true });
  });

  test("files that belong to no project select nothing — the siblings are not it", async () => {
    const root = await workspace();
    const projects = detectProjects(root);
    const touched = relativizeTouched(root, [
      join(root, "site/index.html"),
      join(root, "site/styles.css"),
    ]);
    expect(touched).toHaveLength(2);
    expect(projectsForRun(projects, touched)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  test("a run spanning two projects selects both", async () => {
    const root = await workspace();
    const projects = detectProjects(root);
    const picked = projectsForRun(
      projects,
      relativizeTouched(root, [join(root, "api/a.js"), join(root, "cruncher/b.py")]),
    );
    expect(picked.map((p) => p.dir).sort()).toEqual(["api", "cruncher"]);
    await rm(root, { recursive: true, force: true });
  });

  test("a file inside a nested project belongs to the inner one, not the root", () => {
    const projects = [
      { ecosystem: "js", dir: "", marker: "package.json", checks: [] },
      { ecosystem: "go", dir: "services/api", marker: "go.mod", checks: [] },
    ] as any;
    expect(projectsForRun(projects, ["services/api/main.go"]).map((p: any) => p.dir)).toEqual([
      "services/api",
    ]);
    expect(projectsForRun(projects, ["README.md"]).map((p: any) => p.dir)).toEqual([""]);
  });
});

describe("CommandVerifier.verify scoping", () => {
  test("a run that wrote only static files runs NO sibling checks", async () => {
    const root = await workspace();
    const result = await new CommandVerifier({ workspaceRoot: root }).verify(undefined, [
      join(root, "site/index.html"),
      join(root, "site/styles.css"),
    ]);

    // Not one command was even attempted — `runs` records skipped checks too,
    // so an empty list is proof the siblings were never considered.
    expect(result.runs ?? []).toEqual([]);
    expect(result.ran).toBe(false);
    // And the report says the true thing: static files, no project. That is the
    // signal the doctrine already teaches, instead of a stranger's red test.
    expect(result.report).toContain("Nothing runnable detected");
    await rm(root, { recursive: true, force: true });
  });

  test("with no file list the whole workspace is still graded — unchanged for every other caller", async () => {
    const root = await workspace();
    const v = new CommandVerifier({ workspaceRoot: root });
    // Selection only: asserting the commands would run npm/python here.
    const projects = detectProjects(root);
    expect(projects.flatMap((p) => p.checks).length).toBeGreaterThan(0);
    // An empty list is "no information", not "nothing matched".
    expect(relativizeTouched(root, [])).toEqual([]);
    expect((await v.verify(undefined, ["/somewhere/else/x.ts"])).runs?.length ?? 0).toBeGreaterThan(
      0,
    );
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  test("an explicit [verify] commands override is never narrowed", async () => {
    const root = await workspace();
    const result = await new CommandVerifier({ workspaceRoot: root, commands: ["true"] }).verify(
      undefined,
      [join(root, "site/index.html")],
    );
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});

describe("projectsForRun — one directory, several ecosystems", () => {
  // This repository: package.json and Cargo.toml side by side at the root.
  const projects = [
    { ecosystem: "js", dir: "", marker: "package.json", checks: [] },
    { ecosystem: "rust", dir: "", marker: "Cargo.toml", checks: [] },
    { ecosystem: "go", dir: "services/api", marker: "go.mod", checks: [] },
  ] as any;

  test("a root-level edit is owned by EVERY project at the root, so cargo check is not dropped", () => {
    const owners = projectsForRun(projects, ["crates/tools/src/main.rs"]);
    expect(owners.map((p: any) => p.ecosystem).sort()).toEqual(["js", "rust"]);
  });

  test("a nested project still shadows the root for its own files", () => {
    expect(projectsForRun(projects, ["services/api/main.go"]).map((p: any) => p.ecosystem)).toEqual(
      ["go"],
    );
  });

  test("a run that touched both levels grades all three", () => {
    const owners = projectsForRun(projects, ["README.md", "services/api/main.go"]);
    expect(owners.map((p: any) => p.ecosystem).sort()).toEqual(["go", "js", "rust"]);
  });
});

describe("relativizeTouched — edges", () => {
  test("the parent of the workspace, and the root itself, are outside it", () => {
    expect(relativizeTouched("/ws/app", ["/ws/app/..", "/ws", "/ws/app"])).toEqual([]);
  });

  test.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
    "on a case-blind file system a differently-cased spelling still lands inside the workspace",
    () => {
      const root = join(homedir(), "Project", "Alan");
      const other = join(homedir(), "project", "alan", "packages", "shared", "src", "x.ts");
      expect(relativizeTouched(root, [other])).toEqual(["packages/shared/src/x.ts"]);
    },
  );
});
