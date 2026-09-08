import { afterAll, expect, test } from "bun:test";
import {
  AutoModeSafetyController,
  resolveAutoModeConfig,
  type ClassifierCall,
} from "../../../packages/orchestrator/src/auto-mode";
import { ReviewSlots, SupervisorQueue } from "../../../packages/orchestrator/src/supervisor-queue";
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
  const batches: Array<Array<{ key: string; epoch: number; chars: number }>> = [];
  const queue = new SupervisorQueue(async (batch) => {
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
  const rows: Array<{ source: string; verdict: string; reason: string }> = [];
  controller.setDecisionObserver((review) =>
    rows.push({ source: review.source, verdict: review.verdict, reason: review.reason }),
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
