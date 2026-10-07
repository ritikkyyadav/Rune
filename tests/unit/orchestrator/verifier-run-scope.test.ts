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

import { afterEach, describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtemp, mkdir, rename, unlink, utimes, writeFile, rm } from "fs/promises";
import { tmpdir, homedir } from "os";
import { dirname, join } from "path";
import {
  CommandVerifier,
  detectProjects,
  projectsForRun,
  relativizeTouched,
  type DetectedProject,
} from "../../../packages/orchestrator/src/verifier";
import {
  scriptEcosystemOf,
  selectProjects,
  type ScopeFacts,
} from "../../../packages/orchestrator/src/verify-scope";

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

// ─── V3 — which co-owners a change selects ───
//
// The review's probe, on a root holding `package.json` and `Cargo.toml`:
// touching `app.ts` selected both ecosystems, so a one-line TypeScript edit
// ran `cargo check` and `cargo test`. Ownership is still decided by directory
// (above); what follows is the layer that leaves a co-owner out when — and
// only when — it has a reason to.

const proj = (ecosystem: string, dir: string): DetectedProject =>
  ({ ecosystem, dir, marker: "m", checks: [] }) as unknown as DetectedProject;

/** A JS project and a Rust one sharing the root, with a Go service below. */
const MIXED = [proj("js", ""), proj("rust", ""), proj("go", "services/api")];

/** Facts for a tree where no build file calls anything and nothing else moved. */
const QUIET: ScopeFacts = {
  callsToolchain: () => false,
  readsDocumentation: () => false,
  changedElsewhere: () => [],
};

const picked = (projects: DetectedProject[], touched: string[], facts: ScopeFacts = QUIET) =>
  selectProjects(projects, touched, facts)
    .projects.map((p) => `${p.ecosystem}@${p.dir}`)
    .sort();

describe("selectProjects — a shared directory", () => {
  test("an isolated TypeScript edit does not select the Rust project beside it", () => {
    expect(picked(MIXED, ["packages/app/src/index.ts"])).toEqual(["js@"]);
    expect(picked(MIXED, ["app.tsx", "lib/util.mjs"])).toEqual(["js@"]);
  });

  test("…and the record says which project was left out, and why", () => {
    const { decisions } = selectProjects(MIXED, ["app.ts"], QUIET);
    expect(decisions.map((d) => [d.ecosystem, d.selected])).toEqual([
      ["js", true],
      ["rust", false],
    ]);
    const rust = decisions.find((d) => d.ecosystem === "rust")!;
    expect(rust.reason).toContain("only JS/TS sources or manifests changed");
    expect(rust.reason).toContain("the workspace root");
  });

  test("a Rust edit keeps Rust — and keeps JS, which may consume what Rust builds", () => {
    expect(picked(MIXED, ["crates/tools/src/main.rs"])).toEqual(["js@", "rust@"]);
  });

  test("a JS manifest is JS's; a Cargo manifest keeps both", () => {
    for (const f of ["package.json", "bun.lock", "tsconfig.json", "tsconfig.build.json"]) {
      expect(picked(MIXED, [f])).toEqual(["js@"]);
    }
    for (const f of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "build.rs"]) {
      expect(picked(MIXED, [f])).toEqual(["js@", "rust@"]);
    }
  });

  test("a shared schema, a build script or CI configuration exercises both", () => {
    for (const f of [
      "schema/events.proto",
      "api/openapi.yaml",
      "data/fixtures.json",
      "db/001_init.sql",
      "Makefile",
      "Dockerfile",
      ".github/workflows/ci.yml",
      "scripts/build.sh",
      ".env.example",
      "assets/logo.svg",
      "templates/page.html",
    ]) {
      expect(picked(MIXED, [f])).toEqual(["js@", "rust@"]);
    }
  });

  test("documentation selects only the projects whose checks read documentation", () => {
    // Nobody reads it: no check is bound to the change, and that is recorded
    // as a decision rather than as "nothing here is a project".
    const none = selectProjects(MIXED, ["README.md"], QUIET);
    expect(none.projects).toEqual([]);
    expect(none.documentationOnly).toBe(true);
    expect(none.decisions.map((d) => [d.ecosystem, d.selected])).toEqual([
      ["js", false],
      ["rust", false],
    ]);
    expect(none.decisions[0]!.reason).toContain("only documentation changed");

    // The crate compiles its README into a doctest: Rust is kept, JS is not.
    const doctest: ScopeFacts = { ...QUIET, readsDocumentation: (p) => p.ecosystem === "rust" };
    expect(picked(MIXED, ["README.md"], doctest)).toEqual(["rust@"]);
    expect(selectProjects(MIXED, ["README.md"], doctest).documentationOnly).toBe(false);
  });

  test("documentation beside code is not 'documentation only'", () => {
    const both = selectProjects(MIXED, ["README.md", "app.ts"], QUIET);
    expect(both.projects.map((p) => p.ecosystem)).toEqual(["js"]);
    expect(both.documentationOnly).toBe(false);
  });

  test("a single owner is still left out for prose — a README is not its code", () => {
    const out = selectProjects([proj("rust", "")], ["docs/guide.md", "CHANGELOG.md"], QUIET);
    expect(out.projects).toEqual([]);
    expect(out.documentationOnly).toBe(true);
  });

  test("documentation that belongs to no project is not a decision at all", () => {
    const out = selectProjects([proj("js", "app")], ["notes/README.md"], QUIET);
    expect(out.projects).toEqual([]);
    expect(out.documentationOnly).toBe(false);
  });

  test("an unknown format does not evade checks", () => {
    expect(picked(MIXED, ["blob.bin"])).toEqual(["js@", "rust@"]);
    expect(picked(MIXED, ["NOTES"])).toEqual(["js@", "rust@"]);
  });

  test("one file that needs a project is enough, whatever the others are", () => {
    expect(picked(MIXED, ["app.ts", "data/fixtures.json"])).toEqual(["js@", "rust@"]);
    expect(picked(MIXED, ["app.ts", "src/lib.rs"])).toEqual(["js@", "rust@"]);
  });

  test("a build file that calls the JS toolchain keeps its project", () => {
    const facts: ScopeFacts = {
      ...QUIET,
      callsToolchain: (p, tool) => p.ecosystem === "rust" && tool === "js",
    };
    expect(picked(MIXED, ["app.ts"], facts)).toEqual(["js@", "rust@"]);
  });

  test("Go beside JS is never dropped; Python beside JS is never dropped", () => {
    expect(picked([proj("js", ""), proj("go", "")], ["web/app.ts"])).toEqual(["go@", "js@"]);
    expect(picked([proj("js", ""), proj("python", "")], ["web/app.ts"])).toEqual([
      "js@",
      "python@",
    ]);
  });

  test("a Python edit beside a Rust crate drops Rust only when Rust does not call Python", () => {
    const both = [proj("python", ""), proj("rust", "")];
    expect(picked(both, ["pkg/core.py"])).toEqual(["python@"]);
    expect(picked(both, ["pyproject.toml"])).toEqual(["python@"]);
    const pyo3: ScopeFacts = {
      ...QUIET,
      callsToolchain: (p, tool) => p.ecosystem === "rust" && tool === "python",
    };
    expect(picked(both, ["pkg/core.py"], pyo3)).toEqual(["python@", "rust@"]);
  });

  test("a script source of an ecosystem that does not own the directory keeps every owner", () => {
    // A Python helper in a JS + Rust root: nothing is known about who runs it.
    expect(picked(MIXED, ["tools/gen.py"])).toEqual(["js@", "rust@"]);
  });

  test("nested ownership survives: the inner project shadows the root for its files", () => {
    expect(picked(MIXED, ["services/api/main.go"])).toEqual(["go@services/api"]);
    expect(picked(MIXED, ["services/api/main.go", "app.ts"])).toEqual(["go@services/api", "js@"]);
    // A TypeScript file INSIDE the Go service is the Go project's to check.
    expect(picked(MIXED, ["services/api/web/app.ts"])).toEqual(["go@services/api"]);
  });

  test("a single owner is never second-guessed", () => {
    expect(picked([proj("rust", "")], ["app.ts"])).toEqual(["rust@"]);
    expect(picked([proj("jvm", "svc")], ["svc/web/app.ts"])).toEqual(["jvm@svc"]);
  });

  test("a removed or renamed file is judged by its path, like any other", () => {
    // Selection never asks whether the path still exists.
    expect(picked(MIXED, ["src/gone.rs"])).toEqual(["js@", "rust@"]);
    expect(picked(MIXED, ["src/gone.ts"])).toEqual(["js@"]);
    // Both sides of a move, across the ownership boundary.
    expect(picked(MIXED, ["lib/old.ts", "services/api/new.go"])).toEqual([
      "go@services/api",
      "js@",
    ]);
  });
});

describe("selectProjects — what else changed in the tree", () => {
  const elsewhere = (...files: string[]): ScopeFacts => ({
    ...QUIET,
    changedElsewhere: () => files,
  });

  test("a Rust file changed outside the edit tools keeps Rust, and the record names it", () => {
    const { projects, decisions } = selectProjects(MIXED, ["app.ts"], elsewhere("src/lib.rs"));
    expect(projects.map((p) => p.ecosystem).sort()).toEqual(["js", "rust"]);
    expect(decisions.find((d) => d.ecosystem === "rust")!.reason).toContain("src/lib.rs");
  });

  test("so does a schema, a generated file of unknown kind, or a Cargo manifest", () => {
    for (const f of ["schema.proto", "gen/out.bin", "Cargo.toml"]) {
      expect(picked(MIXED, ["app.ts"], elsewhere(f))).toEqual(["js@", "rust@"]);
    }
  });

  test("prose changing elsewhere keeps only a project that reads prose", () => {
    expect(picked(MIXED, ["app.ts"], elsewhere("README.md"))).toEqual(["js@"]);
    const doctest: ScopeFacts = {
      ...elsewhere("README.md"),
      readsDocumentation: (p) => p.ecosystem === "rust",
    };
    expect(picked(MIXED, ["app.ts"], doctest)).toEqual(["js@", "rust@"]);
  });

  test("a README edit with source changed by a shell beside it is not documentation only", () => {
    const out = selectProjects(MIXED, ["README.md"], elsewhere("src/lib.rs"));
    expect(out.projects.map((p) => p.ecosystem).sort()).toEqual(["js", "rust"]);
    expect(out.documentationOnly).toBe(false);
  });

  test("another TypeScript file changing elsewhere does not bring Rust back", () => {
    expect(picked(MIXED, ["app.ts"], elsewhere("other.ts", "package.json"))).toEqual(["js@"]);
  });

  test("a change in a project the run never touched does not add that project", () => {
    // The sibling's dirt is not this run's work; narrowing never widens.
    expect(picked(MIXED, ["app.ts"], elsewhere("services/api/main.go"))).toEqual(["js@"]);
  });

  test("a tree that cannot be inspected is not narrowed at all", () => {
    const blind: ScopeFacts = { ...QUIET, changedElsewhere: () => null };
    const { projects, decisions } = selectProjects(MIXED, ["app.ts"], blind);
    expect(projects.map((p) => p.ecosystem).sort()).toEqual(["js", "rust"]);
    expect(decisions.find((d) => d.ecosystem === "rust")!.reason).toContain(
      "could not be inspected",
    );
  });

  test("the tree is asked only when a drop is on the table, and only once", () => {
    let asked = 0;
    const counting: ScopeFacts = {
      ...QUIET,
      changedElsewhere: () => (asked++, []),
    };
    selectProjects(MIXED, ["src/lib.rs", "Cargo.toml"], counting);
    expect(asked).toBe(0);
    selectProjects(MIXED, ["a.ts", "b.ts", "c.ts"], counting);
    expect(asked).toBe(1);
  });

  test("the selection is always a subset of the owners — it never selects more", () => {
    const facts = elsewhere("src/lib.rs", "services/api/main.go", "x.json");
    for (const touched of [
      ["app.ts"],
      ["README.md"],
      ["src/lib.rs"],
      ["services/api/main.go"],
      ["app.ts", "services/api/web/x.ts"],
      ["site/index.html"],
      [],
    ]) {
      const owners = new Set(projectsForRun(MIXED, touched));
      for (const p of selectProjects(MIXED, touched, facts).projects) {
        expect(owners.has(p)).toBe(true);
      }
    }
  });
});

describe("scriptEcosystemOf", () => {
  test.each([
    ["src/a.ts", "js"],
    ["src/a.test.tsx", "js"],
    ["a.cjs", "js"],
    ["App.vue", "js"],
    ["packages/x/package.json", "js"],
    ["tsconfig.base.json", "js"],
    ["pkg/a.py", "python"],
    ["stubs/a.pyi", "python"],
    ["requirements-dev.txt", "python"],
    ["src/lib.rs", null],
    ["Cargo.toml", null],
    ["main.go", null],
    ["data.json", null],
    ["README.md", null],
    ["notes.txt", null],
    ["page.html", null],
    ["a.tsbuildinfo", null],
  ])("%s → %s", (file, expected) => {
    expect(scriptEcosystemOf(file)).toBe(expected as ReturnType<typeof scriptEcosystemOf>);
  });
});

// ─── The same, through a real verifier on a real tree ───

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

async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
}

/**
 * A committed tree with a JS project and a Rust crate at its root. Each
 * ecosystem's checks are overridden to one harmless marker command, so what
 * ran is readable and no toolchain is needed.
 */
const mixedRoots: string[] = [];
afterEach(async () => {
  // Pass or fail: a red assertion must not leave a repository in the temp dir.
  for (const dir of mixedRoots.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function mixedRoot(opts: { git?: boolean; buildRs?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rune-mixed-"));
  mixedRoots.push(root);
  await put(root, {
    "package.json": JSON.stringify({ name: "app", scripts: { typecheck: "true" } }),
    "bun.lock": "",
    "Cargo.toml": '[package]\nname = "tools"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/lib.rs": "pub fn one() -> u8 { 1 }\n",
    "src/old.rs": "pub fn old() {}\n",
    "app.ts": "export const a = 1;\n",
    "README.md": "# app\n",
    ...(opts.buildRs ? { "build.rs": opts.buildRs } : {}),
  });
  if (opts.git !== false) {
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
  }
  return root;
}

const ECOSYSTEMS = { js: { commands: ["echo js-check"] }, rust: { commands: ["echo rust-check"] } };
const mixedVerifier = (root: string, sessionStartMs = Date.now()) =>
  new CommandVerifier({ workspaceRoot: root, ecosystems: ECOSYSTEMS, sessionStartMs });
const ran = (r: { runs?: Array<{ command: string }> }) => (r.runs ?? []).map((x) => x.command);

describe("CommandVerifier — a shared root, end to end", () => {
  test("a TypeScript edit runs the JS check and not the Rust one, and records why", async () => {
    const root = await mixedRoot();
    const r = await mixedVerifier(root).verify(undefined, [join(root, "app.ts")]);
    expect(ran(r)).toEqual(["echo js-check"]);
    expect(r.status).toBe("passed");
    expect(r.selection?.scope).toBe("touched");
    expect(r.selection?.commands).toEqual(["echo js-check"]);
    const rust = r.selection!.decisions.find((d) => d.ecosystem === "rust")!;
    expect(rust.selected).toBe(false);
    expect(rust.reason).toContain("not run");
    await rm(root, { recursive: true, force: true });
  });

  test("a Rust edit runs both", async () => {
    const root = await mixedRoot();
    const r = await mixedVerifier(root).verify(undefined, [join(root, "src/lib.rs")]);
    expect(ran(r).sort()).toEqual(["echo js-check", "echo rust-check"]);
    await rm(root, { recursive: true, force: true });
  });

  test("a build.rs that runs npm keeps the Rust check for a TypeScript edit", async () => {
    const root = await mixedRoot({
      buildRs: 'fn main() { std::process::Command::new("npm").arg("run").arg("build"); }\n',
    });
    const r = await mixedVerifier(root).verify(undefined, [join(root, "app.ts")]);
    expect(ran(r).sort()).toEqual(["echo js-check", "echo rust-check"]);
    await rm(root, { recursive: true, force: true });
  });

  test("a crate NAMED after a script language is not a call to its toolchain", async () => {
    const root = await mixedRoot();
    await put(root, {
      "Cargo.toml":
        '[package]\nname = "tools"\nversion = "0.1.0"\n\n[dependencies]\ntree-sitter-javascript = "0.23"\nnode-semver-rs = "1"\n',
    });
    git(root, "commit", "-qam", "deps");
    const r = await mixedVerifier(root).verify(undefined, [join(root, "app.ts")]);
    expect(ran(r)).toEqual(["echo js-check"]);
    await rm(root, { recursive: true, force: true });
  });

  test("a Rust file rewritten by a shell command — never listed — still gets its check", async () => {
    const root = await mixedRoot();
    const v = mixedVerifier(root);
    await writeFile(join(root, "src/lib.rs"), "pub fn one() -> u8 { 2 }\n"); // `sed -i`
    const r = await v.verify(undefined, [join(root, "app.ts")]);
    expect(ran(r).sort()).toEqual(["echo js-check", "echo rust-check"]);
    expect(r.selection!.decisions.find((d) => d.ecosystem === "rust")!.reason).toContain(
      "src/lib.rs",
    );
    await rm(root, { recursive: true, force: true });
  });

  test("a Rust file REMOVED by a shell command still gets its check", async () => {
    const root = await mixedRoot();
    const v = mixedVerifier(root);
    await unlink(join(root, "src/old.rs")); // `rm`
    const r = await v.verify(undefined, [join(root, "app.ts")]);
    expect(ran(r).sort()).toEqual(["echo js-check", "echo rust-check"]);
    await rm(root, { recursive: true, force: true });
  });

  test("a Rust file RENAMED by a shell command still gets its check — `mv` keeps its mtime", async () => {
    const root = await mixedRoot();
    // The session starts well after the files were written, so only a change
    // made from here on can count. The old path is gone (it cannot be dated);
    // the new one carries an old mtime and a new change time.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const v = mixedVerifier(root);
    await rename(join(root, "src/old.rs"), join(root, "src/renamed.rs")); // `mv`
    const r = await v.verify(undefined, [join(root, "app.ts")]);
    expect(ran(r).sort()).toEqual(["echo js-check", "echo rust-check"]);
    await rm(root, { recursive: true, force: true });
  }, 15_000);

  test("a new Rust file whose modification time was set into the past still counts — the change time cannot be", async () => {
    // `cp -p`, `tar -x`, `git checkout` and `touch -t` all leave an old mtime
    // on a file that only just appeared. Its inode change time is now.
    const root = await mixedRoot();
    const v = mixedVerifier(root);
    await put(root, { "src/generated.rs": "pub fn g() {}\n" });
    const longAgo = new Date(Date.now() - 86_400_000);
    await utimes(join(root, "src/generated.rs"), longAgo, longAgo);
    const r = await v.verify(undefined, [join(root, "app.ts")]);
    expect(ran(r).sort()).toEqual(["echo js-check", "echo rust-check"]);
    await rm(root, { recursive: true, force: true });
  });

  test("a Rust file that was already dirty when the session began does not hold the check", async () => {
    const root = await mixedRoot();
    await writeFile(join(root, "src/lib.rs"), "pub fn one() -> u8 { 3 }\n"); // the person's own WIP
    // The session begins after that edit, by more than any clock's slack.
    const r = await mixedVerifier(root, Date.now() + 10_000).verify(undefined, [
      join(root, "app.ts"),
    ]);
    expect(ran(r)).toEqual(["echo js-check"]);
    await rm(root, { recursive: true, force: true });
  });

  test("Rune's own files in the workspace are not a change to the work", async () => {
    const root = await mixedRoot();
    const v = mixedVerifier(root);
    await put(root, { ".rune/mission.md": "# mission\n", ".rune/tool-children.jsonl": "{}\n" });
    const r = await v.verify(undefined, [join(root, "app.ts")]);
    expect(ran(r)).toEqual(["echo js-check"]);
    await rm(root, { recursive: true, force: true });
  });

  test("with no git to ask, nothing is left out", async () => {
    const root = await mixedRoot({ git: false });
    const r = await mixedVerifier(root).verify(undefined, [join(root, "app.ts")]);
    expect(ran(r).sort()).toEqual(["echo js-check", "echo rust-check"]);
    expect(r.selection!.decisions.find((d) => d.ecosystem === "rust")!.reason).toContain(
      "could not be inspected",
    );
    await rm(root, { recursive: true, force: true });
  });

  test("the step check is narrowed the same way", async () => {
    const root = await mixedRoot();
    const fast = {
      js: { commands: ["echo js tsc"] },
      rust: { commands: ["echo rust cargo check"] },
    };
    const v = new CommandVerifier({ workspaceRoot: root, ecosystems: fast });
    expect(ran(await v.verifyFast!(undefined, [join(root, "app.ts")]))).toEqual(["echo js tsc"]);
    expect(ran(await v.verifyFast!(undefined, [join(root, "src/lib.rs")])).sort()).toEqual([
      "echo js tsc",
      "echo rust cargo check",
    ]);
    await rm(root, { recursive: true, force: true });
  });

  test("an explicit [verify] commands override is still never narrowed", async () => {
    const root = await mixedRoot();
    const r = await new CommandVerifier({
      workspaceRoot: root,
      commands: ["echo user-said-so"],
    }).verify(undefined, [join(root, "app.ts")]);
    expect(ran(r)).toEqual(["echo user-said-so"]);
    expect(r.selection?.scope).toBe("override");
    await rm(root, { recursive: true, force: true });
  });

  test("a repair turn's impacted set is recorded as such", async () => {
    const root = await mixedRoot();
    const r = await mixedVerifier(root).verify(
      undefined,
      [join(root, "src/lib.rs")],
      ["echo rust-check"],
    );
    expect(ran(r)).toEqual(["echo rust-check"]);
    expect(r.selection?.scope).toBe("impacted");
    await rm(root, { recursive: true, force: true });
  });
});

describe("the selection reaches the run's own record", () => {
  test("a project judged unaffected is written to the task log, by name and reason", async () => {
    const { TaskStateStore } = await import("../../../packages/orchestrator/src/task-state");
    const root = await mixedRoot();
    const r = await mixedVerifier(root).verify(undefined, [join(root, "app.ts")]);
    const ts = new TaskStateStore();
    ts.beginTurn("g");
    ts.noteVerification({ status: r.status! }, r.report, r.runs, { selection: r.selection });
    const log = (ts.snapshot().log ?? []).map((e) => e.text);
    expect(
      log.some((t) => t.includes("project checks passed") && t.includes("echo js-check")),
    ).toBe(true);
    expect(log.some((t) => t.startsWith("rust at the workspace root not run:"))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});

describe("CommandVerifier — a documentation-only change", () => {
  test("no check is required, and it is said as a decision — not a pass, not 'nothing runnable'", async () => {
    const root = await mixedRoot();
    const v = mixedVerifier(root);
    v.beginChanges();
    await writeFile(join(root, "README.md"), "# app\n\nmore words\n");
    const r = await v.verify(undefined, [join(root, "README.md")]);
    expect(ran(r)).toEqual([]);
    expect(r.status).toBe("inconclusive");
    expect(r.reason).toBe("not_required");
    expect(r.passed).toBe(false);
    expect(r.report).toContain("only documentation changed");
    expect(r.selection!.decisions.every((d) => !d.selected)).toBe(true);
  });

  test("a new report file is documentation too", async () => {
    const root = await mixedRoot();
    const v = mixedVerifier(root);
    v.beginChanges();
    await put(root, { "REVIEW.md": "# Review\n\n- finding one\n" });
    const r = await v.verify(undefined, [join(root, "REVIEW.md")]);
    expect(r.reason).toBe("not_required");
  });

  test("a lint script that reads markdown keeps the JS check", async () => {
    const root = await mixedRoot();
    await put(root, {
      "package.json": JSON.stringify({ name: "app", scripts: { lint: "markdownlint ." } }),
    });
    git(root, "commit", "-qam", "lint reads prose");
    const v = mixedVerifier(root);
    v.beginChanges();
    await writeFile(join(root, "README.md"), "# app\n\nmore words\n");
    expect(ran(await v.verify(undefined, [join(root, "README.md")]))).toEqual(["echo js-check"]);
  });

  test("a script that fans out to other packages keeps it too: what they run is not visible", async () => {
    const root = await mixedRoot();
    await put(root, {
      "package.json": JSON.stringify({ name: "app", scripts: { lint: "turbo lint" } }),
    });
    git(root, "commit", "-qam", "turbo");
    const v = mixedVerifier(root);
    v.beginChanges();
    await writeFile(join(root, "README.md"), "# app\n\nmore words\n");
    expect(ran(await v.verify(undefined, [join(root, "README.md")]))).toEqual(["echo js-check"]);
  });

  test("a crate that compiles its README into a doctest keeps the Rust check", async () => {
    const root = await mixedRoot();
    await put(root, {
      "src/lib.rs": '#![doc = include_str!("../README.md")]\npub fn one() -> u8 { 1 }\n',
    });
    git(root, "commit", "-qam", "doctest the readme");
    const v = mixedVerifier(root);
    v.beginChanges();
    await writeFile(join(root, "README.md"), "# app\n\nmore words\n");
    expect(ran(await v.verify(undefined, [join(root, "README.md")]))).toEqual(["echo rust-check"]);
  });

  test("source rewritten by a shell beside the README: the checks run", async () => {
    const root = await mixedRoot();
    const v = mixedVerifier(root);
    v.beginChanges();
    await writeFile(join(root, "README.md"), "# app\n\nmore words\n");
    await writeFile(join(root, "app.ts"), "export const a = 2;\n"); // `sed -i`, never listed
    const r = await v.verify(undefined, [join(root, "README.md")]);
    expect(ran(r)).toEqual(["echo js-check"]);
    expect(r.status).toBe("passed");
  });

  test("with no git to confirm that nothing else changed, the checks run", async () => {
    const root = await mixedRoot({ git: false });
    const r = await mixedVerifier(root).verify(undefined, [join(root, "README.md")]);
    expect(ran(r).sort()).toEqual(["echo js-check", "echo rust-check"]);
  });

  test("documentation in a folder that is no project is still 'nothing runnable'", async () => {
    const root = await workspace();
    await put(root, { "site/NOTES.md": "notes\n" });
    const r = await new CommandVerifier({ workspaceRoot: root }).verify(undefined, [
      join(root, "site/NOTES.md"),
    ]);
    expect(r.reason).toBe("no_checks");
    await rm(root, { recursive: true, force: true });
  });

  test("an explicit [verify] commands override still runs for a README", async () => {
    const root = await mixedRoot();
    const r = await new CommandVerifier({
      workspaceRoot: root,
      commands: ["echo user-said-so"],
    }).verify(undefined, [join(root, "README.md")]);
    expect(ran(r)).toEqual(["echo user-said-so"]);
  });
});
