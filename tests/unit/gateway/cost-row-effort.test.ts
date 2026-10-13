/**
 * The reasoning effort a request asked for is on its cost row.
 *
 * Effort moves a call's price and its latency together, and it was the one
 * request setting the ledger could not see: a run at `medium` and a run at
 * `high` wrote identical rows. On Codex a CHANGE of effort between two calls
 * also costs the whole prompt cache (measured 2026-10-08), and that was
 * findable only as an unexplained row with 0 cached tokens.
 *
 * Read through the real gateway and a scripted provider: the field has to
 * arrive on the row a usage listener receives, on both request paths, because
 * the acting model streams and every safety reviewer does not.
 */

import { describe, expect, test } from "bun:test";

import { CostTracker, LlmGateway, requestedEffort } from "../../../packages/llm-gateway/src/index";
import type { CostEntry, InferenceRequest } from "../../../packages/llm-gateway/src/index";
import { UsageProvider, usageRequest } from "../../helpers/usage-provider";

function gateway() {
  const gw = new LlmGateway({
    providers: {},
    defaultProvider: "anthropic",
    maxRetries: 1,
    retryBaseMs: 1,
  });
  gw.registerProvider(new UsageProvider());
  const rows: CostEntry[] = [];
  gw.onUsage((entry) => rows.push(entry));
  return { gw, rows };
}

async function stream(gw: LlmGateway, request: InferenceRequest): Promise<void> {
  for await (const _ of gw.inferStream(request)) void _;
}

describe("requestedEffort", () => {
  test("the named level, `none` for thinking switched off, nothing for a request that said nothing", () => {
    expect(requestedEffort({ enabled: true, effort: "high" })).toBe("high");
    expect(requestedEffort({ enabled: true, effort: "medium" })).toBe("medium");
    expect(requestedEffort({ enabled: false })).toBe("none");
    // Switched off wins over a level left beside it.
    expect(requestedEffort({ enabled: false, effort: "max" })).toBe("none");
    expect(requestedEffort({ enabled: true })).toBeUndefined();
    expect(requestedEffort(undefined)).toBeUndefined();
  });
});

describe("the cost row a request leaves", () => {
  test("a streamed request carries the effort it asked for", async () => {
    const { gw, rows } = gateway();
    await stream(gw, { ...usageRequest(), thinking: { enabled: true, effort: "medium" } });
    await stream(gw, { ...usageRequest(), thinking: { enabled: true, effort: "high" } });
    expect(rows.map((r) => r.effort)).toEqual(["medium", "high"]);
  });

  test("so does one that was not streamed — the path every safety reviewer takes", async () => {
    const { gw, rows } = gateway();
    await gw.infer({
      ...usageRequest(),
      stream: false,
      role: "supervisor",
      thinking: { enabled: false },
    });
    await gw.infer({
      ...usageRequest(),
      stream: false,
      role: "classifier",
      thinking: { enabled: true, effort: "medium" },
    });
    expect(rows.map((r) => [r.role, r.effort])).toEqual([
      ["supervisor", "none"],
      ["classifier", "medium"],
    ]);
  });

  test("a request that set no effort leaves no field — absent is 'not said', never a level", async () => {
    const { gw, rows } = gateway();
    await stream(gw, usageRequest());
    expect(rows).toHaveLength(1);
    expect("effort" in rows[0]!).toBe(false);
  });

  test("a change of effort between two calls of one run is readable from the rows alone", async () => {
    const { gw, rows } = gateway();
    for (const effort of ["medium", "medium", "high", "high"] as const) {
      await stream(gw, { ...usageRequest(), thinking: { enabled: true, effort } });
    }
    const primary = rows.filter((r) => r.role === "primary").map((r) => r.effort);
    const moves = primary.filter((e, i) => i > 0 && e !== primary[i - 1]).length;
    expect(primary).toEqual(["medium", "medium", "high", "high"]);
    expect(moves).toBe(1);
  });

  test("the tracker keeps it on a row it is handed, and a replayed row without one stays without", () => {
    const tracker = new CostTracker({});
    const usage = { inputTokens: 10, outputTokens: 1 };
    const told = tracker.record("claude-sonnet-5", "anthropic", usage, {
      role: "primary",
      effort: "high",
    });
    const untold = tracker.record("claude-sonnet-5", "anthropic", usage, { role: "primary" });
    expect(told.effort).toBe("high");
    expect("effort" in untold).toBe(false);
  });
});
