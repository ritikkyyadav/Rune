import { describe, test, expect, afterEach } from "bun:test";
import { selectBackends } from "../../../packages/tool-registry/src/tools/search/index";
import type { SearchBackend } from "../../../packages/tool-registry/src/tools/search/index";
import { createWebSearchHandler } from "../../../packages/tool-registry/src/tools/web-search";

const ENV_KEYS = ["TAVILY_API_KEY", "BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY", "GEAR_SEARCH_BACKEND"];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const input = (args: Record<string, unknown>) => ({
  toolName: "web_search",
  callId: "c1",
  sessionId: "s1",
  workspaceRoot: "/tmp",
  args,
});

function fakeBackend(name: string, search: SearchBackend["search"]): SearchBackend {
  return { name, isAvailable: () => true, search };
}

describe("selectBackends", () => {
  test("no keys → only duckduckgo (always-available fallback)", () => {
    clearEnv();
    expect(selectBackends().map((b) => b.name)).toEqual(["duckduckgo"]);
  });

  test("tavily key → tavily then duckduckgo", () => {
    clearEnv();
    process.env.TAVILY_API_KEY = "tvly-x";
    expect(selectBackends().map((b) => b.name)).toEqual(["tavily", "duckduckgo"]);
  });

  test("both keys → tavily, brave, duckduckgo", () => {
    clearEnv();
    process.env.TAVILY_API_KEY = "tvly-x";
    process.env.BRAVE_API_KEY = "brave-x";
    expect(selectBackends().map((b) => b.name)).toEqual(["tavily", "brave", "duckduckgo"]);
  });

  test("preferred backend moves to front", () => {
    clearEnv();
    process.env.TAVILY_API_KEY = "tvly-x";
    process.env.BRAVE_API_KEY = "brave-x";
    expect(selectBackends("brave").map((b) => b.name)).toEqual(["brave", "tavily", "duckduckgo"]);
  });

  test("GEAR_SEARCH_BACKEND env is respected", () => {
    clearEnv();
    process.env.TAVILY_API_KEY = "tvly-x";
    process.env.BRAVE_API_KEY = "brave-x";
    process.env.GEAR_SEARCH_BACKEND = "brave";
    expect(selectBackends().map((b) => b.name)[0]).toBe("brave");
  });
});

describe("createWebSearchHandler", () => {
  test("schema is a confirm-level network tool", () => {
    const handler = createWebSearchHandler(() => []);
    expect(handler.schema.name).toBe("web_search");
    expect(handler.schema.permissionLevel).toBe("confirm");
    expect(handler.schema.category).toBe("network");
  });

  test("validate rejects empty query", () => {
    const handler = createWebSearchHandler(() => []);
    expect(handler.validate({ query: "" }).valid).toBe(false);
    expect(handler.validate({ query: "hi" }).valid).toBe(true);
  });

  test("returns results from the first available backend", async () => {
    const handler = createWebSearchHandler(() => [
      fakeBackend("tavily", async () => ({
        results: [{ title: "T", url: "https://t", snippet: "s" }],
        answer: "direct answer",
      })),
    ]);
    const out = await handler.execute(input({ query: "hi" }));
    expect(out.success).toBe(true);
    const parsed = JSON.parse(out.result);
    expect(parsed.backend).toBe("tavily");
    expect(parsed.results[0].url).toBe("https://t");
    expect(parsed.answer).toBe("direct answer");
  });

  test("falls through to the next backend when one throws", async () => {
    const handler = createWebSearchHandler(() => [
      fakeBackend("tavily", async () => {
        throw new Error("boom");
      }),
      fakeBackend("brave", async () => ({
        results: [{ title: "B", url: "https://b", snippet: "" }],
      })),
    ]);
    const out = await handler.execute(input({ query: "hi" }));
    expect(out.success).toBe(true);
    expect(JSON.parse(out.result).backend).toBe("brave");
  });

  test("falls through when a backend returns nothing", async () => {
    const handler = createWebSearchHandler(() => [
      fakeBackend("tavily", async () => ({ results: [] })),
      fakeBackend("brave", async () => ({
        results: [{ title: "B", url: "https://b", snippet: "" }],
      })),
    ]);
    const out = await handler.execute(input({ query: "hi" }));
    expect(JSON.parse(out.result).backend).toBe("brave");
  });

  test("all backends failing → success:false with details", async () => {
    const handler = createWebSearchHandler(() => [
      fakeBackend("tavily", async () => {
        throw new Error("boom");
      }),
    ]);
    const out = await handler.execute(input({ query: "hi" }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("tavily");
  });
});
