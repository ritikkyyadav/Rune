/**
 * P3B I6b — an incident must name the completion that paid for it.
 *
 * The black box holds 3,284 gateway incidents, 1,417 of them provider rate
 * limits, against 15 recorded retries in the cost ledger: two stores with no
 * join, so "what did this incident cost" had no answer. I6b's answer is that
 * the incident carries the request's role and the stamp its cost row carries.
 *
 * The first version stamped the incident with the ATTEMPT's start, which cannot
 * work by construction: the incident is raised by the attempt that FAILED and
 * the cost row is written by the attempt that ANSWERED, so the two stamps were
 * guaranteed to differ on exactly the rate-limited requests the join exists for
 * — by 2 ms in a test and by whole seconds under real back-off (V-L0 #21). The
 * stamp is the CALL's now.
 *
 * The property I3 must keep through that change is the opposite one: `latencyMs`
 * is still the answering attempt's own busy time, never the whole ladder,
 * because a request that waited out two back-offs was not slow at the provider.
 */

import { expect, test } from "bun:test";

import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import type {
  CostEntry,
  GatewayIncidentEvent,
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
} from "../../../packages/llm-gateway/src/types";

/** A provider that fails `failures` times with `status`, then answers. */
function flakyProvider(opts: { failures: number; status: number; serveMs?: number }): LlmProvider {
  let calls = 0;
  return {
    name: "anthropic",
    async infer(request: InferenceRequest): Promise<InferenceResponse> {
      calls++;
      if (calls <= opts.failures) {
        const err = Object.assign(new Error("rate limited"), { status: opts.status });
        throw err;
      }
      if (opts.serveMs) await new Promise((r) => setTimeout(r, opts.serveMs));
      return {
        id: "x",
        model: request.model,
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 1 },
      } as InferenceResponse;
    },
    async *inferStream() {},
    async countTokens() {
      return 1;
    },
    async healthCheck() {
      return true;
    },
  } as unknown as LlmProvider;
}

function rig(provider: LlmProvider, retryBaseMs = 0) {
  const incidents: GatewayIncidentEvent[] = [];
  const entries: CostEntry[] = [];
  const gateway = new LlmGateway({
    providers: {},
    defaultProvider: "anthropic",
    maxRetries: 2,
    retryBaseMs,
    onIncident: (i) => incidents.push(i),
  });
  gateway.registerProvider(provider);
  gateway.onUsage((e) => entries.push(e));
  return { gateway, incidents, entries };
}

const REQUEST = {
  stream: false,
  role: "primary",
  model: "claude-sonnet-5",
  provider: "anthropic",
  maxTokens: 100,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as unknown as InferenceRequest;

test("a rate-limited request's incident carries the stamp its cost row carries", async () => {
  const { gateway, incidents, entries } = rig(flakyProvider({ failures: 1, status: 429 }));
  await gateway.infer(REQUEST);

  expect(incidents.length).toBe(1);
  expect(entries.length).toBe(1);
  expect(incidents[0]!.kind).toBe("retry");
  // What the incident was FOR.
  expect(incidents[0]!.role).toBe("primary");
  // The join itself: this equality is I6b.
  expect(incidents[0]!.requestStartedAt).toBe(entries[0]!.startedAt!.toISOString());
});

test("two retries raise two incidents and both join to the one completion", async () => {
  const { gateway, incidents, entries } = rig(flakyProvider({ failures: 2, status: 500 }));
  await gateway.infer(REQUEST);

  expect(incidents.length).toBe(2);
  expect(entries.length).toBe(1);
  const stamp = entries[0]!.startedAt!.toISOString();
  // A call is one row however many attempts it took, so every incident it
  // raised resolves to the same completion.
  for (const incident of incidents) expect(incident.requestStartedAt).toBe(stamp);
});

test("latency stays the answering attempt's own, not the whole retry ladder", async () => {
  // 40 ms of back-off before the second attempt, which then answers promptly.
  const { gateway, entries } = rig(flakyProvider({ failures: 1, status: 500 }), 40);
  await gateway.infer(REQUEST);

  const row = entries[0]!;
  const wallClock = row.timestamp.getTime() - row.startedAt!.getTime();
  expect(wallClock).toBeGreaterThanOrEqual(40);
  // The provider was busy for a fraction of that — the back-off is the
  // harness's wait, not the provider's latency (P3B I3).
  expect(row.latencyMs!).toBeLessThan(wallClock);
  // And the attempt that answered is named, so the two numbers reconcile.
  expect(row.attemptStartedAt).toBeInstanceOf(Date);
  expect(row.latencyMs).toBe(row.timestamp.getTime() - row.attemptStartedAt!.getTime());
  expect(row.attemptStartedAt!.getTime()).toBeGreaterThan(row.startedAt!.getTime());
});

test("a call that went out once carries no second stamp to explain", async () => {
  const { gateway, incidents, entries } = rig(flakyProvider({ failures: 0, status: 429 }));
  await gateway.infer(REQUEST);

  expect(incidents.length).toBe(0);
  const row = entries[0]!;
  // Absent, not a duplicate: `startedAt` is already the attempt's stamp, and
  // the invariant a reader assumes holds unconditionally here.
  expect(row.attemptStartedAt).toBeUndefined();
  expect(row.latencyMs).toBe(row.timestamp.getTime() - row.startedAt!.getTime());
});

test("a request that exhausts its retries records incidents and no completion", async () => {
  const { gateway, incidents, entries } = rig(flakyProvider({ failures: 9, status: 500 }));
  await expect(gateway.infer(REQUEST)).rejects.toThrow();

  // Two retries, then the ladder ends. Nothing answered, so nothing is billed
  // — the incidents are the whole record, and they still agree on one stamp.
  expect(entries.length).toBe(0);
  expect(incidents.length).toBe(2);
  expect(new Set(incidents.map((i) => i.requestStartedAt)).size).toBe(1);
});
