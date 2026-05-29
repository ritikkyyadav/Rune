import { describe, test, expect, afterEach } from "bun:test";
import { createN8nTriggerHandler } from "../../../packages/tool-registry/src/tools/n8n";

const FAKE_INPUT = {
  toolName: "n8n_trigger",
  callId: "test-call-1",
  sessionId: "session-1",
  workspaceRoot: "/tmp",
};

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.N8N_BASE_URL;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Install a fetch mock that records calls and returns the given response. */
function mockFetch(
  response: { status: number; ok?: boolean; body?: string },
  calls: FetchCall[],
): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const status = response.status;
    return {
      status,
      ok: response.ok ?? (status >= 200 && status < 300),
      statusText: "Status",
      text: async () => response.body ?? "",
    } as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) {
    delete process.env.N8N_BASE_URL;
  } else {
    process.env.N8N_BASE_URL = originalBaseUrl;
  }
});

describe("createN8nTriggerHandler", () => {
  const handler = createN8nTriggerHandler();

  // --- schema ---
  test("has correct schema name and metadata", () => {
    expect(handler.schema.name).toBe("n8n_trigger");
    expect(handler.schema.permissionLevel).toBe("confirm");
    expect(handler.schema.category).toBe("network");
    expect(typeof handler.schema.description).toBe("string");
    expect(handler.schema.description.length).toBeGreaterThan(0);
  });

  // --- validate ---
  test("validate rejects when neither webhook_url nor workflow provided", () => {
    const result = handler.validate({});
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/webhook_url or workflow/);
  });

  test("validate accepts webhook_url alone", () => {
    expect(handler.validate({ webhook_url: "https://n8n.example.com/webhook/abc" }).valid).toBe(
      true,
    );
  });

  test("validate accepts workflow alone", () => {
    expect(handler.validate({ workflow: "abc" }).valid).toBe(true);
  });

  test("validate rejects invalid method", () => {
    const result = handler.validate({ webhook_url: "https://x/y", method: "PUT" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/method/);
  });

  test("validate rejects non-object payload", () => {
    const result = handler.validate({ webhook_url: "https://x/y", payload: "nope" });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/payload/);
  });

  test("validate rejects array payload", () => {
    const result = handler.validate({ webhook_url: "https://x/y", payload: [1, 2, 3] });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/payload/);
  });

  // --- execute: webhook_url ---
  test("triggers via webhook_url with JSON body (POST default)", async () => {
    const calls: FetchCall[] = [];
    mockFetch({ status: 200, body: '{"received":true}' }, calls);

    const output = await handler.execute({
      ...FAKE_INPUT,
      args: {
        webhook_url: "https://n8n.example.com/webhook/order-created",
        payload: { orderId: 42 },
      },
    });

    expect(output.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://n8n.example.com/webhook/order-created");
    expect(calls[0].init?.method).toBe("POST");

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0].init?.body).toBe(JSON.stringify({ orderId: 42 }));

    const parsed = JSON.parse(output.result);
    expect(parsed.status).toBe(200);
    expect(parsed.ok).toBe(true);
    expect(parsed.body).toBe('{"received":true}');
  });

  test("POST with no payload sends empty JSON object", async () => {
    const calls: FetchCall[] = [];
    mockFetch({ status: 200, body: "ok" }, calls);

    await handler.execute({
      ...FAKE_INPUT,
      args: { webhook_url: "https://n8n.example.com/webhook/ping" },
    });

    expect(calls[0].init?.body).toBe("{}");
  });

  // --- execute: workflow + N8N_BASE_URL ---
  test("resolves URL via workflow + N8N_BASE_URL env", async () => {
    process.env.N8N_BASE_URL = "https://n8n.internal.test";
    const calls: FetchCall[] = [];
    mockFetch({ status: 200, body: "{}" }, calls);

    const output = await handler.execute({
      ...FAKE_INPUT,
      args: { workflow: "deploy-hook", payload: { ref: "main" } },
    });

    expect(output.success).toBe(true);
    expect(calls[0].url).toBe("https://n8n.internal.test/webhook/deploy-hook");
  });

  test("handles trailing/leading slashes when resolving workflow URL", async () => {
    process.env.N8N_BASE_URL = "https://n8n.internal.test/";
    const calls: FetchCall[] = [];
    mockFetch({ status: 200, body: "{}" }, calls);

    await handler.execute({
      ...FAKE_INPUT,
      args: { workflow: "/deploy-hook" },
    });

    expect(calls[0].url).toBe("https://n8n.internal.test/webhook/deploy-hook");
  });

  test("workflow without N8N_BASE_URL returns clear error (no throw)", async () => {
    delete process.env.N8N_BASE_URL;
    const calls: FetchCall[] = [];
    mockFetch({ status: 200, body: "{}" }, calls);

    const output = await handler.execute({
      ...FAKE_INPUT,
      args: { workflow: "deploy-hook" },
    });

    expect(output.success).toBe(false);
    expect(output.error).toMatch(/N8N_BASE_URL/);
    expect(calls).toHaveLength(0); // never attempted a fetch
  });

  // --- execute: error handling ---
  test("non-2xx response → success:false with clear error", async () => {
    const calls: FetchCall[] = [];
    mockFetch({ status: 500, ok: false, body: "boom" }, calls);

    const output = await handler.execute({
      ...FAKE_INPUT,
      args: { webhook_url: "https://n8n.example.com/webhook/fail" },
    });

    expect(output.success).toBe(false);
    expect(output.error).toMatch(/500/);
    expect(output.error).toMatch(/boom/);
  });

  test("network error → success:false, never throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const output = await handler.execute({
      ...FAKE_INPUT,
      args: { webhook_url: "https://n8n.example.com/webhook/down" },
    });

    expect(output.success).toBe(false);
    expect(output.error).toMatch(/ECONNREFUSED/);
  });

  test("truncates body to ~4KB", async () => {
    const big = "x".repeat(10_000);
    const calls: FetchCall[] = [];
    mockFetch({ status: 200, body: big }, calls);

    const output = await handler.execute({
      ...FAKE_INPUT,
      args: { webhook_url: "https://n8n.example.com/webhook/big" },
    });

    const parsed = JSON.parse(output.result);
    expect(parsed.body.length).toBe(4096);
  });

  // --- execute: GET ---
  test("GET method sends no body", async () => {
    const calls: FetchCall[] = [];
    mockFetch({ status: 200, body: "ok" }, calls);

    await handler.execute({
      ...FAKE_INPUT,
      args: { webhook_url: "https://n8n.example.com/webhook/get", method: "GET" },
    });

    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.body).toBeUndefined();
  });
});
