/**
 * The circuit breaker's counter must only be cleared by an actual success.
 *
 * It used to reset on ANY returned output. Since `{success: false}` is the
 * normal failure convention throughout this codebase, a single soft failure
 * zeroed the counter — so a faulting tool could throw, throw, throw, return a
 * soft failure, and start counting from zero again, never reaching the
 * threshold inside the 60s window. The breaker was disarmed by the failures it
 * was there to count.
 */

import { describe, test, expect } from "bun:test";

import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import type { ToolHandler, ToolSchema } from "../../../packages/tool-registry/src/types";

const schema = (name: string): ToolSchema => ({
  name,
  version: "1.0.0",
  description: "test tool",
  inputSchema: { type: "object", properties: {}, required: [] },
  permissionLevel: "auto",
  category: "read",
});

/** A tool whose behavior per call is scripted: "throw" | "soft" | "ok". */
function scripted(name: string, script: Array<"throw" | "soft" | "ok">): ToolHandler {
  let i = 0;
  return {
    schema: schema(name),
    validate: () => ({ valid: true }),
    execute: async (input) => {
      const step = script[Math.min(i++, script.length - 1)]!;
      if (step === "throw") throw new Error("tool is faulting");
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: step === "ok",
        result: step === "ok" ? "fine" : "",
        error: step === "ok" ? undefined : "soft failure",
        durationMs: 0,
      };
    },
  } as ToolHandler;
}

const call = (registry: ToolRegistry, name: string) =>
  registry.execute({
    callId: "c",
    toolName: name,
    args: {},
    sessionId: "s",
    workspaceRoot: "/tmp",
  });

describe("circuit breaker counter hygiene", () => {
  test("five consecutive throws open the circuit", async () => {
    const registry = new ToolRegistry();
    registry.register(scripted("faulty", ["throw"]));

    for (let n = 0; n < 5; n++) await call(registry, "faulty");

    const out = await call(registry, "faulty");
    expect(out.success).toBe(false);
    expect(out.error).toContain("circuit breaker open");
  });

  test("a soft failure between throws no longer resets the count", async () => {
    // throw, throw, SOFT, throw, throw, throw → still five real faults.
    // Under the old reset-on-any-output rule the soft result zeroed the
    // counter and the circuit never opened.
    const registry = new ToolRegistry();
    registry.register(scripted("mixed", ["throw", "throw", "soft", "throw", "throw", "throw"]));

    for (let n = 0; n < 6; n++) await call(registry, "mixed");

    const out = await call(registry, "mixed");
    expect(out.error).toContain("circuit breaker open");
  });

  test("a genuine success DOES reset the count", async () => {
    const registry = new ToolRegistry();
    registry.register(scripted("recovers", ["throw", "throw", "throw", "throw", "ok", "throw"]));

    for (let n = 0; n < 6; n++) await call(registry, "recovers");

    // Four faults, then a success zeroed them, then one more fault: 1 < 5.
    const out = await call(registry, "recovers");
    expect(out.error ?? "").not.toContain("circuit breaker open");
  });

  test("returned soft failures alone never open the circuit", async () => {
    // A stale edit hash or a no-match grep is the CALL being wrong, not the
    // tool being broken. Disabling the tool for it would be the worse bug.
    const registry = new ToolRegistry();
    registry.register(scripted("picky", ["soft"]));

    for (let n = 0; n < 10; n++) await call(registry, "picky");

    const out = await call(registry, "picky");
    expect(out.error).toBe("soft failure");
  });
});
