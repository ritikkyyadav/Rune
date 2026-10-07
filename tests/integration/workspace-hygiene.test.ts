/**
 * H1, end to end — a real Engine, the real `read_file`, a scripted provider.
 *
 * `tests/unit/orchestrator/workspace-hygiene.test.ts` holds the mission route
 * to its rules in isolation. This file asks the questions only the whole thing
 * can answer:
 *
 *   does a run still leave `.rune/mission.md` in the workspace?
 *   does the model's `read_file(".rune/mission.md")` — through the engine's own
 *     registry and the native tool behind it — get THIS session's mission?
 *   do two sessions in one repository keep theirs apart?
 *   does a session resumed in a new process read its mission back?
 *
 * Zero live model calls: an in-process scripted provider under a scratch
 * RUNE_HOME. `~/.rune` is never opened.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import { Engine } from "../../packages/orchestrator/src/engine";
import { MISSION_ROUTE, missionFilePath } from "../../packages/orchestrator/src/mission-file";
import { CommandVerifier } from "../../packages/orchestrator/src/verifier";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { resolveRuneToolsBinary } from "../helpers/native-binary";
import { UsageProvider } from "../helpers/usage-provider";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const native = resolveRuneToolsBinary();

function git(root: string, args: string[]): void {
  const res = spawnSync(
    "git",
    ["-c", "user.name=H1", "-c", "user.email=h1@localhost", "-c", "commit.gpgSign=false", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
}

/** A committed repository, and a scratch Rune home for everything the engine keeps. */
function fixture(): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "h1-ws-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "h1-home-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previous;
  });
  writeFileSync(join(dir, "parser.ts"), "export const parse = (s: string) => s.split(',');\n");
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  return { dir, home };
}

function makeEngine(dir: string, home: string): Engine {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(home, "rune.db"),
    toolsBinaryPath: native.path,
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as ConstructorParameters<typeof Engine>[0]);
  cleanup.push(() => engine.close());
  return engine;
}

let callSeq = 0;
const readMissionCall = (): ContentBlock => ({
  type: "tool_use",
  toolCallId: `h1c${++callSeq}`,
  toolName: "read_file",
  toolInput: { path: MISSION_ROUTE },
});

/** Each chat: the model reads the mission route once, then answers. */
function scripted(engine: Engine): void {
  const provider = new UsageProvider();
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  let turnInChat = 0;
  provider.onRequest = () =>
    turnInChat++ % 2 === 0 ? [readMissionCall()] : [{ type: "text", text: "Understood." }];
}

/** Run one message and return what `read_file` gave the model back. */
async function missionAsRead(engine: Engine, sessionId: string, message: string): Promise<string> {
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(sessionId, message)) events.push(event);
  const reads = events.filter(
    (e): e is Extract<AgentTurnEvent, { type: "tool_call_end" }> =>
      e.type === "tool_call_end" && e.output.toolName === "read_file",
  );
  expect(reads.length).toBe(1);
  expect(reads[0]!.output.success).toBe(true);
  return (JSON.parse(reads[0]!.output.result) as { content: string }).content;
}

describe.skipIf(!native.exists)("H1 — the mission file, through a real engine", () => {
  test("a run leaves no mission file in the workspace, and the model still reads it", async () => {
    const { dir, home } = fixture();
    const engine = makeEngine(dir, home);
    scripted(engine);
    const session = engine.createSession();

    const content = await missionAsRead(
      engine,
      session,
      "Migrate the CSV parser to the streaming reader",
    );
    expect(content).toContain("Migrate the CSV parser to the streaming reader");

    // The file is the session's own, under the home…
    const file = missionFilePath(session, home);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Migrate the CSV parser");
    // …and not in the tree the run is working on.
    expect(existsSync(join(dir, MISSION_ROUTE))).toBe(false);
    const status = spawnSync("git", ["status", "--porcelain", "--", ".rune/mission.md"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(status.stdout.trim()).toBe("");
  });

  test("two sessions in one repository each read their own mission", async () => {
    const { dir, home } = fixture();
    const engine = makeEngine(dir, home);
    scripted(engine);
    const a = engine.createSession();
    const b = engine.createSession();

    const first = await missionAsRead(engine, a, "Migrate the CSV parser to the streaming reader");
    const second = await missionAsRead(engine, b, "Fix the login redirect after sign-out");
    expect(first).toContain("Migrate the CSV parser");
    expect(second).toContain("Fix the login redirect");
    expect(second).not.toContain("Migrate the CSV parser");

    // B's run did not overwrite A's file — which is what a shared
    // `<workspace>/.rune/mission.md` did.
    expect(readFileSync(missionFilePath(a, home), "utf8")).toContain("Migrate the CSV parser");
    expect(readFileSync(missionFilePath(a, home), "utf8")).not.toContain("login redirect");
    expect(readFileSync(missionFilePath(b, home), "utf8")).toContain("Fix the login redirect");
  });

  test("a session resumed in a new engine reads its mission back", async () => {
    const { dir, home } = fixture();
    const first = makeEngine(dir, home);
    scripted(first);
    const session = first.createSession();
    await missionAsRead(first, session, "Migrate the CSV parser to the streaming reader");
    first.close();
    // Nothing kept in memory, and the convenient copy on disk removed too: the
    // resumed engine has to rebuild it from the event log.
    rmSync(missionFilePath(session, home));

    const resumed = makeEngine(dir, home);
    scripted(resumed);
    const content = await missionAsRead(resumed, session, "carry on from where this stopped");
    expect(content).toContain("Migrate the CSV parser to the streaming reader");
    expect(existsSync(join(dir, MISSION_ROUTE))).toBe(false);
  });

  test("a mission file an older version left in the workspace is not touched, and not what is read", async () => {
    const { dir, home } = fixture();
    const legacy = join(dir, MISSION_ROUTE);
    spawnSync("mkdir", ["-p", join(dir, ".rune")]);
    writeFileSync(legacy, "# Mission\n\nGoal: something an older version wrote\n");
    writeFileSync(join(dir, ".rune", "mcp.json"), '{"servers":{}}\n');
    const engine = makeEngine(dir, home);
    scripted(engine);
    const session = engine.createSession();

    const content = await missionAsRead(
      engine,
      session,
      "Migrate the CSV parser to the streaming reader",
    );
    expect(content).toContain("Migrate the CSV parser");
    expect(content).not.toContain("an older version wrote");
    expect(readFileSync(legacy, "utf8")).toBe(
      "# Mission\n\nGoal: something an older version wrote\n",
    );
    expect(readFileSync(join(dir, ".rune", "mcp.json"), "utf8")).toBe('{"servers":{}}\n');
  });
});

// ─── The state a check run generates, with the real toolchains ───

const FIXTURES = join(import.meta.dir, "..", "fixtures", "verifier");
const has = (bin: string, ...args: string[]): boolean =>
  spawnSync(bin, args, { stdio: "ignore" }).status === 0;
const TOOLCHAINS = { rust: has("cargo", "--version"), python: has("python3", "--version") };

/** A fixture, copied out of the repository so nothing here can write into it. */
function copyOf(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `h1-${name}-`));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  // A copy must not carry a build directory the fixture happened to have.
  for (const generated of ["target", "__pycache__", ".pytest_cache"]) {
    rmSync(join(dir, generated), { recursive: true, force: true });
  }
  return dir;
}

describe("H1 — a check run leaves no build directory in a tree that had none", () => {
  test.skipIf(!TOOLCHAINS.rust)(
    "a first `cargo check` and `cargo test`: green, and no target/ in the project",
    async () => {
      const dir = copyOf("rust-pass");
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 180_000 }).verify();
      expect(r.runs?.map((x) => x.command)).toEqual(["cargo check --quiet", "cargo test --quiet"]);
      expect(r.status).toBe("passed");
      expect(existsSync(join(dir, "target"))).toBe(false);
      // One thing cargo writes cannot be sent elsewhere: a lockfile, when the
      // crate has none. It is the project's own file, not build state — and it
      // is the only entry that appears.
      expect(readdirSync(dir).sort()).toEqual(["Cargo.lock", "Cargo.toml", "src"]);
    },
    240_000,
  );

  test.skipIf(!TOOLCHAINS.rust)(
    "a project that already has a target/ keeps using it",
    async () => {
      const dir = copyOf("rust-pass");
      mkdirSync(join(dir, "target"));
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 180_000 }).verify();
      expect(r.status).toBe("passed");
      // Cargo built into the person's own directory.
      expect(readdirSync(join(dir, "target")).length).toBeGreaterThan(0);
    },
    240_000,
  );

  test.skipIf(!TOOLCHAINS.rust)(
    "an explicit CARGO_TARGET_DIR is where the build goes",
    async () => {
      const dir = copyOf("rust-pass");
      const chosen = mkdtempSync(join(tmpdir(), "h1-chosen-target-"));
      cleanup.push(() => rmSync(chosen, { recursive: true, force: true }));
      const previous = process.env.CARGO_TARGET_DIR;
      process.env.CARGO_TARGET_DIR = chosen;
      cleanup.push(() => {
        if (previous === undefined) delete process.env.CARGO_TARGET_DIR;
        else process.env.CARGO_TARGET_DIR = previous;
      });
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 180_000 }).verify();
      expect(r.status).toBe("passed");
      expect(readdirSync(chosen).length).toBeGreaterThan(0);
      expect(existsSync(join(dir, "target"))).toBe(false);
    },
    240_000,
  );

  test.skipIf(!TOOLCHAINS.rust)(
    "a command the person wrote in [verify] commands runs in their environment, untouched",
    async () => {
      const dir = copyOf("rust-pass");
      const r = await new CommandVerifier({
        workspaceRoot: dir,
        commands: ["cargo check --quiet"],
        timeoutMs: 180_000,
      }).verify();
      expect(r.status).toBe("passed");
      // Their command, their defaults: cargo built where cargo builds.
      expect(existsSync(join(dir, "target"))).toBe(true);
    },
    240_000,
  );

  test.skipIf(!TOOLCHAINS.python)(
    "a Python step check compiles the file and leaves no __pycache__ beside it",
    async () => {
      const dir = copyOf("python-pass");
      const before = readdirSync(dir).sort();
      const r = await new CommandVerifier({ workspaceRoot: dir }).verifyFast(undefined, [
        "calc.py",
      ]);
      expect(r.runs?.[0]?.command).toContain("py_compile");
      expect(r.status).toBe("passed");
      expect(readdirSync(dir).sort()).toEqual(before);
      expect(existsSync(join(dir, "__pycache__"))).toBe(false);
    },
    60_000,
  );
});
