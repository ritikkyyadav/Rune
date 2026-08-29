/**
 * Capability gating for tool schemas.
 *
 * Every tool definition ships on every request. Measured 2026-08-30: 3,228
 * tokens across 18 tools, inside a 12,710-token fixed overhead. A tool for an
 * integration nobody has configured is the clearest case of a schema that
 * earns nothing, so it is not advertised.
 *
 * The gate is deliberately narrow. It fires only on an unambiguous signal, and
 * only for tools whose absence cannot quietly reduce ordinary coding ability —
 * removing a useful tool to save tokens is a worse trade than the tokens.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import { createN8nTriggerHandler } from "../../../packages/tool-registry/src/tools/n8n";
import { createGlobHandler } from "../../../packages/tool-registry/src/tools/glob";

const prev = process.env.N8N_BASE_URL;
afterEach(() => {
  if (prev === undefined) delete process.env.N8N_BASE_URL;
  else process.env.N8N_BASE_URL = prev;
});

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createN8nTriggerHandler());
  r.register(createGlobHandler());
  return r;
}

describe("capability-gated tool schemas", () => {
  test("an unconfigured integration is not advertised", () => {
    delete process.env.N8N_BASE_URL;
    const names = registry()
      .toLlmTools()
      .map((t) => t.name);
    expect(names).not.toContain("n8n_trigger");
    // The gate is surgical — everything else still ships.
    expect(names).toContain("glob");
  });

  test("configuring it brings the tool back", () => {
    process.env.N8N_BASE_URL = "https://n8n.example.com";
    const names = registry()
      .toLlmTools()
      .map((t) => t.name);
    expect(names).toContain("n8n_trigger");
  });

  test("gating advertisement never removes the ability to EXECUTE", async () => {
    // A gated tool is hidden from the model, not unregistered. Anything that
    // already knows the name — a replayed session, a scripted call — must
    // still reach the handler, or the gate becomes a silent breaking change.
    delete process.env.N8N_BASE_URL;
    const r = registry();
    expect(r.get("n8n_trigger")).toBeDefined();
    expect(r.list().map((s) => s.name)).toContain("n8n_trigger");
  });

  test("the gate is measurable — hiding one tool actually shrinks the payload", () => {
    process.env.N8N_BASE_URL = "https://n8n.example.com";
    const withTool = JSON.stringify(registry().toLlmTools()).length;
    delete process.env.N8N_BASE_URL;
    const without = JSON.stringify(registry().toLlmTools()).length;
    expect(without).toBeLessThan(withTool);
  });
});
