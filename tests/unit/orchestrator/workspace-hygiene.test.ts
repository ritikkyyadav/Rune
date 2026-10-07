/**
 * H1 — what Rune writes while it works does not go in the user's code.
 *
 * The mission file was `<workspace>/.rune/mission.md`: one path for every
 * session in the repository, inside the tree the run is working on, in a
 * directory that also holds things the person owns. It now lives under the
 * session's own directory in the Rune home, and the model reads it at the same
 * name through `read_file` — a route, answered for that session only.
 *
 * Held here:
 *
 *   two sessions in one repository cannot overwrite each other's mission
 *   a resumed session reads its mission back
 *   nothing is created in the workspace, and what the person keeps in `.rune/`
 *     is left byte for byte as it was
 *   the route is ONE path — it is not a way to read anything else in the home
 *
 * and the same for the build state a check run generates: a first `cargo
 * check` or a Python compile leaves no directory behind in the task tree.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  MISSION_ROUTE,
  isMissionRoute,
  missionFilePath,
  readMission,
  withMissionRoute,
  writeMission,
} from "../../../packages/orchestrator/src/mission-file";
import { generatedStateEnv } from "../../../packages/orchestrator/src/verifier";
import type {
  ToolCallInput,
  ToolCallOutput,
  ToolHandler,
} from "../../../packages/tool-registry/src/types";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
function put(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}
/** Every file under `root`, with a hash of its bytes. */
function manifest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path, name);
      else out[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root, "");
  return out;
}

/** The real `read_file`, as far as this file needs it: it reads the workspace, and says what it was asked. */
function realRead(asked: string[]): ToolHandler {
  return {
    schema: {
      name: "read_file",
      version: "0.1.0",
      description: "",
      inputSchema: { type: "object", properties: {} },
      permissionLevel: "auto",
      category: "read",
    },
    validate: () => ({ valid: true }),
    async execute(input: ToolCallInput): Promise<ToolCallOutput> {
      const path = String(input.args.path);
      asked.push(path);
      const abs = path.startsWith("/") ? path : join(input.workspaceRoot, path);
      const base = { callId: input.callId, toolName: input.toolName, durationMs: 1 };
      if (!existsSync(abs))
        return { ...base, success: false, result: "", error: `IO error at ${abs}` };
      return {
        ...base,
        success: true,
        result: JSON.stringify({ content: readFileSync(abs, "utf8"), path: abs }),
      };
    },
  } as ToolHandler;
}

function rig() {
  const home = scratch("rune-hygiene-home-");
  const workspace = scratch("rune-hygiene-ws-");
  const asked: string[] = [];
  const tool = withMissionRoute(realRead(asked), () => home);
  const read = async (sessionId: string, path: string, extra: Record<string, unknown> = {}) => {
    const out = await tool.execute({
      toolName: "read_file",
      callId: "c1",
      args: { path, ...extra },
      sessionId,
      workspaceRoot: workspace,
    });
    return {
      ...out,
      body: out.success ? (JSON.parse(out.result) as Record<string, unknown>) : null,
    };
  };
  return { home, workspace, asked, read };
}

describe("the mission file belongs to the session, not to the workspace", () => {
  test("two sessions in one repository each keep, and each read back, their own mission", async () => {
    const { home, workspace, read } = rig();
    writeMission("session-a", "# Mission\n\nGoal: migrate the parser\n", home);
    writeMission("session-b", "# Mission\n\nGoal: fix the login redirect\n", home);
    // The later write did not replace the earlier one.
    expect(readMission("session-a", home)).toContain("migrate the parser");
    expect(readMission("session-b", home)).toContain("fix the login redirect");
    expect(missionFilePath("session-a", home)).not.toBe(missionFilePath("session-b", home));

    const a = await read("session-a", MISSION_ROUTE);
    const b = await read("session-b", MISSION_ROUTE);
    expect(String(a.body!.content)).toContain("migrate the parser");
    expect(String(a.body!.content)).not.toContain("login redirect");
    expect(String(b.body!.content)).toContain("fix the login redirect");
    expect(existsSync(join(workspace, ".rune"))).toBe(false);
  });

  test("nothing is created in the workspace", () => {
    const { home, workspace } = rig();
    put(workspace, { "src/a.ts": "export const a = 1;\n" });
    const before = manifest(workspace);
    for (let i = 0; i < 3; i++) writeMission("session-a", `# Mission\n\nrevision ${i}\n`, home);
    expect(manifest(workspace)).toEqual(before);
    expect(existsSync(join(workspace, ".rune"))).toBe(false);
  });

  test("what the person keeps in .rune/ is left byte for byte — an older mission file included", async () => {
    const { home, workspace, read } = rig();
    put(workspace, {
      ".rune/mcp.json": '{"servers":{}}\n',
      ".rune/skills/review/SKILL.md": "# my skill\n",
      ".rune/mission.md": "# Mission\n\nGoal: something an older version wrote\n",
    });
    const before = manifest(workspace);
    writeMission("session-a", "# Mission\n\nGoal: today's task\n", home);
    const out = await read("session-a", MISSION_ROUTE);
    // The session's own mission answers the route…
    expect(String(out.body!.content)).toContain("today's task");
    // …and the older file is neither read for it, rewritten nor removed.
    expect(manifest(workspace)).toEqual(before);
  });

  test("a resumed session reads its mission back: a new process, the same home and id", async () => {
    const { home, workspace } = rig();
    writeMission(
      "session-a",
      "# Mission\n\nGoal: migrate the parser\n\n## Log\n- step 1 closed\n",
      home,
    );
    // "Resume": nothing in memory survives; a fresh wrapper over the same home.
    const asked: string[] = [];
    const resumed = withMissionRoute(realRead(asked), () => home);
    const out = await resumed.execute({
      toolName: "read_file",
      callId: "c9",
      args: { path: MISSION_ROUTE },
      sessionId: "session-a",
      workspaceRoot: workspace,
    });
    expect(out.success).toBe(true);
    expect(out.result).toContain("step 1 closed");
    // Answered without the real tool ever being asked.
    expect(asked).toEqual([]);
  });

  test("a write is atomic: no partial file is left beside the mission", () => {
    const { home } = rig();
    writeMission("session-a", "x".repeat(50_000), home);
    writeMission("session-a", "y".repeat(50_000), home);
    expect(readdirSync(dirname(missionFilePath("session-a", home)))).toEqual(["mission.md"]);
    expect(readMission("session-a", home)).toBe("y".repeat(50_000));
  });
});

describe("the route is one path, not a way into the Rune home", () => {
  test("a session with no mission of its own is not handed another session's", async () => {
    const { home, read, asked } = rig();
    writeMission("session-a", "# Mission\n\nGoal: private to a\n", home);
    const out = await read("session-b", MISSION_ROUTE);
    // Falls through to the real tool, which finds no such file in the workspace.
    expect(out.success).toBe(false);
    expect(asked).toEqual([MISSION_ROUTE]);
  });

  test("a session id cannot name its way out of its own directory", () => {
    const home = scratch("rune-hygiene-home-");
    for (const id of ["../../etc", "..", "a/../../b", "/abs/olute", "", "..\\..\\x"]) {
      const path = missionFilePath(id, home);
      expect(path.startsWith(join(home, "sessions") + "/")).toBe(true);
      expect(path.endsWith("/mission.md")).toBe(true);
      // Exactly `<home>/sessions/<one segment>/mission.md`.
      expect(path.slice(join(home, "sessions").length + 1).split("/").length).toBe(2);
    }
  });

  test("nothing else under the home is readable through read_file by way of the route", async () => {
    const { home, read, asked } = rig();
    put(home, {
      "credentials.json": '{"token":"SECRET"}\n',
      "sessions/session-a/mission.md": "# Mission\n",
      "sessions/session-a/other.txt": "not the mission\n",
    });
    for (const path of [
      ".rune/credentials.json",
      ".rune/mission.md/../credentials.json",
      ".rune/other.txt",
      ".rune/sessions/session-a/other.txt",
      ".rune/mission.md.bak",
      ".rune/",
      ".rune",
    ]) {
      const out = await read("session-a", path);
      // Every one of these is the real tool's to answer, about the WORKSPACE.
      expect(out.success).toBe(false);
      expect(out.result).not.toContain("SECRET");
      expect(out.result).not.toContain("not the mission");
    }
    expect(asked.length).toBe(7);
  });

  test("the route is recognised however the model spells that one path", () => {
    const ws = "/Users/someone/project";
    for (const spelling of [
      ".rune/mission.md",
      "./.rune/mission.md",
      ".rune//mission.md",
      "src/../.rune/mission.md",
      "/Users/someone/project/.rune/mission.md",
      "  .rune/mission.md  ",
      ".rune\\mission.md",
    ]) {
      expect(isMissionRoute(ws, spelling)).toBe(true);
    }
    for (const other of [
      "mission.md",
      ".rune/mission.txt",
      "sub/.rune/mission.md",
      "/Users/someone/other/.rune/mission.md",
      "../project2/.rune/mission.md",
      join(homedir(), ".rune", "mission.md"),
      "",
      undefined,
      42,
      { path: ".rune/mission.md" },
    ]) {
      expect(isMissionRoute(ws, other)).toBe(false);
    }
  });

  test("the answer names the route, never where the file really is", async () => {
    const { home, read } = rig();
    writeMission("session-a", "# Mission\n\nGoal: x\n", home);
    const out = await read("session-a", MISSION_ROUTE);
    expect(out.body!.path).toBe(MISSION_ROUTE);
    expect(out.result).not.toContain(home);
  });
});

describe("the route answers the way read_file does", () => {
  test("numbered lines, the file's facts, and offset/limit", async () => {
    const { home, read } = rig();
    const text = "# Mission\n\nGoal: x\nline four\nline five\n";
    writeMission("session-a", text, home);
    const whole = await read("session-a", MISSION_ROUTE);
    expect(whole.body).toMatchObject({
      kind: "text",
      total_lines: 5,
      lines_shown: 5,
      offset: 0,
      truncated: false,
      bytes: Buffer.byteLength(text),
      hash: createHash("sha256").update(text).digest("hex"),
    });
    expect(String(whole.body!.content).split("\n")[0]).toBe("     1\t# Mission");
    expect(String(whole.body!.content).split("\n")[4]).toBe("     5\tline five");

    const part = await read("session-a", MISSION_ROUTE, { offset: 2, limit: 2 });
    expect(part.body).toMatchObject({ lines_shown: 2, offset: 2, truncated: true });
    expect(String(part.body!.content)).toBe("     3\tGoal: x\n     4\tline four");
  });

  test("every other read goes to the real tool, untouched", async () => {
    const { workspace, read, asked } = rig();
    put(workspace, { "src/a.ts": "export const a = 1;\n" });
    const out = await read("session-a", "src/a.ts", { offset: 0 });
    expect(out.success).toBe(true);
    expect(String(out.body!.content)).toContain("export const a");
    expect(asked).toEqual(["src/a.ts"]);
  });
});

// ─── The state a check run generates ───

describe("generatedStateEnv — a check's build state stays out of a project that has none", () => {
  const cache = () => "/cache";
  // An environment with nothing chosen — including no global cargo config, so
  // the answer does not depend on the machine these tests run on.
  const NONE = { CARGO_HOME: "/nonexistent-cargo-home" } as NodeJS.ProcessEnv;

  test("a crate that has never been built gets an external target directory", () => {
    const dir = scratch("rune-hygiene-crate-");
    put(dir, { "Cargo.toml": "[package]\nname='x'\n" });
    expect(generatedStateEnv(dir, "rust", NONE, cache)).toEqual({
      CARGO_TARGET_DIR: "/cache/cargo-target",
    });
  });

  test("a crate with a target/ of its own keeps it — it is the person's warm cache", () => {
    const dir = scratch("rune-hygiene-crate-");
    put(dir, { "Cargo.toml": "[package]\nname='x'\n", "target/.keep": "" });
    expect(generatedStateEnv(dir, "rust", NONE, cache)).toEqual({});
  });

  test("a workspace member uses the target/ at its workspace root", () => {
    const root = scratch("rune-hygiene-crate-");
    put(root, {
      "Cargo.toml": "[workspace]\nmembers=['crates/a']\n",
      "target/.keep": "",
      "crates/a/Cargo.toml": "[package]\nname='a'\n",
    });
    expect(generatedStateEnv(join(root, "crates/a"), "rust", NONE, cache)).toEqual({});
  });

  test("a choice already made is not overridden: the variable, or a cargo config", () => {
    const dir = scratch("rune-hygiene-crate-");
    put(dir, { "Cargo.toml": "[package]\nname='x'\n" });
    expect(generatedStateEnv(dir, "rust", { ...NONE, CARGO_TARGET_DIR: "/mine" }, cache)).toEqual(
      {},
    );
    expect(
      generatedStateEnv(dir, "rust", { ...NONE, CARGO_BUILD_TARGET_DIR: "/mine" }, cache),
    ).toEqual({});
    put(dir, { ".cargo/config.toml": '[build]\ntarget-dir = "/elsewhere"\n' });
    expect(generatedStateEnv(dir, "rust", NONE, cache)).toEqual({});
  });

  test("a config above the crate counts too; one that says nothing about target-dir does not", () => {
    const root = scratch("rune-hygiene-crate-");
    put(root, {
      ".cargo/config.toml": '[build]\ntarget-dir = "/elsewhere"\n',
      "crates/a/Cargo.toml": "[package]\nname='a'\n",
      "other/Cargo.toml": "[package]\nname='o'\n",
    });
    expect(generatedStateEnv(join(root, "crates/a"), "rust", NONE, cache)).toEqual({});
    const quiet = scratch("rune-hygiene-crate-");
    put(quiet, {
      ".cargo/config.toml": "[net]\noffline = true\n# target-dir is not set here\n",
      "Cargo.toml": "[package]\nname='q'\n",
    });
    expect(generatedStateEnv(quiet, "rust", NONE, cache)).toEqual({
      CARGO_TARGET_DIR: "/cache/cargo-target",
    });
  });

  test("a target-dir in the person's global cargo config is honoured", () => {
    const dir = scratch("rune-hygiene-crate-");
    put(dir, { "Cargo.toml": "[package]\nname='x'\n" });
    const cargoHome = scratch("rune-hygiene-cargo-home-");
    put(cargoHome, { "config.toml": '[build]\ntarget-dir = "/shared-target"\n' });
    expect(
      generatedStateEnv(dir, "rust", { CARGO_HOME: cargoHome } as NodeJS.ProcessEnv, cache),
    ).toEqual({});
  });

  test("Python: bytecode and the tool caches go outside, unless the project already has them", () => {
    const dir = scratch("rune-hygiene-py-");
    put(dir, { "pyproject.toml": "[project]\nname='x'\n" });
    expect(generatedStateEnv(dir, "python", NONE, cache)).toEqual({
      PYTHONPYCACHEPREFIX: "/cache/pycache",
      PYTEST_ADDOPTS: "-p no:cacheprovider",
      MYPY_CACHE_DIR: "/cache/mypy",
      RUFF_CACHE_DIR: "/cache/ruff",
    });
    put(dir, { ".pytest_cache/x": "", ".mypy_cache/x": "", ".ruff_cache/x": "" });
    expect(generatedStateEnv(dir, "python", NONE, cache)).toEqual({
      PYTHONPYCACHEPREFIX: "/cache/pycache",
    });
  });

  test("Python: every variable the person set is left as they set it", () => {
    const dir = scratch("rune-hygiene-py-");
    const theirs = {
      PYTHONPYCACHEPREFIX: "/a",
      PYTEST_ADDOPTS: "-q",
      MYPY_CACHE_DIR: "/b",
      RUFF_CACHE_DIR: "/c",
    } as NodeJS.ProcessEnv;
    expect(generatedStateEnv(dir, "python", theirs, cache)).toEqual({});
  });

  test("ecosystems with no supported switch are left alone, and the cache is not even made", () => {
    const dir = scratch("rune-hygiene-other-");
    let asked = 0;
    const counting = () => (asked++, "/cache");
    for (const eco of ["js", "go", "jvm"] as const) {
      expect(generatedStateEnv(dir, eco, NONE, counting)).toEqual({});
    }
    expect(asked).toBe(0);
  });
});
