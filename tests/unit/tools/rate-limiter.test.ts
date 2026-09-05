import { describe, test, expect } from "bun:test";
import { ToolRateLimiter } from "../../../packages/tool-registry/src/rate-limiter";

describe("ToolRateLimiter", () => {
  test("allows calls within limits", () => {
    const limiter = new ToolRateLimiter({
      globalMaxPerMinute: 60,
      perToolMaxPerMinute: 20,
      bashMaxPerMinute: 10,
      writeMaxPerMinute: 15,
    });
    const result = limiter.checkLimit("read_file");
    expect(result.allowed).toBe(true);
  });

  test("blocks when global limit exceeded", () => {
    const limiter = new ToolRateLimiter({
      globalMaxPerMinute: 3,
      perToolMaxPerMinute: 100,
      bashMaxPerMinute: 100,
      writeMaxPerMinute: 100,
    });
    limiter.recordCall("tool_a");
    limiter.recordCall("tool_b");
    limiter.recordCall("tool_c");
    const result = limiter.checkLimit("tool_d");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test("blocks when per-tool limit exceeded", () => {
    const limiter = new ToolRateLimiter({
      globalMaxPerMinute: 100,
      perToolMaxPerMinute: 2,
      bashMaxPerMinute: 10,
      writeMaxPerMinute: 15,
    });
    limiter.recordCall("read_file");
    limiter.recordCall("read_file");
    const result = limiter.checkLimit("read_file");
    expect(result.allowed).toBe(false);
  });

  test("uses stricter limit for bash", () => {
    const limiter = new ToolRateLimiter({
      globalMaxPerMinute: 100,
      perToolMaxPerMinute: 100,
      bashMaxPerMinute: 2,
      writeMaxPerMinute: 100,
    });
    limiter.recordCall("bash");
    limiter.recordCall("bash");
    const result = limiter.checkLimit("bash");
    expect(result.allowed).toBe(false);
  });

  test("uses stricter limit for write_file", () => {
    const limiter = new ToolRateLimiter({
      globalMaxPerMinute: 100,
      perToolMaxPerMinute: 100,
      bashMaxPerMinute: 100,
      writeMaxPerMinute: 2,
    });
    limiter.recordCall("write_file");
    limiter.recordCall("write_file");
    const result = limiter.checkLimit("write_file");
    expect(result.allowed).toBe(false);
  });

  test("different tools have independent per-tool limits", () => {
    const limiter = new ToolRateLimiter({
      globalMaxPerMinute: 100,
      perToolMaxPerMinute: 2,
      bashMaxPerMinute: 10,
      writeMaxPerMinute: 15,
    });
    limiter.recordCall("read_file");
    limiter.recordCall("read_file");
    // read_file is at limit, but list_dir should still be allowed
    expect(limiter.checkLimit("read_file").allowed).toBe(false);
    expect(limiter.checkLimit("list_dir").allowed).toBe(true);
  });

  test("uses default config when none provided", () => {
    const limiter = new ToolRateLimiter();
    // Should allow calls with defaults (60 global, 20 per-tool)
    const result = limiter.checkLimit("read_file");
    expect(result.allowed).toBe(true);
  });
});

// ─── The pacer (2026-09-05) ───
// The limiter refused reads at 20/min and told the model to retry after
// 88ms; each refusal cost a completion. Reads are exempt now, short waits
// are absorbed, and only a long wait is refused.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RATE_LIMIT,
  PACER_EXEMPT_CATEGORIES,
  rateLimitFromConfig,
  resolveRateLimit,
} from "../../../packages/tool-registry/src/rate-limiter";

describe("the tool pacer", () => {
  test("defaults are sized for an agent, not a chatbot", () => {
    expect(DEFAULT_RATE_LIMIT).toEqual({
      globalMaxPerMinute: 600,
      perToolMaxPerMinute: 120,
      bashMaxPerMinute: 60,
      writeMaxPerMinute: 60,
      maxWaitMs: 5_000,
    });
    expect(PACER_EXEMPT_CATEGORIES.has("read")).toBe(true);
    expect(PACER_EXEMPT_CATEGORIES.has("write")).toBe(false);
  });

  test("read-category tools are exempt from every limit and never counted", () => {
    const l = new ToolRateLimiter({ globalMaxPerMinute: 2, perToolMaxPerMinute: 1 });
    for (let i = 0; i < 10; i++) {
      expect(l.checkLimit("read_file", "read").allowed).toBe(true);
      l.recordCall("read_file");
    }
    expect(l.getStats()._global).toBe(0);
    // The exemption is remembered by name for the engine's later recordCall.
    expect(l.checkLimit("read_file").allowed).toBe(true);
    // Unrelated tools still see their own limits.
    l.recordCall("web_fetch");
    expect(l.checkLimit("web_fetch", "network").allowed).toBe(false);
  });

  test("a short remainder of the window is a wait; a long one is a refusal", () => {
    let t = 0;
    const l = new ToolRateLimiter({ bashMaxPerMinute: 1, maxWaitMs: 5_000 }, { now: () => t });
    expect(resolveRateLimit(l, "bash")).toEqual({ kind: "allow" });
    l.recordCall("bash");
    t = 10_000; // 50 s of window left — far beyond the wait the pacer absorbs
    expect(resolveRateLimit(l, "bash")).toEqual({ kind: "refuse", waitMs: 50_000 });
    t = 59_000; // 1 s left — absorbed, the model never learns of it
    expect(resolveRateLimit(l, "bash")).toEqual({ kind: "wait", waitMs: 1_000 });
    t = 60_001;
    expect(resolveRateLimit(l, "bash")).toEqual({ kind: "allow" });
  });

  test("write tools share the write limit by category or by name", () => {
    const l = new ToolRateLimiter({ writeMaxPerMinute: 1, perToolMaxPerMinute: 100 });
    l.recordCall("apply_patch");
    expect(l.checkLimit("apply_patch").allowed).toBe(false);
    l.recordCall("some_new_writer");
    expect(l.checkLimit("some_new_writer", "write").allowed).toBe(false);
    expect(l.checkLimit("some_new_writer").allowed).toBe(true); // per-tool limit when uncategorised
  });

  test("[tools] rateLimit maps its names and drops anything that is not a positive number", () => {
    expect(rateLimitFromConfig(undefined)).toEqual({});
    expect(
      rateLimitFromConfig({
        enabled: true,
        globalPerMinute: 1000,
        perToolPerMinute: 0,
        bashPerMinute: -3,
        writePerMinute: 30,
        maxWaitMs: Number.NaN,
      }),
    ).toEqual({ globalMaxPerMinute: 1000, writeMaxPerMinute: 30 });
    const l = new ToolRateLimiter(rateLimitFromConfig({ maxWaitMs: 250 }));
    expect(l.maxWaitMs).toBe(250);
  });

  test("the engine absorbs a wait and only refuses a long one", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../../packages/orchestrator/src/engine.ts"),
      "utf8",
    );
    expect(src).toContain("resolveRateLimit(");
    expect(src).toContain('"tool.rate_paced"');
    expect(src).toContain("await abortableSleep(pace.waitMs");
    expect(src).toContain('pace.kind === "refuse"');
  });
});
