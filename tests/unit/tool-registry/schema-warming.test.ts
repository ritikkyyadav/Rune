/**
 * "Core, or used or named in the last N turns" — the advertisement rule (P13.1).
 *
 * A catalogued tool must not be a permanent extra round-trip. Two things
 * promote one to a full schema for the rest of the session: the conversation
 * naming it, and the model calling it. Both are sticky, because a prefix that
 * shrinks mid-run is a prefix that never caches.
 */
import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import {
  LOAD_TOOLS_TOOL,
  createLoadToolsTool,
} from "../../../packages/tool-registry/src/tools/load-tools";
import type { ToolHandler, ToolSchema } from "../../../packages/tool-registry/src/types";

function stub(
  name: string,
  description = `${name} does a thing. More prose follows.`,
): ToolHandler {
  const schema: ToolSchema = {
    name,
    version: "1.0.0",
    description,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    permissionLevel: "auto",
    category: "read",
  };
  return {
    schema,
    validate: () => ({ valid: true }),
    execute: async (input) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 0,
    }),
  };
}

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(stub("read_file"));
  reg.register(stub("web_fetch"));
  reg.register(stub("worker"));
  reg.register(stub("symbol_search"));
  reg.register(createLoadToolsTool(reg));
  return reg;
}

const advertised = (reg: ToolRegistry): string[] =>
  reg
    .toLlmTools()
    .map((t) => t.name)
    .filter((n) => n !== LOAD_TOOLS_TOOL);

describe("advertisement warming", () => {
  test("the core set is advertised and the rest is a catalog line", () => {
    const reg = registry();
    expect(advertised(reg)).toEqual(["read_file"]);
    expect(reg.deferredCatalog().map((e) => e.name)).toEqual([
      "symbol_search",
      "web_fetch",
      "worker",
    ]);
  });

  test("naming a tool in the conversation promotes it", () => {
    const reg = registry();
    expect(reg.warmFromText("fetch the changelog with web_fetch please")).toEqual(["web_fetch"]);
    expect(advertised(reg)).toContain("web_fetch");
    // And it is not re-reported on the next turn — promotion happens once.
    expect(reg.warmFromText("web_fetch again")).toEqual([]);
  });

  test("promotion is sticky: later text never demotes a warmed tool", () => {
    const reg = registry();
    reg.warmFromText("use worker for this");
    reg.warmFromText("actually never mind");
    expect(advertised(reg)).toContain("worker");
  });

  test("text naming nothing costs nothing", () => {
    const reg = registry();
    expect(reg.warmFromText("just read the file and fix the bug")).toEqual([]);
    expect(advertised(reg)).toEqual(["read_file"]);
  });

  test("calling a catalogued tool executes it AND promotes it", async () => {
    const reg = registry();
    const out = await reg.execute({
      toolName: "symbol_search",
      callId: "c1",
      sessionId: "s",
      workspaceRoot: "/tmp",
      args: { q: "x" },
    });
    // Saving tokens must never make a registered tool unreachable.
    expect(out.success).toBe(true);
    expect(advertised(reg)).toContain("symbol_search");
  });

  test("warming is inert when deferral is off", () => {
    const reg = registry();
    reg.setDeferralEnabled(false);
    expect(reg.warmFromText("web_fetch")).toEqual([]);
    expect(advertised(reg).sort()).toEqual(["read_file", "symbol_search", "web_fetch", "worker"]);
  });

  test("warming everything empties the catalog and retires the mechanism", () => {
    const reg = registry();
    reg.warmFromText("worker web_fetch symbol_search");
    expect(reg.deferredCatalog()).toEqual([]);
    expect(advertised(reg).sort()).toEqual(["read_file", "symbol_search", "web_fetch", "worker"]);
    // With nothing left deferred, the mechanism itself stops being advertised —
    // a run that loads everything ends up paying exactly what it paid before.
    expect(reg.toLlmTools().some((t) => t.name === LOAD_TOOLS_TOOL)).toBe(false);
  });
});
