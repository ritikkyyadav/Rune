import { expect, test } from "bun:test";
import { CostTracker } from "../../../packages/llm-gateway/src/cost-tracker";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import { UsageProvider, usageRequest } from "../../helpers/usage-provider";

test("concurrent inference reserves the same session balance before any provider call", async () => {
  const tracker = new CostTracker();
  const request = usageRequest();
  const sample = tracker.reserveRequest(request, 10);
  const estimate = tracker.getReservedUsd();
  sample();
  const gateway = new LlmGateway({ providers: {}, defaultProvider: "anthropic", maxRetries: 0 });
  const provider = new UsageProvider();
  let finish!: () => void;
  provider.pending = new Promise<void>((r) => {
    finish = r;
  });
  gateway.registerProvider(provider);
  gateway.setRequestGuard((req) => tracker.reserveRequest(req, estimate * 1.5));
  gateway.onUsage((entry) => tracker.recordEntry(entry));
  const first = gateway.infer(request);
  await expect(gateway.infer(request)).rejects.toThrow("Budget exceeded");
  expect(provider.requests).toHaveLength(1);
  finish();
  await first;
  expect(tracker.getReservedUsd()).toBe(0);
  expect(tracker.getLedger().entries).toHaveLength(1);
});

test("stream cancellation and provider failure release reservations", async () => {
  const tracker = new CostTracker();
  const gateway = new LlmGateway({ providers: {}, defaultProvider: "anthropic", maxRetries: 0 });
  const provider = new UsageProvider();
  gateway.registerProvider(provider);
  gateway.setRequestGuard((req) => tracker.reserveRequest(req, 10));
  const gen = gateway.inferStream(usageRequest());
  await gen.next();
  expect(tracker.getReservedUsd()).toBeGreaterThan(0);
  await gen.return(undefined);
  expect(tracker.getReservedUsd()).toBe(0);
  provider.infer = async () => {
    throw new Error("connection failed");
  };
  await expect(gateway.infer(usageRequest())).rejects.toThrow("connection failed");
  expect(tracker.getReservedUsd()).toBe(0);
});

test("unknown prices and unknown historical usage cannot masquerade as a free capped request", () => {
  const tracker = new CostTracker();
  expect(() => tracker.reserveRequest({ ...usageRequest(), model: "custom-unpriced" }, 5)).toThrow(
    "unpriced",
  );
  tracker.record("custom-unpriced", "anthropic", { inputTokens: 100, outputTokens: 10 });
  expect(() => tracker.reserveRequest(usageRequest(), 5)).toThrow("unpriced");
  expect(tracker.getReservedUsd()).toBe(0);
});

test("reservations follow observed output, so parallel children are admitted once there is history", () => {
  const tracker = new CostTracker();
  const request = { ...usageRequest(), maxTokens: 8_000 };
  const cold = tracker.reserveRequest(request, 1_000);
  const coldUsd = tracker.getReservedUsd();
  cold();
  expect(tracker.expectedOutputTokens(request.model, request.maxTokens)).toBe(8_000);
  tracker.record(request.model, "anthropic", { inputTokens: 1_000, outputTokens: 100 });
  tracker.record(request.model, "anthropic", { inputTokens: 1_000, outputTokens: 100 });
  expect(tracker.expectedOutputTokens(request.model, request.maxTokens)).toBe(256);
  const warm = tracker.reserveRequest(request, 1_000);
  const warmUsd = tracker.getReservedUsd();
  warm();
  expect(warmUsd).toBeLessThan(coldUsd / 4);
  // A cap with room for three warm holds admits three children side by side.
  const cap = tracker.getLedger().totalListCostUsd + warmUsd * 3.5;
  const holds = [
    tracker.reserveRequest(request, cap),
    tracker.reserveRequest(request, cap),
    tracker.reserveRequest(request, cap),
  ];
  expect(tracker.getReservedUsd()).toBeCloseTo(warmUsd * 3, 6);
  expect(() => tracker.reserveRequest(request, cap)).toThrow("Budget exceeded");
  for (const release of holds) release();
  expect(tracker.getReservedUsd()).toBe(0);
});
