// ─── P4.1: what two connectors cost per request, before and after ───
//
// The claim under test is a number, not a behaviour: a session with two 20-tool
// MCP servers must pay at least 40% fewer schema tokens per request than the
// same session paid when every schema shipped in full. The mock servers are
// real McpClients over a scripted stdio-shaped transport, so the tool schemas
// measured here are the ones the discovery layer would actually register —
// name prefixing, descriptions, input schemas and all.

import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import { McpClient } from "../../../packages/tool-registry/src/mcp/client";
import {
  createLoadToolsTool,
  deferredByDefault,
  LOAD_TOOLS_TOOL,
} from "../../../packages/tool-registry/src/tools/load-tools";
import { INTERACTIVE_DASHBOARD_SCHEMA } from "../../../packages/tool-registry/src/tools/dashboard";
import { UPDATE_CONFIG_TOOL_SCHEMA } from "../../../packages/orchestrator/src/update-config-tool";
import type { ToolHandler } from "../../../packages/tool-registry/src/types";
import type {
  McpIncomingMessage,
  McpTransport,
  McpToolSchema,
} from "../../../packages/tool-registry/src/mcp/types";

// ─── A scripted in-process MCP server ───

/** A realistic tool schema: the shape a Notion/Linear-class server actually ships. */
function toolSchema(server: string, i: number): McpToolSchema {
  return {
    name: `${server}_operation_${i}`,
    description:
      `Perform operation ${i} against the ${server} workspace. Accepts a target identifier, ` +
      `an optional filter expression, pagination controls and a response shape selector. ` +
      `Returns the matching records with their metadata and a cursor for the next page.`,
    inputSchema: {
      type: "object",
      properties: {
        target_id: { type: "string", description: "Identifier of the object to operate on." },
        filter: { type: "string", description: "Optional filter expression, server dialect." },
        page_size: { type: "number", description: "Records per page (1-100, default 25)." },
        cursor: { type: "string", description: "Opaque pagination cursor from a prior call." },
        include: {
          type: "array",
          items: { type: "string", enum: ["metadata", "children", "properties", "history"] },
          description: "Related data to include in the response.",
        },
        dry_run: { type: "boolean", description: "Validate without applying changes." },
      },
      required: ["target_id"],
    },
    annotations: { readOnlyHint: i % 2 === 0 },
  };
}

/** A transport that answers initialize/tools/list from a fixed tool set. */
class MockTransport implements McpTransport {
  private handler: (msg: McpIncomingMessage) => void = () => {};
  constructor(private tools: McpToolSchema[]) {}
  async start(): Promise<void> {}
  setMessageHandler(h: (msg: McpIncomingMessage) => void): void {
    this.handler = h;
  }
  setProtocolVersion(): void {}
  setLifecycleHandler(): void {}
  async close(): Promise<void> {}
  async send(message: object): Promise<void> {
    const m = message as { id?: number; method?: string };
    if (m.method === "initialize") {
      this.reply(m.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "1.0.0" },
      });
    } else if (m.method === "tools/list") {
      this.reply(m.id, { tools: this.tools });
    } else if (m.id !== undefined) {
      this.reply(m.id, {});
    }
  }
  private reply(id: number | undefined, result: unknown): void {
    if (id === undefined) return;
    queueMicrotask(() => this.handler({ jsonrpc: "2.0", id, result } as McpIncomingMessage));
  }
}

async function mockServer(name: string, toolCount: number): Promise<McpClient> {
  const client = new McpClient({ name, command: "unused" });
  // Swap in the scripted transport before start() so no process is spawned.
  (client as unknown as { transport: McpTransport }).transport = new MockTransport(
    Array.from({ length: toolCount }, (_, i) => toolSchema(name, i)),
  );
  (client as unknown as { transport: McpTransport }).transport.setMessageHandler((msg) =>
    (client as unknown as { handleMessage(m: McpIncomingMessage): void }).handleMessage(msg),
  );
  await client.start();
  return client;
}

/** A stand-in for the real built-in; its presence is what enables deferral. */
function loadToolsStub(): ToolHandler {
  return {
    schema: {
      name: LOAD_TOOLS_TOOL,
      version: "1.0.0",
      description: "",
      inputSchema: { type: "object", properties: {} },
      permissionLevel: "auto",
      category: "read",
    },
    validate: () => ({ valid: true }),
    execute: async () => {
      throw new Error("not called");
    },
  };
}

/** Schema tokens for one request, at the repo's standing ~4 chars/token. */
function schemaTokens(registry: ToolRegistry): number {
  return Math.ceil(JSON.stringify(registry.toLlmTools()).length / 4);
}

// ─── The measurement ───

describe("deferred tool loading — schema tokens per request", () => {
  test("occasional built-ins retain their exact schemas on demand without delaying coding tools", async () => {
    const registry = new ToolRegistry();
    for (const schema of [INTERACTIVE_DASHBOARD_SCHEMA, UPDATE_CONFIG_TOOL_SCHEMA])
      registry.register({
        schema,
        validate: () => ({ valid: true }),
        execute: async () => {
          throw new Error("Schema loading must not execute the tool");
        },
      });
    const loader = createLoadToolsTool(registry);
    registry.register(loader);
    registry.setDeferralEnabled(false);
    const eager = schemaTokens(registry);
    registry.setDeferralEnabled(true);
    expect(schemaTokens(registry)).toBeLessThan(eager * 0.2);
    const catalog = registry.toLlmTools().find((tool) => tool.name === LOAD_TOOLS_TOOL)!;
    for (const name of ["interactive_dashboard", "update_config"])
      expect(catalog.description).toContain(name);
    for (const name of [
      "read_file",
      "edit_file",
      "bash",
      "task",
      "worker",
      "todo_write",
      "ask_user",
    ])
      expect(deferredByDefault(name)).toBe(false);

    const loaded = await loader.execute({
      toolName: LOAD_TOOLS_TOOL,
      callId: "load",
      sessionId: "test",
      workspaceRoot: "/tmp",
      args: { names: ["interactive_dashboard", "update_config"] },
    });
    expect(loaded.success).toBe(true);
    for (const schema of [INTERACTIVE_DASHBOARD_SCHEMA, UPDATE_CONFIG_TOOL_SCHEMA]) {
      const advertised = registry.toLlmTools().find((tool) => tool.name === schema.name)!;
      expect(advertised.description).toBe(schema.description);
      expect(advertised.inputSchema).toEqual(schema.inputSchema);
    }
    expect(registry.deferredCatalog()).toEqual([]);
  });

  test("two 20-tool MCP servers cost >=40% fewer schema tokens per request", async () => {
    const notion = await mockServer("notion", 20);
    const linear = await mockServer("linear", 20);
    expect(notion.getTools()).toHaveLength(20);
    expect(linear.getTools()).toHaveLength(20);

    const registry = new ToolRegistry();
    for (const h of [...notion.toToolHandlers(), ...linear.toToolHandlers()]) {
      registry.register(h);
    }
    // Deferral only applies when something can turn a catalog line back into
    // a schema — otherwise a deferred tool would be unreachable.
    registry.register(loadToolsStub());

    // BEFORE: the pre-P4.1 behaviour — every schema shipped in full.
    registry.setDeferralEnabled(false);
    const before = schemaTokens(registry);

    // AFTER: MCP tools deferred to one catalog line each.
    registry.setDeferralEnabled(true);
    const after = schemaTokens(registry);

    const reduction = ((before - after) / before) * 100;
    // Printed so the gate output carries the actual numbers, not just a pass.
    console.log(
      `schema tokens: before=${before} after=${after} reduction=${reduction.toFixed(1)}%`,
    );

    expect(before).toBeGreaterThan(0);
    expect(reduction).toBeGreaterThanOrEqual(40);

    await notion.stop();
    await linear.stop();
  });

  test("the deferred catalog names every MCP tool exactly once", async () => {
    const notion = await mockServer("notion", 20);
    const registry = new ToolRegistry();
    for (const h of notion.toToolHandlers()) registry.register(h);

    registry.register(loadToolsStub());
    const catalog = registry.deferredCatalog();
    expect(catalog).toHaveLength(20);
    expect(new Set(catalog.map((c) => c.name)).size).toBe(20);
    // A catalog line is a label, not the schema it replaces.
    for (const entry of catalog) {
      expect(entry.name.startsWith("mcp_notion_")).toBe(true);
      expect(entry.summary.length).toBeLessThanOrEqual(110);
    }
    await notion.stop();
  });

  test("load_tools promotes a deferred tool to a full schema for the rest of the run", async () => {
    const notion = await mockServer("notion", 20);
    const registry = new ToolRegistry();
    for (const h of notion.toToolHandlers()) registry.register(h);

    registry.register(loadToolsStub());
    const target = registry.deferredCatalog()[0].name;
    expect(registry.toLlmTools().some((t) => t.name === target)).toBe(false);

    const { loaded, unknown } = registry.activateTools([target]);
    expect(unknown).toEqual([]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].inputSchema).toBeDefined();

    const advertised = registry.toLlmTools();
    expect(advertised.some((t) => t.name === target)).toBe(true);
    expect(registry.isDeferred(target)).toBe(false);
    // Re-registration (an MCP restart) must not un-load it.
    for (const h of notion.toToolHandlers()) registry.register(h);
    expect(registry.isDeferred(target)).toBe(false);

    await notion.stop();
  });

  test("a session with no deferred tools does not advertise load_tools at all", () => {
    const registry = new ToolRegistry();
    registry.register({
      schema: {
        name: "read_file",
        version: "1.0.0",
        description: "Read a file.",
        inputSchema: { type: "object", properties: {} },
        permissionLevel: "auto",
        category: "read",
      },
      validate: () => ({ valid: true }),
      execute: async () => {
        throw new Error("not called");
      },
    });
    const names = registry.toLlmTools().map((t) => t.name);
    expect(names).toEqual(["read_file"]);
    expect(registry.schemaTokenReport().deferred).toBe(0);
  });

  test("schemaTokenReport measures the deferred surface against the eager one", async () => {
    const notion = await mockServer("notion", 20);
    const linear = await mockServer("linear", 20);
    const registry = new ToolRegistry();
    for (const h of [...notion.toToolHandlers(), ...linear.toToolHandlers()]) {
      registry.register(h);
    }
    registry.register(loadToolsStub());
    const report = registry.schemaTokenReport();
    expect(report.deferred).toBe(40);
    expect(report.eagerTokens).toBeGreaterThan(report.tokens);
    expect(report.savedPct).toBeGreaterThanOrEqual(40);
    // Measuring must not change what is advertised.
    expect(registry.deferredCatalog()).toHaveLength(40);
    await notion.stop();
    await linear.stop();
  });
});
