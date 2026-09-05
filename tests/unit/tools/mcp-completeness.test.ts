// ─── P4.4: the rest of the protocol ───
//
// Only tools/list, tools/call, ping and initialize were spoken. Resources,
// prompts and elicitation got a -32601; `instructions` and `annotations` were
// typed and discarded; argument validation was required-presence only.
//
// These tests pin each of those, against the mock connector.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../../../packages/shared/src/credential-store";
import { McpClient } from "../../../packages/tool-registry/src/mcp/client";
import { McpOAuth } from "../../../packages/tool-registry/src/mcp/oauth";
import { validateAgainstSchema } from "../../../packages/tool-registry/src/mcp/validate";
import {
  createReadResourceTool,
  collectPromptCommands,
  expandPromptCommand,
  findResourceMentions,
  parseResourceMention,
} from "../../../packages/tool-registry/src/mcp/resources";
import {
  startMockOAuthMcpServer,
  type MockOAuthMcpServer,
} from "../../helpers/mock-oauth-mcp-server";

let home: string;
let store: FileCredentialStore;
let mock: MockOAuthMcpServer;

/** A logged-in client against the mock connector. */
async function connected(): Promise<McpClient> {
  const provider = new McpOAuth({ serverName: "mocknotion", serverUrl: mock.mcpUrl, store });
  await provider.login({
    openAuthorizationUrl: async (url) => {
      await fetch(url, { redirect: "follow" }).catch(() => {});
    },
  });
  const client = new McpClient({
    name: "mocknotion",
    url: mock.mcpUrl,
    auth: new McpOAuth({ serverName: "mocknotion", serverUrl: mock.mcpUrl, store }),
  });
  await client.start();
  return client;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "rune-mcp-complete-"));
  store = new FileCredentialStore({ ...process.env, RUNE_HOME: home });
  mock = await startMockOAuthMcpServer();
});

afterEach(async () => {
  await mock.close();
  rmSync(home, { recursive: true, force: true });
});

// ─── Argument validation against inputSchema ───

describe("argument validation", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2 },
      limit: { type: "number", minimum: 1, maximum: 100 },
      mode: { type: "string", enum: ["fast", "thorough"] },
      when: { type: "string", format: "date" },
      tags: { type: "array", items: { type: "string" }, maxItems: 3 },
    },
    required: ["query"],
    additionalProperties: false,
  };

  test("accepts a well-formed call", () => {
    expect(
      validateAgainstSchema(schema, {
        query: "hello",
        limit: 10,
        mode: "fast",
        when: "2026-09-02",
        tags: ["a"],
      }),
    ).toEqual([]);
  });

  test("catches a wrong type and names what was expected", () => {
    const errors = validateAgainstSchema(schema, { query: "hi", limit: "ten" });
    expect(errors.join(" ")).toContain("limit");
    expect(errors.join(" ")).toContain("expected number");
  });

  test("catches an off-enum value and lists the allowed ones", () => {
    const errors = validateAgainstSchema(schema, { query: "hi", mode: "quick" });
    expect(errors.join(" ")).toContain("fast");
    expect(errors.join(" ")).toContain("thorough");
  });

  test("catches a bad format, a range violation and an over-long array", () => {
    expect(
      validateAgainstSchema(schema, { query: "hi", when: "last tuesday" }).join(" "),
    ).toContain("not a valid date");
    expect(validateAgainstSchema(schema, { query: "hi", limit: 500 }).join(" ")).toContain(
      "above the maximum",
    );
    expect(
      validateAgainstSchema(schema, { query: "hi", tags: ["a", "b", "c", "d"] }).join(" "),
    ).toContain("at most 3");
  });

  test("names a hallucinated parameter and the real ones, on a closed schema", () => {
    const errors = validateAgainstSchema(schema, { query: "hi", pageSize: 5 });
    expect(errors.join(" ")).toContain('unknown parameter "pageSize"');
    expect(errors.join(" ")).toContain("limit");
  });

  test("an open schema accepts extras — the server is the authority", () => {
    const open = { type: "object", properties: { a: { type: "string" } } };
    expect(validateAgainstSchema(open, { a: "x", b: 1 })).toEqual([]);
  });

  test("still catches a missing required parameter", () => {
    expect(validateAgainstSchema(schema, { limit: 3 }).join(" ")).toContain(
      "Missing required param: query",
    );
  });

  test("an unknown keyword is ignored rather than guessed at", () => {
    const exotic = {
      type: "object",
      properties: { a: { type: "string", contentEncoding: "b64" } },
    };
    expect(validateAgainstSchema(exotic, { a: "x" })).toEqual([]);
  });

  test("the client rejects a bad call locally instead of paying a round trip", async () => {
    const client = await connected();
    const before = mock.authorizedCalls;
    const result = await client.callTool("search", {});
    expect(result.isError).toBe(true);
    expect(client.flattenContent(result)).toContain("Missing required param: query");
    // Nothing reached the server.
    expect(mock.authorizedCalls).toBe(before);
    await client.stop();
  });
});

// ─── Annotations shape permission and category ───

describe("tool annotations", () => {
  test("readOnlyHint becomes a read tool that needs no prompt", async () => {
    const client = await connected();
    const search = client.toToolHandlers().find((h) => h.schema.name.endsWith("_search"));
    expect(search?.schema.category).toBe("read");
    expect(search?.schema.permissionLevel).toBe("auto");
    await client.stop();
  });

  test("destructiveHint always needs confirmation, even under autoApprove", async () => {
    const client = await connected();
    // autoApprove says yes to everything; the destructive hint still wins,
    // because a list written before the server added a delete must not cover it.
    const del = client
      .toToolHandlers(() => true)
      .find((h) => h.schema.name.endsWith("_delete_page"));
    expect(del?.schema.permissionLevel).toBe("confirm");
    expect(del?.schema.category).toBe("write");
    await client.stop();
  });
});

// ─── Server instructions ───

describe("server instructions", () => {
  test("are kept from the handshake instead of discarded", async () => {
    const client = await connected();
    expect(client.getInstructions()).toBe("Mock connector. Search before you delete.");
    await client.stop();
  });
});

// ─── Resources ───

describe("resources", () => {
  test("mentions parse and are found in a composer line", () => {
    expect(parseResourceMention("@notion:notion://page/1")).toEqual({
      server: "notion",
      uri: "notion://page/1",
    });
    expect(parseResourceMention("not a mention")).toBeNull();
    const found = findResourceMentions("compare @notion:page/1 with @linear:issue/2 please");
    expect(found).toEqual([
      { server: "notion", uri: "page/1" },
      { server: "linear", uri: "issue/2" },
    ]);
  });

  test("read_resource lists across servers and reads one by @server:uri", async () => {
    const client = await connected();
    expect(client.supportsResources).toBe(true);
    const clients = new Map([["mocknotion", client]]);
    const tool = createReadResourceTool({ clients: () => clients });

    // No uri: the catalogue, so the model never has to guess a URI scheme.
    const listing = await tool.execute({ callId: "1", toolName: "read_resource", args: {} });
    expect(listing.success).toBe(true);
    expect(listing.result).toContain("@mocknotion:mock://page/1");

    const read = await tool.execute({
      callId: "2",
      toolName: "read_resource",
      args: { uri: "@mocknotion:mock://page/1" },
    });
    expect(read.success).toBe(true);
    expect(read.result).toContain("the welcome page body");

    // An unknown server says which ones exist.
    const miss = await tool.execute({
      callId: "3",
      toolName: "read_resource",
      args: { uri: "@nosuch:x" },
    });
    expect(miss.success).toBe(false);
    expect(miss.error).toContain("mocknotion");
    await client.stop();
  });
});

// ─── Prompts as slash commands ───

describe("prompts", () => {
  test("become /server:prompt commands and expand to their messages", async () => {
    const client = await connected();
    expect(client.supportsPrompts).toBe(true);
    const clients = new Map([["mocknotion", client]]);

    const commands = await collectPromptCommands(clients);
    expect(commands.map((c) => c.name)).toEqual(["mocknotion:summarize"]);
    expect(commands[0].arguments?.[0].name).toBe("page_id");

    const expanded = await expandPromptCommand(clients, commands[0], ["page-123"]);
    expect(expanded).toContain("Summarize the page.");
    await client.stop();
  });
});

// ─── Elicitation ───

describe("elicitation", () => {
  test("declines when no question handler is wired, rather than hanging", async () => {
    const client = new McpClient({ name: "x", url: mock.mcpUrl });
    // Reach the private handler the way the transport would.
    const replies: unknown[] = [];
    (client as unknown as { transport: { send(m: object): Promise<void> } }).transport = {
      send: async (m: object) => {
        replies.push(m);
      },
    } as never;
    await (
      client as unknown as {
        handleElicit(id: number, params: Record<string, unknown>): Promise<void>;
      }
    ).handleElicit(7, { message: "Which workspace?" });
    expect(replies).toHaveLength(1);
    expect((replies[0] as { result: { action: string } }).result.action).toBe("decline");
  });

  test("a wired handler's answer becomes an accept carrying the schema's field", async () => {
    const asked: string[] = [];
    const client = new McpClient({
      name: "mocknotion",
      url: mock.mcpUrl,
      onElicit: async (req) => {
        asked.push(req.message);
        return { action: "accept", content: { workspace: "Engineering" } };
      },
    });
    const replies: unknown[] = [];
    (client as unknown as { transport: { send(m: object): Promise<void> } }).transport = {
      send: async (m: object) => {
        replies.push(m);
      },
    } as never;
    await (
      client as unknown as {
        handleElicit(id: number, params: Record<string, unknown>): Promise<void>;
      }
    ).handleElicit(9, {
      message: "Which workspace?",
      requestedSchema: { type: "object", properties: { workspace: { type: "string" } } },
    });
    expect(asked).toEqual(["Which workspace?"]);
    const result = (replies[0] as { result: { action: string; content: Record<string, string> } })
      .result;
    expect(result.action).toBe("accept");
    expect(result.content.workspace).toBe("Engineering");
  });
});

// ─── P4.7: tool discovery must not be skipped ───

describe("declaredOtherCaps regression", () => {
  test("a server declaring resources and prompts still gets its tools discovered", async () => {
    // The mock declares tools, resources AND prompts. The old rule skipped
    // tools/list whenever any capability was declared without a `tools` key,
    // which silently exposed nothing for exactly this shape of server.
    const client = await connected();
    expect(
      client
        .getTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["delete_page", "search"]);
    expect(client.supportsResources).toBe(true);
    expect(client.supportsPrompts).toBe(true);
    await client.stop();
  });
});
