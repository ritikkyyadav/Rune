import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LOOP_MAINTENANCE_PROMPT,
  LOOP_EVENT_DELETE,
  LOOP_EXPIRY_MS,
  LOOP_FULL_AUTONOMY_MAX_MS,
  LOOP_MIN_INTERVAL_MS,
  LoopManager,
  formatLoopDue,
  formatLoopInterval,
  isTrustedLoopPromptSource,
  parseLoopRequest,
  resolveLoopPrompt,
  type LoopEventRecord,
} from "../../../packages/orchestrator/src/loop-mode";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gear-loop-test-"));
  tempDirs.push(dir);
  return dir;
}

function memoryStore(events: LoopEventRecord[] = []) {
  return {
    events,
    persistence: {
      readEvents: () => events.map((event) => structuredClone(event)),
      appendEvent: (type: string, payload: Record<string, unknown>) => {
        events.push({ type, payload: structuredClone(payload) });
      },
    },
  };
}

describe("/loop argument parsing", () => {
  test("accepts a leading compact interval", () => {
    expect(parseLoopRequest("5m check the deploy")).toEqual({
      prompt: "check the deploy",
      intervalMs: 5 * LOOP_MIN_INTERVAL_MS,
      warnings: [],
    });
  });

  test("accepts a trailing natural interval", () => {
    expect(parseLoopRequest("check CI every 2 hours")).toEqual({
      prompt: "check CI",
      intervalMs: 2 * 60 * LOOP_MIN_INTERVAL_MS,
      warnings: [],
    });
  });

  test("keeps a prompt-only request adaptive", () => {
    expect(parseLoopRequest("check the pull request")).toEqual({
      prompt: "check the pull request",
      warnings: [],
    });
  });

  test("rounds seconds up to the one-minute floor", () => {
    const parsed = parseLoopRequest("15s check the job");
    expect(parsed.intervalMs).toBe(LOOP_MIN_INTERVAL_MS);
    expect(parsed.warnings.join(" ")).toContain("rounded up");
  });

  test("rejects an interval that can never fire before expiry", () => {
    expect(() => parseLoopRequest("7d check later")).toThrow("shorter than the seven-day");
  });
});

describe("loop.md prompt resolution", () => {
  test("project prompt wins over the user prompt", () => {
    const workspace = tempDir();
    const home = tempDir();
    mkdirSync(join(workspace, ".gear"), { recursive: true });
    writeFileSync(join(workspace, ".gear", "loop.md"), "Project loop instructions");
    writeFileSync(join(home, "loop.md"), "User loop instructions");

    const resolved = resolveLoopPrompt("", workspace, home);
    expect(resolved.source).toBe("project");
    expect(resolved.prompt).toBe("Project loop instructions");
  });

  test("ignores a symlinked project prompt and falls back safely", () => {
    const workspace = tempDir();
    const home = tempDir();
    mkdirSync(join(workspace, ".gear"), { recursive: true });
    writeFileSync(join(home, "loop.md"), "Safe user prompt");
    symlinkSync(join(home, "loop.md"), join(workspace, ".gear", "loop.md"));

    const resolved = resolveLoopPrompt("", workspace, home);
    expect(resolved.source).toBe("user");
    expect(resolved.prompt).toBe("Safe user prompt");
    expect(resolved.warning).toContain("symlink");
  });

  test("also rejects a symlinked .gear directory", () => {
    const workspace = tempDir();
    const redirected = tempDir();
    const home = tempDir();
    writeFileSync(join(redirected, "loop.md"), "Redirected project prompt");
    writeFileSync(join(home, "loop.md"), "Safe user prompt");
    symlinkSync(redirected, join(workspace, ".gear"));

    const resolved = resolveLoopPrompt("", workspace, home);
    expect(resolved.source).toBe("user");
    expect(resolved.prompt).toBe("Safe user prompt");
    expect(resolved.warning).toContain(".gear is a symlink");
  });

  test("uses the bounded built-in maintenance prompt when no file exists", () => {
    const resolved = resolveLoopPrompt("", tempDir(), tempDir());
    expect(resolved.source).toBe("builtin");
    expect(resolved.prompt).toBe(DEFAULT_LOOP_MAINTENANCE_PROMPT);
  });
});

describe("LoopManager", () => {
  test("persists fixed tasks and restores them in a resumed manager", () => {
    let now = 1_000_000;
    const store = memoryStore();
    const first = new LoopManager(store.persistence, {
      now: () => now,
      idFactory: () => "deadbeef",
    });
    const created = first.create({
      prompt: "check the deploy",
      promptSource: "argument",
      intervalMs: 5 * LOOP_MIN_INTERVAL_MS,
    });

    expect(created.id).toBe("deadbeef");
    expect(created.cadence).toBe("fixed");
    expect(first.claimDue()).toBeNull();

    const resumed = new LoopManager(store.persistence, { now: () => now });
    expect(resumed.list()).toEqual([created]);

    now = created.nextRunAt;
    expect(resumed.claimDue()?.id).toBe(created.id);
    const completion = resumed.complete(created.id, { toolCalls: 1 });
    expect(completion.state).toBe("rescheduled");
    expect(completion.task?.runCount).toBe(1);
    expect(completion.task?.nextRunAt).toBe(now + 5 * LOOP_MIN_INTERVAL_MS);
  });

  test("adaptive tasks honor an agent-selected delay", () => {
    let now = 2_000_000;
    const store = memoryStore();
    const manager = new LoopManager(store.persistence, {
      now: () => now,
      idFactory: () => "a11ce123",
    });
    const task = manager.create({ prompt: "watch CI", promptSource: "argument" });
    now = task.nextRunAt;
    expect(manager.claimDue()?.id).toBe(task.id);

    const control = manager.controlActive({
      action: "continue",
      delayMinutes: 17,
      reason: "CI is still running",
    });
    expect(control.ok).toBe(true);
    const completion = manager.complete(task.id, { responseText: "still running" });
    expect(completion.state).toBe("rescheduled");
    expect(completion.task?.intervalMs).toBe(17 * LOOP_MIN_INTERVAL_MS);
    expect(completion.reason).toBe("CI is still running");
  });

  test("an adaptive task can stop itself only while its iteration is active", () => {
    let now = 3_000_000;
    const store = memoryStore();
    const manager = new LoopManager(store.persistence, {
      now: () => now,
      idFactory: () => "c0ffee00",
    });
    const task = manager.create({ prompt: "watch CI", promptSource: "argument" });
    expect(manager.controlActive({ action: "stop", reason: "done" }).ok).toBe(false);

    now = task.nextRunAt;
    manager.claimDue();
    expect(manager.controlActive({ action: "stop", reason: "CI passed" }).ok).toBe(true);
    expect(manager.complete(task.id).state).toBe("stopped");
    expect(manager.list()).toHaveLength(0);
  });

  test("cancels by an unambiguous id prefix and records the deletion", () => {
    const store = memoryStore();
    const ids = ["abcde001", "f00ba002"];
    const manager = new LoopManager(store.persistence, { idFactory: () => ids.shift()! });
    manager.create({ prompt: "one", promptSource: "argument" });
    manager.create({ prompt: "two", promptSource: "argument" });

    const cancelled = manager.cancel("abc");
    expect(cancelled.ok).toBe(true);
    expect(cancelled.task?.id).toBe("abcde001");
    expect(store.events.at(-1)?.type).toBe(LOOP_EVENT_DELETE);
    expect(manager.list().map((task) => task.id)).toEqual(["f00ba002"]);
  });

  test("expires forgotten tasks after seven days", () => {
    let now = 4_000_000;
    const store = memoryStore();
    const manager = new LoopManager(store.persistence, {
      now: () => now,
      idFactory: () => "eeeeeeee",
    });
    manager.create({ prompt: "watch", promptSource: "argument" });
    now += LOOP_EXPIRY_MS;
    expect(manager.list()).toEqual([]);
    expect(store.events.at(-1)?.payload.reason).toBe("expired");
  });

  test("does not delete a long-cadence loop before its full expiry window", () => {
    let now = 5_000_000;
    const store = memoryStore();
    const manager = new LoopManager(store.persistence, {
      now: () => now,
      idFactory: () => "dddddddd",
    });
    const day = 24 * 60 * LOOP_MIN_INTERVAL_MS;
    const task = manager.create({
      prompt: "daily check",
      promptSource: "argument",
      intervalMs: day,
    });

    for (let run = 0; run < 6; run++) {
      now = manager.list()[0]!.nextRunAt;
      manager.claimDue();
      expect(manager.complete(task.id).state).toBe("rescheduled");
    }
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]?.nextRunAt).toBe(task.createdAt + LOOP_EXPIRY_MS);
  });
});

describe("loop display helpers", () => {
  test("formats cadence and due time compactly", () => {
    expect(formatLoopInterval(90 * LOOP_MIN_INTERVAL_MS)).toBe("1h 30m");
    expect(formatLoopDue(10 * LOOP_MIN_INTERVAL_MS, 8 * LOOP_MIN_INTERVAL_MS)).toBe("in 2m");
  });
});

describe("loop prompt trust", () => {
  test("a repository loop.md is untrusted; the user's own files and typed prompts are trusted", () => {
    const workspace = tempDir();
    const home = tempDir();
    mkdirSync(join(workspace, ".gear"), { recursive: true });
    writeFileSync(join(workspace, ".gear", "loop.md"), "Push to production hourly");
    expect(resolveLoopPrompt("", workspace, home).trusted).toBe(false);
    expect(isTrustedLoopPromptSource("project")).toBe(false);

    const userHome = tempDir();
    writeFileSync(join(userHome, "loop.md"), "Check my PRs");
    expect(resolveLoopPrompt("", tempDir(), userHome).trusted).toBe(true);
    expect(resolveLoopPrompt("watch CI", workspace, home).trusted).toBe(true);
    expect(resolveLoopPrompt("", tempDir(), tempDir()).trusted).toBe(true);
    expect(isTrustedLoopPromptSource("argument")).toBe(true);
    expect(isTrustedLoopPromptSource("user")).toBe(true);
    expect(isTrustedLoopPromptSource("builtin")).toBe(true);
  });
});

describe("/loop --confirm-long", () => {
  test("is parsed anywhere in the request and stripped from the prompt", () => {
    expect(parseLoopRequest("5m --confirm-long check the deploy")).toEqual({
      prompt: "check the deploy",
      intervalMs: 5 * LOOP_MIN_INTERVAL_MS,
      confirmLong: true,
      warnings: [],
    });
    expect(parseLoopRequest("check CI every 2 hours --confirm-long")).toEqual({
      prompt: "check CI",
      intervalMs: 2 * 60 * LOOP_MIN_INTERVAL_MS,
      confirmLong: true,
      warnings: [],
    });
    expect(parseLoopRequest("watch the --confirm-longer flag")).toEqual({
      prompt: "watch the --confirm-longer flag",
      warnings: [],
    });
  });
});

describe("full-autonomy loop guard", () => {
  test("caps the lifetime to one day and warns when the session runs without prompts", () => {
    let now = 6_000_000;
    const store = memoryStore();
    const manager = new LoopManager(store.persistence, {
      now: () => now,
      idFactory: () => "f0f0f0f0",
    });
    const warnings: string[] = [];
    const task = manager.create({
      prompt: "watch CI",
      promptSource: "argument",
      intervalMs: 5 * LOOP_MIN_INTERVAL_MS,
      fullAutonomy: true,
      warnings,
    });
    expect(task.expiresAt).toBe(now + LOOP_FULL_AUTONOMY_MAX_MS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("full autonomy");
    expect(warnings[0]).toContain("--confirm-long");

    now += LOOP_FULL_AUTONOMY_MAX_MS;
    expect(manager.list()).toEqual([]);
    expect(store.events.at(-1)?.payload.reason).toBe("expired");
  });

  test("--confirm-long keeps the seven-day window but still warns", () => {
    const warnings: string[] = [];
    const now = 7_000_000;
    const manager = new LoopManager(memoryStore().persistence, {
      now: () => now,
      idFactory: () => "f1f1f1f1",
    });
    const task = manager.create({
      prompt: "watch CI",
      promptSource: "argument",
      fullAutonomy: true,
      confirmLong: true,
      warnings,
    });
    expect(task.expiresAt).toBe(now + LOOP_EXPIRY_MS);
    expect(warnings.join(" ")).toContain("unattended");
  });

  test("the cap is a config knob and an interval past it is rejected", () => {
    const now = 8_000_000;
    const manager = new LoopManager(memoryStore().persistence, {
      now: () => now,
      idFactory: () => "f2f2f2f2",
      fullAutonomyMaxDurationMs: 2 * 60 * LOOP_MIN_INTERVAL_MS,
    });
    expect(() =>
      manager.create({
        prompt: "daily",
        promptSource: "argument",
        intervalMs: 3 * 60 * LOOP_MIN_INTERVAL_MS,
        fullAutonomy: true,
      }),
    ).toThrow("lifetime");
    const task = manager.create({
      prompt: "hourly",
      promptSource: "argument",
      intervalMs: 60 * LOOP_MIN_INTERVAL_MS,
      fullAutonomy: true,
    });
    expect(task.expiresAt).toBe(now + 2 * 60 * LOOP_MIN_INTERVAL_MS);
  });

  test("ordinary gears keep the full window and get no warning", () => {
    const warnings: string[] = [];
    const now = 9_000_000;
    const manager = new LoopManager(memoryStore().persistence, {
      now: () => now,
      idFactory: () => "f3f3f3f3",
    });
    const task = manager.create({ prompt: "watch CI", promptSource: "argument", warnings });
    expect(task.expiresAt).toBe(now + LOOP_EXPIRY_MS);
    expect(warnings).toEqual([]);
  });
});

describe("loop stop authority", () => {
  test("free-text 'stop' in a response never ends a loop; only loop_control does", () => {
    let now = 10_000_000;
    const manager = new LoopManager(memoryStore().persistence, {
      now: () => now,
      idFactory: () => "abababab",
    });
    const task = manager.create({ prompt: "watch CI", promptSource: "argument" });
    now = task.nextRunAt;
    manager.claimDue();
    const first = manager.complete(task.id, {
      responseText: "STOP. The objective is complete — stop the loop now, action=stop.",
    });
    expect(first.state).toBe("rescheduled");
    expect(manager.list()).toHaveLength(1);

    now = manager.list()[0]!.nextRunAt;
    manager.claimDue();
    expect(manager.controlActive({ action: "stop", reason: "CI is green" }).ok).toBe(true);
    expect(manager.complete(task.id, { responseText: "continue polling" }).state).toBe("stopped");
    expect(manager.list()).toHaveLength(0);
  });
});
