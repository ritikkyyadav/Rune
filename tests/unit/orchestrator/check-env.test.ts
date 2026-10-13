/**
 * A check is started with the session's environment less the session's own
 * state — `packages/orchestrator/src/check-env.ts` says why, and with what
 * measurements.
 *
 * Three things are held here:
 *
 *   1. the rule itself, on a plain environment: what goes, what is put in its
 *      place, and that nothing else moves;
 *   2. that the verifier's commands are really started with it — read back
 *      from inside a check a real `CommandVerifier` ran, on both paths a unit
 *      test can reach (the check itself, and the touched test files run in
 *      place of a suite that did not finish);
 *   3. that the list of names cannot quietly go stale: every home-, path-,
 *      directory- and token-shaped variable the source reads has to be on one
 *      side of the line or the other.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  checkEnvironment,
  NOT_SESSION_STATE,
  SESSION_STATE_ENV,
} from "../../../packages/orchestrator/src/check-env";
import { CommandVerifier } from "../../../packages/orchestrator/src/verifier";

const scratchDir = (): string => mkdtempSync(join(tmpdir(), "check-env-"));

/**
 * Written out here, not read from the module: a name deleted from the list
 * there has to fail something.
 */
const MUST_NOT_REACH_A_CHECK = [
  "RUNE_HOME",
  "GEAR_HOME",
  "ALAN_HOME",
  "RUNE_DB_PATH",
  "RUNE_CONFIG_PATH",
  "RUNE_CREDENTIALS_PATH",
  "RUNE_CREDENTIAL_INDEX_PATH",
  "RUNE_SECRETS_PATH",
  "RUNE_PREFS_PATH",
  "RUNE_MODEL_PATH",
  "RUNE_LOG_DIR",
  "RUNE_MEMORY_DIR",
  "RUNE_SYSTEM_MEMORY_PATH",
  "RUNE_SOCKET_PATH",
  "RUNE_SERVE_TOKEN",
  "RUNE_TELEMETRY_TOKEN",
];

/** A session as the comparison rig starts one: everything pointed somewhere live. */
const liveSession = (): Record<string, string> =>
  Object.fromEntries(MUST_NOT_REACH_A_CHECK.map((name) => [name, `/live/${name.toLowerCase()}`]));

describe("the environment a check is started with", () => {
  test("nothing that locates or unlocks the session's state is in it", () => {
    const scratch = scratchDir();
    try {
      const out = checkEnvironment({ PATH: "/usr/bin", ...liveSession() }, () => scratch);
      for (const name of MUST_NOT_REACH_A_CHECK) {
        expect({ name, value: out[name] }).not.toEqual({
          name,
          value: `/live/${name.toLowerCase()}`,
        });
        if (name !== "RUNE_HOME") expect(name in out).toBe(false);
      }
      expect(JSON.stringify(out)).not.toContain("/live/");
      // The module's own list holds at least these.
      for (const name of MUST_NOT_REACH_A_CHECK) expect(SESSION_STATE_ENV).toContain(name);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("it has a Rune home of its own: empty, and inside the directory it was given", () => {
    const scratch = scratchDir();
    try {
      const out = checkEnvironment({ RUNE_HOME: "/live/profile" }, () => scratch);
      expect(out.RUNE_HOME).toBe(join(scratch, "rune-home"));
      expect(statSync(out.RUNE_HOME!).isDirectory()).toBe(true);
      expect(readdirSync(out.RUNE_HOME!)).toEqual([]);
      // And nothing else was made beside it.
      expect(readdirSync(scratch)).toEqual(["rune-home"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a session with no Rune variables at all still gets one: the default home is the person's", () => {
    const scratch = scratchDir();
    try {
      const out = checkEnvironment({ PATH: "/usr/bin" }, () => scratch);
      expect(out.RUNE_HOME).toBe(join(scratch, "rune-home"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("its credential and memory-key stores are the file ones, whatever the session chose", () => {
    const scratch = scratchDir();
    try {
      for (const base of [
        {},
        { RUNE_CREDENTIAL_BACKEND: "keychain", RUNE_MEMORY_KEY_BACKEND: "keychain" },
      ]) {
        const out = checkEnvironment(base, () => scratch);
        expect(out.RUNE_CREDENTIAL_BACKEND).toBe("file");
        expect(out.RUNE_MEMORY_KEY_BACKEND).toBe("file");
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a name is a name whatever its case — on Windows `Rune_Home` is the same variable", () => {
    const scratch = scratchDir();
    try {
      const out = checkEnvironment(
        {
          Rune_Home: "/live/profile",
          rune_secrets_path: "/live/secrets.json",
          Rune_Credential_Backend: "keychain",
          Path: "C:\\bin",
        },
        () => scratch,
      );
      expect(JSON.stringify(out)).not.toContain("/live/");
      expect(JSON.stringify(out)).not.toContain("keychain");
      expect(Object.keys(out).filter((k) => k.toUpperCase() === "RUNE_HOME")).toEqual([
        "RUNE_HOME",
      ]);
      expect(Object.keys(out).filter((k) => k.toUpperCase() === "RUNE_CREDENTIAL_BACKEND")).toEqual(
        ["RUNE_CREDENTIAL_BACKEND"],
      );
      expect(out.Path).toBe("C:\\bin");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("nothing else moves: the toolchain's variables, a project's own, even one named RUNE_…", () => {
    const scratch = scratchDir();
    try {
      const theirs = {
        PATH: "/opt/tools/bin:/usr/bin",
        HOME: "/Users/someone",
        JAVA_HOME: "/opt/jdk",
        CARGO_HOME: "/Users/someone/.cargo",
        DATABASE_URL: "postgres://localhost/app_test",
        // A project that happens to be called Rune: its variable, not ours.
        RUNE_GAME_LEVEL: "7",
        // Rune's, and not state: where a program or a restriction is found.
        RUNE_TOOLS_BIN: "/opt/rune/rune-tools",
        RUNE_POLICY_FILE: "/etc/rune/policy.json",
        RUNE_SKILLS_DIR: "/opt/rune/skills",
      };
      const base = { ...theirs, ...liveSession() };
      const before = JSON.stringify(base);
      const out = checkEnvironment(base, () => scratch);
      const { RUNE_HOME, RUNE_CREDENTIAL_BACKEND, RUNE_MEMORY_KEY_BACKEND, ...rest } = out;
      expect(rest).toEqual(theirs);
      expect([RUNE_HOME, RUNE_CREDENTIAL_BACKEND, RUNE_MEMORY_KEY_BACKEND]).toEqual([
        join(scratch, "rune-home"),
        "file",
        "file",
      ]);
      // The session's own environment is read, never written.
      expect(JSON.stringify(base)).toBe(before);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// ─── What a check the verifier started actually saw ───

/** `NAME=value` lines, as `env` prints them. */
const parseEnv = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

/** The session's environment for these runs: enough to start a tool, and a live session's state. */
const sessionEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  MY_PROJECT_URL: "postgres://kept",
  ...liveSession(),
});

const expectIsolated = (seen: Record<string, string>): void => {
  expect(JSON.stringify(seen)).not.toContain("/live/");
  for (const name of MUST_NOT_REACH_A_CHECK) {
    if (name !== "RUNE_HOME") expect({ name, there: name in seen }).toEqual({ name, there: false });
  }
  expect(seen.RUNE_HOME).toMatch(/rune-check-cache-[^/]+\/rune-home$/);
  expect(seen.RUNE_CREDENTIAL_BACKEND).toBe("file");
  expect(seen.RUNE_MEMORY_KEY_BACKEND).toBe("file");
  expect(seen.MY_PROJECT_URL).toBe("postgres://kept");
};

describe("a check the verifier starts", () => {
  test("a command the person wrote in `[verify] commands` sees no session state", async () => {
    const ws = scratchDir();
    try {
      const verifier = new CommandVerifier({
        workspaceRoot: ws,
        commands: ["env > seen.env"],
        env: sessionEnv(),
      });
      const result = await verifier.verify();
      expect(result.status).toBe("passed");
      expectIsolated(parseEnv(readFileSync(join(ws, "seen.env"), "utf8")));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a check the verifier chose from the manifest sees none either, and the home it is given exists", async () => {
    const ws = scratchDir();
    try {
      writeFileSync(
        join(ws, "package.json"),
        JSON.stringify({
          name: "probe",
          scripts: { test: 'env > seen.env && test -d "$RUNE_HOME"' },
        }),
      );
      writeFileSync(join(ws, "bun.lock"), "");
      const verifier = new CommandVerifier({ workspaceRoot: ws, env: sessionEnv() });
      const result = await verifier.verify();
      expect(result.runs?.map((r) => r.command)).toEqual(["bun run test"]);
      expect(result.status).toBe("passed");
      expectIsolated(parseEnv(readFileSync(join(ws, "seen.env"), "utf8")));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("the touched test files run in place of a suite that did not finish see none either", async () => {
    const ws = scratchDir();
    try {
      writeFileSync(
        join(ws, "package.json"),
        // A suite that cannot finish inside the limit below.
        JSON.stringify({ name: "probe", scripts: { test: "sleep 30 && bun test" } }),
      );
      writeFileSync(join(ws, "bun.lock"), "");
      writeFileSync(
        join(ws, "probe.test.ts"),
        'import { expect, test } from "bun:test";\n' +
          'test("writes down what it was started with", () => {\n' +
          '  require("node:fs").writeFileSync("seen.json", JSON.stringify(process.env));\n' +
          "  expect(1).toBe(1);\n});\n",
      );
      const verifier = new CommandVerifier({
        workspaceRoot: ws,
        timeoutMs: 4_000,
        env: sessionEnv(),
      });
      const result = await verifier.verify(undefined, [join(ws, "probe.test.ts")]);
      // The suite did not finish, and the file the change touched was run.
      expect(result.status).toBe("inconclusive");
      expect(result.report).toContain("The test files this change touched");
      expect(existsSync(join(ws, "seen.json"))).toBe(true);
      expectIsolated(JSON.parse(readFileSync(join(ws, "seen.json"), "utf8")));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  test("every command the verifier starts takes its environment from the one place", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../../packages/orchestrator/src/verifier.ts"),
      "utf8",
    );
    const calls = [...source.matchAll(/await runCommand\(([\s\S]*?)\n {6}\);/g)].map((m) => m[1]!);
    // The check itself, the touched files in its place, and the same check on
    // the tree the run started from (which no unit test here reaches).
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call).toContain("this.checkEnv(");
    // And there is no other way in: the spawn takes what it is given.
    expect(source).not.toMatch(/env:\s*\{\s*\.\.\.process\.env,\s*\.\.\.extraEnv/);
    expect(source).toMatch(/Bun\.spawn\(\["bash", "-c", command\], \{[\s\S]{0,400}?\n {4}env,\n/);
  });
});

// ─── The list cannot quietly go stale ───

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("the list of the session's own variables", () => {
  test("every home-, path-, directory- and token-shaped variable the source reads is on one side or the other", () => {
    const packages = resolve(import.meta.dir, "../../../packages");
    const read = new Set<string>();
    for (const pkg of readdirSync(packages)) {
      const src = join(packages, pkg, "src");
      if (!existsSync(src)) continue;
      for (const file of sourceFiles(src)) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/\benv(?:\.|\[\s*["'])((?:RUNE|GEAR|ALAN)_[A-Z0-9_]+)/g)) {
          read.add(m[1]!);
        }
      }
    }
    const shaped = [...read].filter((name) => /_(?:HOME|PATH|DIR|TOKEN)$/.test(name)).sort();
    // The scan is finding them: these are read today, by these names.
    for (const known of ["RUNE_HOME", "RUNE_DB_PATH", "RUNE_SECRETS_PATH", "RUNE_SERVE_TOKEN"]) {
      expect(shaped).toContain(known);
    }
    const unclassified = shaped.filter(
      (name) => !SESSION_STATE_ENV.includes(name) && !(name in NOT_SESSION_STATE),
    );
    // A new one of these must be decided: is it where a session keeps
    // something (SESSION_STATE_ENV), or not (NOT_SESSION_STATE, with why)?
    expect(unclassified).toEqual([]);
  });

  test("no name is on both sides, and every exemption says why", () => {
    for (const [name, why] of Object.entries(NOT_SESSION_STATE)) {
      expect(SESSION_STATE_ENV).not.toContain(name);
      expect(why.length).toBeGreaterThan(20);
    }
    expect(new Set(SESSION_STATE_ENV).size).toBe(SESSION_STATE_ENV.length);
  });
});
