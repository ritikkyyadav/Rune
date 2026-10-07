import { afterAll, expect, test } from "bun:test";
import {
  AutoModeSafetyController,
  SUPERVISOR_UNANSWERED_AT_EXIT,
  resolveAutoModeConfig,
  type ClassifierCall,
} from "../../../packages/orchestrator/src/auto-mode";
import {
  ReviewSlots,
  SupervisorQueue,
  type SupervisedItem,
} from "../../../packages/orchestrator/src/supervisor-queue";
import type { LlmGateway } from "@rune/llm-gateway";
import {
  resetSandboxCapabilityForTest,
  setSandboxCapability,
} from "../../../packages/tool-registry/src/sandbox-capability";
import {
  resetSandboxPolicyForTest,
  setSandboxMode,
} from "../../../packages/tool-registry/src/sandbox-mode";

// These tests are about the supervisor queue, not about the machine. Auto
// mode's shell decision reads two process-wide facts — the sandbox mode and
// whether an isolation backend exists — and since 2026-09-07 an uncontained
// shell routes every writable command to the reviewer instead of the supervised
// tier. On the Linux CI runner nothing had probed capability, so `bun test`
// came back "ask" where macOS said "allow". State the contained machine the
// scenarios were written against, the way auto-mode-shell-tier.test.ts does.
setSandboxMode("auto-allow");
setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });
// bun runs every file in one process: give the state back when this file ends.
afterAll(() => {
  resetSandboxPolicyForTest();
  resetSandboxCapabilityForTest();
});

test("a burst shares one review, keeps all call IDs, and never caches a later approval", async () => {
  const calls: ClassifierCall[] = [];
  const controller = new AutoModeSafetyController(
    resolveAutoModeConfig({ supervisor: "all" }),
    {
      async classify(call) {
        calls.push(call);
        return "ALLOW";
      },
    },
    () => ({ gateway: {} as LlmGateway, provider: "anthropic", model: "mock" }),
  );
  const run = controller.startRun(["Run the existing tests."]);
  const action = (id: number) => ({
    callId: `test-${id}`,
    toolName: "bash",
    args: { command: "bun test tests/unit" },
    workspaceRoot: "/tmp/rune-review-tests",
    schema: {
      name: "bash",
      version: "1",
      description: "shell",
      inputSchema: { type: "object" },
      category: "execute" as const,
      permissionLevel: "sandbox" as const,
    },
  });
  for (let i = 0; i < 25; i++) expect((await run.review(action(i))).verdict).toBe("allow");
  await run.drainSupervisor();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.prompt).toContain("test-0");
  expect(calls[0]!.prompt).toContain("test-24");
  expect(calls[0]!.system).toContain("EVERY");
  await run.review(action(25));
  await run.drainSupervisor();
  expect(calls).toHaveLength(2);
});

test("all payloads are retained, authorization epochs split batches, and overflow refuses admission", async () => {
  const batches: Array<SupervisedItem[]> = [];
  const queue = new SupervisorQueue<SupervisedItem>(async (batch) => {
    batches.push(batch);
  }, 12);
  for (let i = 0; i < 12; i++)
    expect(queue.enqueue({ key: `payload-${i}`, epoch: i < 5 ? 0 : 1, chars: 10 })).toBe(true);
  expect(queue.enqueue({ key: "overflow", epoch: 1, chars: 10 })).toBe(false);
  await queue.drain();
  expect(batches.flat().map((x) => x.key)).toEqual(
    Array.from({ length: 12 }, (_, i) => `payload-${i}`),
  );
  expect(batches.every((batch) => new Set(batch.map((x) => x.epoch)).size === 1)).toBe(true);
  // B3 — every admitted item carries when it entered and when it left, so a
  // wait is a number rather than an impression.
  for (const item of batches.flat()) {
    expect(typeof item.enqueuedAt).toBe("number");
    expect(typeof item.dequeuedAt).toBe("number");
    expect(item.dequeuedAt!).toBeGreaterThanOrEqual(item.enqueuedAt!);
  }
});

test("B3 — the queue reports how long the oldest observation has waited", async () => {
  // A hand-wound clock: the wait is the thing under test, so it must not be
  // whatever the machine happened to do between two ticks.
  let clock = 1_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: Array<Array<SupervisedItem>> = [];
  const queue = new SupervisorQueue<SupervisedItem>(
    async (batch) => {
      seen.push(batch);
      await gate;
    },
    64,
    () => clock,
  );

  // Nothing waiting, nothing to report.
  expect(queue.oldestWaitMs()).toBe(0);
  expect(queue.lastWaitMs).toBe(0);

  queue.enqueue({ key: "first", epoch: 0, chars: 10 });
  clock += 4_200;
  queue.enqueue({ key: "second", epoch: 0, chars: 10 });
  // The OLDEST is what a refusal is explained with, not the newest.
  expect(queue.oldestWaitMs()).toBe(4_200);
  expect(queue.size).toBe(2);

  clock += 800;
  release();
  await queue.drain();
  // Both left at 5,000: the first waited 5,000 ms, the second 800 ms, and the
  // last one out is what `lastWaitMs` reports.
  expect(seen.flat().map((i) => i.dequeuedAt! - i.enqueuedAt!)).toEqual([5_000, 800]);
  expect(queue.lastWaitMs).toBe(800);
  expect(queue.oldestWaitMs()).toBe(0);
});

test("background requests share two slots across runs and release on failure", async () => {
  const slots = new ReviewSlots(2);
  let active = 0,
    peak = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 25 }, (_, i) =>
      slots.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        if (i === 2) throw new Error("reviewer outage");
      }),
    ),
  );
  expect(peak).toBe(2);
  expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
});

test("a slow reviewer never denies ordinary work; what went unsupervised is written down", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: ClassifierCall[] = [];
  const controller = new AutoModeSafetyController(
    resolveAutoModeConfig({ supervisor: "all" }),
    {
      async classify(call) {
        calls.push(call);
        await gate;
        return "ALLOW";
      },
    },
    () => ({ gateway: {} as LlmGateway, provider: "anthropic", model: "mock" }),
  );
  const rows: Array<{ source: string; verdict: string; reason: string; queueWaitMs?: number }> = [];
  controller.setDecisionObserver((review) =>
    rows.push({
      source: review.source,
      verdict: review.verdict,
      reason: review.reason,
      queueWaitMs: review.timings?.queueWaitMs,
    }),
  );
  const run = controller.startRun(["Read the whole tree."]);
  const action = (id: number) => ({
    callId: `read-${id}`,
    toolName: "bash",
    // A script over each file rather than a bare `cat`: pure reads take the
    // safe tier and are never queued for the supervisor at all.
    args: { command: `python3 lint.py file-${id}.ts` },
    workspaceRoot: "/tmp/rune-review-tests",
    schema: {
      name: "bash",
      version: "1",
      description: "shell",
      inputSchema: { type: "object" },
      category: "execute" as const,
      permissionLevel: "sandbox" as const,
    },
  });
  const verdicts: string[] = [];
  for (let i = 0; i < 200; i++) verdicts.push((await run.review(action(i))).verdict);
  expect(verdicts.every((v) => v === "allow")).toBe(true);
  const skipped = rows.filter((r) => r.source === "supervisor_skipped");
  expect(skipped.length).toBeGreaterThan(0);
  expect(skipped.every((r) => r.verdict === "allow")).toBe(true);
  expect(skipped[0]!.reason).toMatch(/waiting on the reviewer/);
  // B3 — the wait the skip is explained WITH, on the rows that actually
  // exist. The integration arm this claim first shipped in produced zero
  // skipped rows, so its `for (const d of skips)` asserted nothing at all;
  // the overflow is forced here instead, and the list is checked for being
  // non-empty before it is checked for being right.
  const waits = skipped.map((r) => r.queueWaitMs);
  expect(waits.length).toBeGreaterThan(0);
  expect(waits.every((w) => typeof w === "number" && Number.isFinite(w) && w >= 0)).toBe(true);
  // Monotonic: the head of the queue cannot change while the reviewer is
  // gated, so every later skip is explained by a wait at least as long as the
  // one before it. A wait that went backwards would mean the number described
  // some other item.
  const ordered = waits as number[];
  for (let i = 1; i < ordered.length; i++)
    expect(ordered[i]!).toBeGreaterThanOrEqual(ordered[i - 1]!);
  // And it is the queue's own clock, not a placeholder: the reason string
  // quotes the same number the audit row carries.
  expect(skipped.at(-1)!.reason).toMatch(/the oldest for \d+\.\d+s/);
  release();
  await run.drainSupervisor();
  expect(calls.length).toBeGreaterThan(0);
});

test("a repeat of a shape already waiting rides along at capacity; a new shape does not", () => {
  const queue = new SupervisorQueue<{ key: string; epoch: number; chars: number }>(async () => {
    await new Promise(() => {});
  }, 2);
  expect(queue.enqueue({ key: "a", epoch: 0, chars: 1 })).toBe(true);
  expect(queue.enqueue({ key: "b", epoch: 0, chars: 1 })).toBe(true);
  expect(queue.enqueue({ key: "c", epoch: 0, chars: 1 })).toBe(false);
  expect(queue.enqueue({ key: "a", epoch: 0, chars: 1 })).toBe(true);
  expect(queue.size).toBe(3);
});

// ─── What the supervisor never read ───
//
// The supervisor is not waited for. A headless run exits when its work is
// done, so whatever is still queued, or with the reviewer and unanswered, is
// never read — and until 2026-10-07 nothing said so: each of those actions
// kept the row it was given when it ran, "allowed under supervision".

test("an abandoned queue hands back the batch in flight and everything waiting, and takes nothing more", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reviewed: string[][] = [];
  const queue = new SupervisorQueue<SupervisedItem>(async (batch) => {
    reviewed.push(batch.map((item) => item.key));
    await gate;
  });
  // Two epochs, so the first review takes two and three are left waiting.
  for (const [key, epoch] of [
    ["a", 0],
    ["b", 0],
    ["c", 1],
    ["d", 1],
    ["e", 1],
  ] as const)
    expect(queue.enqueue({ key, epoch, chars: 1 })).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(reviewed).toEqual([["a", "b"]]);

  // In flight first, then waiting, oldest first: all five, and none twice.
  expect(queue.abandon().map((item) => item.key)).toEqual(["a", "b", "c", "d", "e"]);
  expect(queue.size).toBe(0);
  expect(queue.abandon()).toEqual([]);
  // Nothing is admitted after, and what was waiting is never sent.
  expect(queue.enqueue({ key: "late", epoch: 1, chars: 1 })).toBe(false);
  release();
  await queue.drain();
  expect(reviewed).toEqual([["a", "b"]]);
});

function supervisedRun(classify: (call: ClassifierCall) => Promise<string>) {
  const controller = new AutoModeSafetyController(
    resolveAutoModeConfig({ supervisor: "all" }),
    { classify },
    () => ({ gateway: {} as LlmGateway, provider: "anthropic", model: "mock" }),
  );
  const rows: Array<{ source: string; verdict: string; callId?: string; reason: string }> = [];
  controller.setDecisionObserver((review) =>
    rows.push({
      source: review.source,
      verdict: review.verdict,
      callId: review.callId,
      reason: review.reason,
    }),
  );
  const action = (id: number) => ({
    callId: `lint-${id}`,
    toolName: "bash",
    // A script per file, not a bare read: pure reads take the safe tier and
    // are never queued for the supervisor at all.
    args: { command: `python3 lint.py file-${id}.ts` },
    workspaceRoot: "/tmp/rune-review-tests",
    schema: {
      name: "bash",
      version: "1",
      description: "shell",
      inputSchema: { type: "object" },
      category: "execute" as const,
      permissionLevel: "sandbox" as const,
    },
  });
  return { run: controller.startRun(["Lint the tree."]), rows, action };
}

test("when the process leaves, every action the supervisor had not answered is handed back as unanswered", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: ClassifierCall[] = [];
  const { run, rows, action } = supervisedRun(async (call) => {
    calls.push(call);
    await gate; // a reviewer that has not come back yet
    return "ALLOW";
  });
  for (let i = 0; i < 5; i++) {
    expect((await run.review(action(i))).verdict).toBe("allow");
    await new Promise((resolve) => setTimeout(resolve, 15)); // each lands after the last batch left
  }
  // The premise: the reviewer was asked, and has answered nothing.
  expect(calls.length).toBeGreaterThan(0);
  expect(rows.filter((r) => r.source.startsWith("supervisor_"))).toEqual([]);

  const unanswered = run.abandonSupervisor();
  // One row per action — the one with the reviewer and the four behind it.
  expect(unanswered.map((u) => u.review.callId).sort()).toEqual([
    "lint-0",
    "lint-1",
    "lint-2",
    "lint-3",
    "lint-4",
  ]);
  for (const { action: a, review } of unanswered) {
    expect(a.callId).toBe(review.callId);
    expect(review).toMatchObject({
      verdict: "allow",
      source: "supervisor_skipped",
      reason: SUPERVISOR_UNANSWERED_AT_EXIT,
      stage: 0,
      durationMs: 0,
    });
    expect(review.tier).toBeDefined();
    expect(review.risk).toBeDefined();
    expect(review.timings!.queueWaitMs).toBeGreaterThanOrEqual(0);
  }
  // Asked twice, it has nothing more to say.
  expect(run.abandonSupervisor()).toEqual([]);

  // The reviewer answers after all. Nothing can act on it now, and the
  // actions are already written down as unanswered: no verdict is recorded
  // beside that, and nothing that was waiting is sent.
  const asked = calls.length;
  release();
  await run.drainSupervisor();
  expect(rows.filter((r) => r.source.startsWith("supervisor_"))).toEqual([]);
  expect(calls.length).toBe(asked);
  expect(run.takePendingSupervisorHalt()).toBeNull();
});

test("an action the supervisor did answer is not also called unanswered", async () => {
  const { run, rows, action } = supervisedRun(async () => "ALLOW");
  expect((await run.review(action(0))).verdict).toBe("allow");
  await run.drainSupervisor();
  expect(rows.filter((r) => r.source === "supervisor_screen")).toHaveLength(1);
  expect(run.abandonSupervisor()).toEqual([]);
});

test("after it is let go, an action that still runs is recorded as unwatched, not queued", async () => {
  const { run, rows, action } = supervisedRun(async () => "ALLOW");
  run.abandonSupervisor();
  expect((await run.review(action(7))).verdict).toBe("allow");
  await run.drainSupervisor();
  const skipped = rows.filter((r) => r.source === "supervisor_skipped");
  expect(skipped).toHaveLength(1);
  expect(skipped[0]!.callId).toBe("lint-7");
  // For the reason it was: not a full queue, which is what a refused
  // observation is called everywhere else.
  expect(skipped[0]!.reason).toContain("its reviewer had been let go");
  expect(skipped[0]!.reason).not.toContain("waiting on the reviewer");
  expect(rows.filter((r) => r.source === "supervisor_screen")).toEqual([]);
});

test("a review that failed before the exit is not blamed on the exit", async () => {
  const { run, rows, action } = supervisedRun(async () => {
    throw new Error("reviewer unreachable");
  });
  expect((await run.review(action(0))).verdict).toBe("allow");
  await run.drainSupervisor();
  // The premise. A reviewer that cannot be reached leaves no row of its own
  // today — a gap of its own, and not this test's. What is pinned here is that
  // the exit does not claim it: that row says the run ended first, and this
  // review had failed while the run was still going.
  expect(rows.filter((r) => r.source.startsWith("supervisor_"))).toEqual([]);
  expect(run.abandonSupervisor()).toEqual([]);
});

test("an action the screen flagged is not called unanswered while its confirmation is out", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let confirming = false;
  const { run, rows, action } = supervisedRun(async (call) => {
    if (call.stage === "fast") return "BLOCK";
    confirming = true;
    await gate; // the confirmation that would latch a halt, not back yet
    return JSON.stringify({
      verdict: "deny",
      risk: "critical",
      confidence: "high",
      reason: "It sends the workspace somewhere the user never named.",
    });
  });
  expect((await run.review(action(0))).verdict).toBe("allow");
  for (let i = 0; i < 300 && !confirming; i++) await new Promise((r) => setTimeout(r, 10));
  // The premise: the screen answered, on the record, and the second opinion
  // is still with the reviewer.
  expect(confirming).toBe(true);
  expect(rows.filter((r) => r.source.startsWith("supervisor_"))).toMatchObject([
    { source: "supervisor_screen", verdict: "deny", callId: "lint-0" },
  ]);

  // The process leaves. This action HAS an answer — a flag — so it is not
  // among the unanswered, and its row is the flag.
  expect(run.abandonSupervisor()).toEqual([]);

  // The confirmation lands on a run that is gone: not recorded, and no halt
  // is latched for a next action there will never be.
  release();
  await run.drainSupervisor();
  expect(rows.filter((r) => r.source === "supervisor_reasoned")).toEqual([]);
  expect(run.takePendingSupervisorHalt()).toBeNull();
});
