/**
 * Phase 3B Lane 0, gateway half: every usage row says what it was FOR, how
 * long the provider was busy, and what it asked the cache to do.
 *
 * The measurement this answers (docs/program/phase-3-auto-efficiency.md §4):
 *
 *  - I1 — 437 of 2,931 cost rows carried a role. `InferenceRequest.role` was
 *    optional and absent meant `primary`, so anything that did not say was
 *    silently filed as the user's work and the other 85% had to be inferred
 *    from the event sequence around it.
 *  - I3 — a cost row carried `timestamp` and nothing else, so per-completion
 *    wall clock was the gap between consecutive rows: it charged a completion
 *    for the tool time before it and could not see a concurrent caller at all.
 *  - I5 — `cacheCreationTokens` is 0 on every one of those 2,931 rows, so "what
 *    did warming the cache cost" had no answer, and a miss could not be told
 *    apart from a breakpoint that moved or a prefix something rewrote.
 *
 * None of this changes a request. The `@ts-expect-error` cases are the point of
 * I1 and only fail under `tsc` — the strict scratch pass over this file is what
 * proves the type has teeth, not the runtime.
 */

import { expect, test } from "bun:test";
import { CostTracker } from "../../../packages/llm-gateway/src/cost-tracker";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import { measureComposition } from "../../../packages/llm-gateway/src/prompt-composition";
import type { CallRole, InferenceRequest, Message } from "../../../packages/llm-gateway/src/types";
import { UsageProvider, usageRequest } from "../../helpers/usage-provider";

const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };

function gatewayWith(provider: UsageProvider): LlmGateway {
  const gateway = new LlmGateway({ providers: {}, defaultProvider: "anthropic", maxRetries: 0, retryBaseMs: 0 });
  gateway.registerProvider(provider);
  return gateway;
}

// ─── I1: a usage row without a role cannot be constructed ───

test("I1 — a request without a role does not compile", () => {
  const request = {
    stream: true,
    model: "claude-sonnet-5",
    provider: "anthropic",
    maxTokens: 100,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  } as const;
  // @ts-expect-error — `role` is required on InferenceRequest (P3B I1).
  const untagged: InferenceRequest = request;
  expect(untagged.model).toBe("claude-sonnet-5");
});

test("I1 — a cost row cannot be recorded without saying what it was for", () => {
  const tracker = new CostTracker();
  // @ts-expect-error — the attribution argument is required, and carries `role`.
  expect(() => tracker.record("claude-sonnet-5", "anthropic", usage)).toThrow();
  // @ts-expect-error — an attribution without a role is not an attribution.
  expect(() => tracker.record("claude-sonnet-5", "anthropic", usage, {})).not.toThrow();
});

test("I1 — every role the vocabulary names rides onto its row unchanged", async () => {
  const roles: CallRole[] = [
    "primary",
    "classifier",
    "supervisor",
    "summarizer",
    "intent",
    "memory",
    "repair",
    "subagent",
    "research",
  ];
  const provider = new UsageProvider();
  const gateway = gatewayWith(provider);
  const seen: CallRole[] = [];
  gateway.onUsage((entry) => seen.push(entry.role));
  for (const role of roles) await gateway.infer({ ...usageRequest(), stream: false, role });
  expect(seen).toEqual(roles);
});

test("I1 — a streamed completion is tagged the same as a blocking one", async () => {
  const provider = new UsageProvider();
  const gateway = gatewayWith(provider);
  const seen: CallRole[] = [];
  gateway.onUsage((entry) => seen.push(entry.role));
  for await (const _ of gateway.inferStream({ ...usageRequest(), role: "subagent" })) void _;
  expect(seen).toEqual(["subagent"]);
});

// ─── I3: when the provider was actually busy ───

test("I3 — a recorded row carries the request's start and its own latency", async () => {
  const provider = new UsageProvider();
  let release!: () => void;
  provider.pending = new Promise<void>((r) => {
    release = r;
  });
  const gateway = gatewayWith(provider);
  const rows: Array<{ startedAt?: Date; latencyMs?: number; timestamp: Date }> = [];
  gateway.onUsage((entry) => rows.push(entry));
  const inFlight = gateway.infer({ ...usageRequest(), stream: false, role: "primary" });
  await new Promise((r) => setTimeout(r, 25));
  release();
  await inFlight;

  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.startedAt).toBeInstanceOf(Date);
  expect(typeof row.latencyMs).toBe("number");
  // The interval is the provider's own, not the caller's clock after the fact.
  expect(row.latencyMs!).toBeGreaterThanOrEqual(20);
  expect(row.startedAt!.getTime()).toBeLessThanOrEqual(row.timestamp.getTime());
  expect(row.latencyMs).toBe(row.timestamp.getTime() - row.startedAt!.getTime());
});

test("I3 — a concurrent caller's latency is its own, not the gap to the next row", async () => {
  // The defect this closes: with only `timestamp`, a completion is charged the
  // interval since the previous cost row, so an out-of-band reviewer running
  // beside the agent reads as the agent's wall clock. Two overlapping requests
  // whose recorded windows OVERLAP can only be seen with a start stamp.
  const provider = new UsageProvider();
  let release!: () => void;
  provider.pending = new Promise<void>((r) => {
    release = r;
  });
  const gateway = gatewayWith(provider);
  const rows: Array<{ role: CallRole; startedAt?: Date; timestamp: Date }> = [];
  gateway.onUsage((entry) => rows.push(entry));
  const a = gateway.infer({ ...usageRequest(), stream: false, role: "primary" });
  const b = gateway.infer({ ...usageRequest(), stream: false, role: "supervisor" });
  await new Promise((r) => setTimeout(r, 15));
  release();
  await Promise.all([a, b]);

  expect(rows).toHaveLength(2);
  const [first, second] = rows as [(typeof rows)[0], (typeof rows)[0]];
  expect(second.startedAt!.getTime()).toBeLessThanOrEqual(first.timestamp.getTime());
});

// ─── I5: what the request asked the cache to do ───

const stable: Message[] = [
  { role: "user", content: [{ type: "text", text: "the standing brief" }] },
  { role: "assistant", content: [{ type: "text", text: "understood" }] },
];

test("I5 — the composition records the cache breakpoint the caller actually sent", () => {
  const c = measureComposition({
    system: "doctrine",
    messages: stable,
    cacheBreakpointIndex: stable.length - 1,
  });
  expect(c.cacheBreakpointIndex).toBe(1);
  // Not invented when the caller marked none — absent reads as "no breakpoint".
  expect(measureComposition({ messages: stable }).cacheBreakpointIndex).toBeUndefined();
});

test("I5 — the prefix hash is stable across a growing tail and moves when history is rewritten", () => {
  const base = measureComposition({ system: "doctrine", tools: [], messages: stable });
  const sameStableNewTail = measureComposition({
    system: "doctrine",
    tools: [],
    messages: stable,
    planLedger: "a plan ledger that changes every turn",
    taskState: ["turn 4 of 40"],
  });
  // The ephemeral tail is NOT in the prefix: that is the whole point of the
  // breakpoint, and a hash that moved with the ledger would report a cache
  // miss on every single turn.
  expect(sameStableNewTail.prefixHash).toBe(base.prefixHash);

  const rewritten = measureComposition({
    system: "doctrine",
    tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "the standing brief, edited" }] },
      stable[1]!,
    ],
  });
  expect(rewritten.prefixHash).not.toBe(base.prefixHash);

  // A changed system prompt is a changed prefix even when the messages are not.
  const newDoctrine = measureComposition({ system: "doctrine+", tools: [], messages: stable });
  expect(newDoctrine.prefixHash).not.toBe(base.prefixHash);
  // Eight hex characters: a fingerprint, never a copy of the prompt.
  expect(base.prefixHash).toMatch(/^[0-9a-f]{8}$/);
});

test("I5 — cache read and write tokens land on the row, per role", async () => {
  const provider = new UsageProvider();
  const gateway = gatewayWith(provider);
  const byRole = new Map<CallRole, { read: number; write: number; breakpoint?: number }>();
  gateway.onUsage((entry) =>
    byRole.set(entry.role, {
      read: entry.cacheReadTokens,
      write: entry.cacheCreationTokens,
      breakpoint: entry.composition?.cacheBreakpointIndex,
    }),
  );

  const composition = measureComposition({
    system: "doctrine",
    messages: stable,
    cacheBreakpointIndex: 1,
  });
  provider.usage = {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 900,
    cacheCreationTokens: 100,
  };
  await gateway.infer({ ...usageRequest(), stream: false, role: "primary", composition });
  provider.usage = {
    inputTokens: 40,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  await gateway.infer({ ...usageRequest(), stream: false, role: "supervisor", composition });

  expect(byRole.get("primary")).toEqual({ read: 900, write: 100, breakpoint: 1 });
  expect(byRole.get("supervisor")).toEqual({ read: 0, write: 0, breakpoint: 1 });
});
