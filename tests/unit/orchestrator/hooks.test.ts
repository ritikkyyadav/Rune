import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHookConfig,
  HookRunner,
  createHookRunner,
  matchesPattern,
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookConfig,
} from "../../../packages/orchestrator/src/hooks";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "alan-hooks-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Write `.alan/hooks.json` into the temp workspace. */
async function writeConfig(config: HookConfig | string): Promise<void> {
  const dir = join(workspace, ".alan");
  await mkdir(dir, { recursive: true });
  const body = typeof config === "string" ? config : JSON.stringify(config, null, 2);
  await writeFile(join(dir, "hooks.json"), body);
}

// ─── matchesPattern ───

describe("matchesPattern", () => {
  test("undefined / empty / '*' match everything", () => {
    expect(matchesPattern(undefined, "edit_file")).toBe(true);
    expect(matchesPattern("", "edit_file")).toBe(true);
    expect(matchesPattern("*", "anything")).toBe(true);
  });

  test("exact names match literally", () => {
    expect(matchesPattern("edit_file", "edit_file")).toBe(true);
    expect(matchesPattern("edit_file", "read_file")).toBe(false);
  });

  test("prefix glob 'edit_*' matches edit_file but not read_file", () => {
    expect(matchesPattern("edit_*", "edit_file")).toBe(true);
    expect(matchesPattern("edit_*", "edit_lines")).toBe(true);
    expect(matchesPattern("edit_*", "read_file")).toBe(false);
  });

  test("suffix glob '*_file' matches", () => {
    expect(matchesPattern("*_file", "edit_file")).toBe(true);
    expect(matchesPattern("*_file", "read_file")).toBe(true);
    expect(matchesPattern("*_file", "bash")).toBe(false);
  });

  test("does not treat regex metacharacters specially", () => {
    // The dot is literal, not 'any char'.
    expect(matchesPattern("edit.file", "edit_file")).toBe(false);
    expect(matchesPattern("edit.file", "edit.file")).toBe(true);
  });
});

// ─── loadHookConfig ───

describe("loadHookConfig", () => {
  test("missing .alan/hooks.json returns {}", async () => {
    const config = await loadHookConfig(workspace);
    expect(config).toEqual({});
  });

  test("missing .alan dir entirely returns {} (no throw)", async () => {
    const config = await loadHookConfig(join(workspace, "does", "not", "exist"));
    expect(config).toEqual({});
  });

  test("empty file returns {}", async () => {
    await writeConfig("");
    const config = await loadHookConfig(workspace);
    expect(config).toEqual({});
  });

  test("valid config parses all events", async () => {
    await writeConfig({
      preToolUse: [{ match: "edit_*", command: "exit 0", blocking: true }],
      postToolUse: [{ command: "echo done" }],
      sessionStart: [{ command: "echo start" }],
      sessionEnd: [{ command: "echo end" }],
    });
    const config = await loadHookConfig(workspace);
    expect(config.preToolUse).toHaveLength(1);
    expect(config.preToolUse?.[0].match).toBe("edit_*");
    expect(config.preToolUse?.[0].blocking).toBe(true);
    expect(config.postToolUse?.[0].command).toBe("echo done");
    expect(config.sessionStart?.[0].command).toBe("echo start");
    expect(config.sessionEnd?.[0].command).toBe("echo end");
  });

  test("malformed JSON throws a clear error", async () => {
    await writeConfig("{ this is not json ");
    await expect(loadHookConfig(workspace)).rejects.toThrow(/Malformed hook config/);
  });

  test("top-level array (not object) throws", async () => {
    await writeConfig("[]");
    await expect(loadHookConfig(workspace)).rejects.toThrow(/expected a JSON object/);
  });

  test("event that is not an array throws", async () => {
    await writeConfig('{ "preToolUse": "nope" }');
    await expect(loadHookConfig(workspace)).rejects.toThrow(/must be an array/);
  });

  test("hook missing command throws", async () => {
    await writeConfig('{ "preToolUse": [{ "match": "*" }] }');
    await expect(loadHookConfig(workspace)).rejects.toThrow(/command must be a non-empty string/);
  });

  test("hook with non-boolean blocking throws", async () => {
    await writeConfig('{ "preToolUse": [{ "command": "exit 0", "blocking": "yes" }] }');
    await expect(loadHookConfig(workspace)).rejects.toThrow(/blocking must be a boolean/);
  });
});

// ─── HookRunner: empty / no-op ───

describe("HookRunner no-op behavior", () => {
  test("empty config: all methods are no-ops and pre allows", async () => {
    const runner = new HookRunner({}, workspace);
    expect(runner.isEmpty()).toBe(true);

    const decision = await runner.runPreToolUse("edit_file", { path: "a.ts" });
    expect(decision.allow).toBe(true);

    // None of these should throw.
    await runner.runPostToolUse("edit_file", { success: true });
    await runner.runSessionStart();
    await runner.runSessionEnd();
  });

  test("missing config file -> loaded runner no-ops", async () => {
    const runner = await HookRunner.load(workspace);
    expect(runner.isEmpty()).toBe(true);
    expect((await runner.runPreToolUse("bash", {})).allow).toBe(true);
  });

  test("createHookRunner factory builds an equivalent runner", async () => {
    const runner = createHookRunner({}, workspace);
    expect(runner).toBeInstanceOf(HookRunner);
    expect((await runner.runPreToolUse("x", {})).allow).toBe(true);
  });
});

// ─── runPreToolUse: blocking semantics ───

describe("runPreToolUse blocking", () => {
  test("blocking hook that exits non-zero -> allow:false with reason", async () => {
    const runner = createHookRunner(
      { preToolUse: [{ command: "echo 'guard rejected' 1>&2; exit 1", blocking: true }] },
      workspace,
    );
    const decision = await runner.runPreToolUse("edit_file", { path: "a.ts" });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBeDefined();
    expect(decision.reason).toContain("guard rejected");
  });

  test("passing (exit 0) blocking hook -> allow:true", async () => {
    const runner = createHookRunner(
      { preToolUse: [{ command: "exit 0", blocking: true }] },
      workspace,
    );
    const decision = await runner.runPreToolUse("edit_file", { path: "a.ts" });
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  test("non-blocking failing hook does NOT block", async () => {
    const logs: string[] = [];
    const runner = createHookRunner(
      { preToolUse: [{ command: "exit 7", blocking: false }] },
      workspace,
      { logger: (m) => logs.push(m) },
    );
    const decision = await runner.runPreToolUse("edit_file", {});
    expect(decision.allow).toBe(true);
    // Failure should have been reported, not swallowed silently.
    expect(logs.some((l) => l.includes("non-blocking"))).toBe(true);
  });

  test("hook with omitted blocking defaults to non-blocking (does not block)", async () => {
    const runner = createHookRunner(
      { preToolUse: [{ command: "exit 1" }] },
      workspace,
    );
    expect((await runner.runPreToolUse("edit_file", {})).allow).toBe(true);
  });

  test("first blocking failure short-circuits to allow:false", async () => {
    const runner = createHookRunner(
      {
        preToolUse: [
          { command: "exit 3", blocking: true },
          { command: "exit 0", blocking: true },
        ],
      },
      workspace,
    );
    const decision = await runner.runPreToolUse("edit_file", {});
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("code 3");
  });

  test("passes ALAN_TOOL_NAME via env to the command", async () => {
    // Hook fails only when the env var is wrong, so allow:true proves it was set.
    const runner = createHookRunner(
      {
        preToolUse: [
          { command: '[ "$ALAN_TOOL_NAME" = "edit_file" ] || exit 1', blocking: true },
        ],
      },
      workspace,
    );
    expect((await runner.runPreToolUse("edit_file", {})).allow).toBe(true);
    expect((await runner.runPreToolUse("read_file", {})).allow).toBe(false);
  });

  test("passes tool args as JSON on stdin", async () => {
    // grep the stdin JSON for the path we passed; exit non-zero if absent.
    const runner = createHookRunner(
      { preToolUse: [{ command: "grep -q 'needle.ts' || exit 1", blocking: true }] },
      workspace,
    );
    expect((await runner.runPreToolUse("edit_file", { path: "needle.ts" })).allow).toBe(true);
    expect((await runner.runPreToolUse("edit_file", { path: "other.ts" })).allow).toBe(false);
  });
});

// ─── match filtering ───

describe("runPreToolUse match filtering", () => {
  test("match 'edit_*' runs for edit_file but not read_file", async () => {
    const config: HookConfig = {
      preToolUse: [{ match: "edit_*", command: "exit 1", blocking: true }],
    };
    const runner = createHookRunner(config, workspace);

    // edit_file matches -> the failing blocking hook blocks.
    expect((await runner.runPreToolUse("edit_file", {})).allow).toBe(false);
    // read_file does not match -> no hooks run -> allowed.
    expect((await runner.runPreToolUse("read_file", {})).allow).toBe(true);
  });

  test("omitted match runs for every tool", async () => {
    const runner = createHookRunner(
      { preToolUse: [{ command: "exit 1", blocking: true }] },
      workspace,
    );
    expect((await runner.runPreToolUse("anything", {})).allow).toBe(false);
    expect((await runner.runPreToolUse("bash", {})).allow).toBe(false);
  });
});

// ─── timeout ───

describe("runPreToolUse timeout", () => {
  test("a blocking hook that sleeps longer than timeoutMs is treated as failure", async () => {
    const runner = createHookRunner(
      { preToolUse: [{ command: "sleep 5", timeoutMs: 50, blocking: true }] },
      workspace,
    );
    const started = performance.now();
    const decision = await runner.runPreToolUse("edit_file", {});
    const elapsed = performance.now() - started;

    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("timed out");
    // Should have been killed near the timeout, not after the full 5s sleep.
    expect(elapsed).toBeLessThan(2000);
  });

  test("a non-blocking timeout is reported but does not block", async () => {
    const logs: string[] = [];
    const runner = createHookRunner(
      { preToolUse: [{ command: "sleep 5", timeoutMs: 50, blocking: false }] },
      workspace,
      { logger: (m) => logs.push(m) },
    );
    const decision = await runner.runPreToolUse("edit_file", {});
    expect(decision.allow).toBe(true);
    expect(logs.some((l) => l.includes("timed out"))).toBe(true);
  });
});

// ─── runPostToolUse / lifecycle: report-only ───

describe("runPostToolUse and lifecycle hooks", () => {
  test("postToolUse never throws even when the command fails", async () => {
    const logs: string[] = [];
    const runner = createHookRunner(
      { postToolUse: [{ command: "exit 1" }] },
      workspace,
      { logger: (m) => logs.push(m) },
    );
    // Must resolve, not reject.
    await runner.runPostToolUse("edit_file", { success: false, error: "boom" });
    expect(logs.some((l) => l.includes("postToolUse"))).toBe(true);
  });

  test("postToolUse respects match filtering", async () => {
    const logs: string[] = [];
    const runner = createHookRunner(
      { postToolUse: [{ match: "write_*", command: "exit 1" }] },
      workspace,
      { logger: (m) => logs.push(m) },
    );
    // read_file does not match write_* -> no hook runs -> nothing logged.
    await runner.runPostToolUse("read_file", { success: true });
    expect(logs).toHaveLength(0);
  });

  test("postToolUse passes ALAN_TOOL_OUTPUT and succeeds quietly on exit 0", async () => {
    const logs: string[] = [];
    const runner = createHookRunner(
      {
        postToolUse: [
          { command: '[ -n "$ALAN_TOOL_OUTPUT" ] && exit 0 || exit 1' },
        ],
      },
      workspace,
      { logger: (m) => logs.push(m) },
    );
    await runner.runPostToolUse("edit_file", { success: true, result: "ok" });
    expect(logs).toHaveLength(0); // exit 0 => no failure logged
  });

  test("sessionStart and sessionEnd run and never throw on failure", async () => {
    const logs: string[] = [];
    const runner = createHookRunner(
      {
        sessionStart: [{ command: "exit 2" }],
        sessionEnd: [{ command: "exit 0" }],
      },
      workspace,
      { logger: (m) => logs.push(m) },
    );
    await runner.runSessionStart();
    await runner.runSessionEnd();
    expect(logs.some((l) => l.includes("sessionStart"))).toBe(true);
    // sessionEnd exited 0, so it should not have logged a failure.
    expect(logs.some((l) => l.includes("sessionEnd"))).toBe(false);
  });

  test("session hooks are no-ops when not configured", async () => {
    const runner = createHookRunner({ preToolUse: [{ command: "exit 0" }] }, workspace);
    await runner.runSessionStart();
    await runner.runSessionEnd();
    // No assertion needed beyond "did not throw".
    expect(true).toBe(true);
  });
});

// ─── end-to-end via loadHookConfig + HookRunner.load ───

describe("end-to-end: load + run from disk", () => {
  test("writes a real hooks.json and enforces a blocking guard", async () => {
    await writeConfig({
      preToolUse: [
        {
          match: "edit_*",
          command: "echo 'no edits allowed' 1>&2; exit 1",
          blocking: true,
        },
      ],
      sessionStart: [{ command: "exit 0" }],
    });

    const runner = await HookRunner.load(workspace);
    expect(runner.isEmpty()).toBe(false);

    const blocked = await runner.runPreToolUse("edit_file", { path: "x.ts" });
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toContain("no edits allowed");

    const allowed = await runner.runPreToolUse("read_file", { path: "x.ts" });
    expect(allowed.allow).toBe(true);

    await runner.runSessionStart(); // should not throw
  });
});

// ─── exported constant sanity ───

test("DEFAULT_HOOK_TIMEOUT_MS is a positive number", () => {
  expect(typeof DEFAULT_HOOK_TIMEOUT_MS).toBe("number");
  expect(DEFAULT_HOOK_TIMEOUT_MS).toBeGreaterThan(0);
});
