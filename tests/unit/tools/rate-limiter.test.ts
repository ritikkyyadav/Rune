import { describe, test, expect } from "bun:test";
import { ToolRateLimiter } from "../../../packages/tool-registry/src/rate-limiter";

describe("ToolRateLimiter", () => {
  test("allows calls within limits", () => {
    const limiter = new ToolRateLimiter({ globalMaxPerMinute: 60, perToolMaxPerMinute: 20, bashMaxPerMinute: 10, writeMaxPerMinute: 15 });
    const result = limiter.checkLimit("read_file");
    expect(result.allowed).toBe(true);
  });

  test("blocks when global limit exceeded", () => {
    const limiter = new ToolRateLimiter({ globalMaxPerMinute: 3, perToolMaxPerMinute: 100, bashMaxPerMinute: 100, writeMaxPerMinute: 100 });
    limiter.recordCall("tool_a");
    limiter.recordCall("tool_b");
    limiter.recordCall("tool_c");
    const result = limiter.checkLimit("tool_d");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test("blocks when per-tool limit exceeded", () => {
    const limiter = new ToolRateLimiter({ globalMaxPerMinute: 100, perToolMaxPerMinute: 2, bashMaxPerMinute: 10, writeMaxPerMinute: 15 });
    limiter.recordCall("read_file");
    limiter.recordCall("read_file");
    const result = limiter.checkLimit("read_file");
    expect(result.allowed).toBe(false);
  });

  test("uses stricter limit for bash", () => {
    const limiter = new ToolRateLimiter({ globalMaxPerMinute: 100, perToolMaxPerMinute: 100, bashMaxPerMinute: 2, writeMaxPerMinute: 100 });
    limiter.recordCall("bash");
    limiter.recordCall("bash");
    const result = limiter.checkLimit("bash");
    expect(result.allowed).toBe(false);
  });

  test("uses stricter limit for write_file", () => {
    const limiter = new ToolRateLimiter({ globalMaxPerMinute: 100, perToolMaxPerMinute: 100, bashMaxPerMinute: 100, writeMaxPerMinute: 2 });
    limiter.recordCall("write_file");
    limiter.recordCall("write_file");
    const result = limiter.checkLimit("write_file");
    expect(result.allowed).toBe(false);
  });

  test("different tools have independent per-tool limits", () => {
    const limiter = new ToolRateLimiter({ globalMaxPerMinute: 100, perToolMaxPerMinute: 2, bashMaxPerMinute: 10, writeMaxPerMinute: 15 });
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
