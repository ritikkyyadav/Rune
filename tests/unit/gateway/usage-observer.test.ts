import { expect, test } from "bun:test";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import type { CostEntry } from "../../../packages/llm-gateway/src/types";
import { UsageProvider, usageRequest } from "../../helpers/usage-provider";

test("one accounting boundary covers helper and streamed calls, isolates observers, and guards the next attempt", async () => {
  const gateway = new LlmGateway({
    providers: {},
    defaultProvider: "anthropic",
    maxRetries: 2,
    retryBaseMs: 1,
  });
  const provider = new UsageProvider();
  gateway.registerProvider(provider);
  const entries: CostEntry[] = [];
  gateway.onUsage(() => {
    throw new Error("broken consumer");
  });
  const unsubscribe = gateway.onUsage((entry) => entries.push(entry));
  const result = await gateway.infer(usageRequest());
  expect(result.content).toHaveLength(1);
  for await (const _ of gateway.inferStream(usageRequest())) {
    /* drain */
  }
  expect(entries).toHaveLength(2);
  expect(entries.every((entry) => entry.listCostUsd > 0)).toBe(true);
  gateway.setRequestGuard(() => {
    throw new Error("shared budget exhausted");
  });
  await expect(gateway.infer(usageRequest())).rejects.toThrow("shared budget exhausted");
  const stream = async () => {
    for await (const _ of gateway.inferStream(usageRequest())) {
      /* drain */
    }
  };
  await expect(stream()).rejects.toThrow("shared budget exhausted");
  expect(provider.requests).toHaveLength(2);
  gateway.setRequestGuard(() => {});
  unsubscribe();
  await gateway.infer(usageRequest());
  expect(entries).toHaveLength(2);
});
