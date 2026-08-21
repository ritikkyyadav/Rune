import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LOOP_MAINTENANCE_PROMPT,
  LOOP_EVENT_DELETE,
  LOOP_EXPIRY_MS,
  LOOP_MIN_INTERVAL_MS,
  LoopManager,
  formatLoopDue,
  formatLoopInterval,
  parseLoopRequest,
  resolveLoopPrompt,
  type LoopEventRecord,
} from "../../../packages/orchestrator/src/loop-mode";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "elio-loop-test-"));
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
    mkdirSync(join(workspace, ".alan"), { recursive: true });
    writeFileSync(join(workspace, ".alan", "loop.md"), "Project loop instructions");
    writeFileSync(join(home, "loop.md"), "User loop instructions");

    const resolved = resolveLoopPrompt("", workspace, home);
    expect(resolved.source).toBe("project");
    expect(resolved.prompt).toBe("Project loop instructions");
  });

  test("ignores a symlinked project prompt and falls back safely", () => {
    const workspace = tempDir();
    const home = tempDir();
    mkdirSync(join(workspace, ".alan"), { recursive: true });
    writeFileSync(join(home, "loop.md"), "Safe user prompt");
    symlinkSync(join(home, "loop.md"), join(workspace, ".alan", "loop.md"));

    const resolved = resolveLoopPrompt("", workspace, home);
    expect(resolved.source).toBe("user");
    expect(resolved.prompt).toBe("Safe user prompt");
    expect(resolved.warning).toContain("symlink");
  });

  test("also rejects a symlinked .alan directory", () => {
    const workspace = tempDir();
    const redirected = tempDir();
    const home = tempDir();
    writeFileSync(join(redirected, "loop.md"), "Redirected project prompt");
    writeFileSync(join(home, "loop.md"), "Safe user prompt");
    symlinkSync(redirected, join(workspace, ".alan"));

    const resolved = resolveLoopPrompt("", workspace, home);
    expect(resolved.source).toBe("user");
    expect(resolved.prompt).toBe("Safe user prompt");
    expect(resolved.warning).toContain(".alan is a symlink");
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
