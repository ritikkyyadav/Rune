import { describe, test, expect, afterEach } from "bun:test";
import {
  selectBackends,
  orderBackends,
  probeSearchBackend,
  ExaBackend,
  SerperBackend,
  SerpApiBackend,
  JinaBackend,
  FirecrawlBackend,
  YouBackend,
  KagiBackend,
  PerplexityBackend,
  SearxngBackend,
} from "../../../packages/tool-registry/src/tools/search/index";
import type { SearchBackend } from "../../../packages/tool-registry/src/tools/search/index";
import { createWebSearchHandler } from "../../../packages/tool-registry/src/tools/web-search";
import {
  keyedSearchPresets,
  searchPresetsByRank,
} from "../../../packages/shared/src/search-providers";

const none = {} as NodeJS.ProcessEnv;
const names = (list: SearchBackend[]) => list.map((b) => b.name);

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

// Every selection test injects its environment: the host's real keys must never
// decide a unit test, and the roster is twelve engines now.
describe("selectBackends", () => {
  test("no keys → only duckduckgo (always-available fallback)", () => {
    expect(names(selectBackends(undefined, none))).toEqual(["duckduckgo"]);
  });

  test("tavily key → tavily then duckduckgo", () => {
    const env = { TAVILY_API_KEY: "tvly-x" } as NodeJS.ProcessEnv;
    expect(names(selectBackends(undefined, env))).toEqual(["tavily", "duckduckgo"]);
  });

  test("both keys → tavily, brave, duckduckgo", () => {
    const env = { TAVILY_API_KEY: "tvly-x", BRAVE_API_KEY: "brave-x" } as NodeJS.ProcessEnv;
    expect(names(selectBackends(undefined, env))).toEqual(["tavily", "brave", "duckduckgo"]);
  });

  test("preferred backend moves to front", () => {
    const env = { TAVILY_API_KEY: "tvly-x", BRAVE_API_KEY: "brave-x" } as NodeJS.ProcessEnv;
    expect(names(selectBackends("brave", env))).toEqual(["brave", "tavily", "duckduckgo"]);
  });

  test("RUNE_SEARCH_BACKEND env is respected", () => {
    const env = {
      TAVILY_API_KEY: "tvly-x",
      BRAVE_API_KEY: "brave-x",
      RUNE_SEARCH_BACKEND: "brave",
    } as NodeJS.ProcessEnv;
    expect(names(selectBackends(undefined, env))[0]).toBe("brave");
  });

  test("a preference for an engine that is not connected changes nothing", () => {
    const env = { TAVILY_API_KEY: "tvly-x" } as NodeJS.ProcessEnv;
    expect(names(selectBackends("exa", env))).toEqual(["tavily", "duckduckgo"]);
    expect(names(selectBackends("nope", env))).toEqual(["tavily", "duckduckgo"]);
  });

  test("every keyed engine on the roster answers to its env var", () => {
    for (const preset of keyedSearchPresets()) {
      const env = { [preset.envVar!]: "k" } as NodeJS.ProcessEnv;
      expect({ id: preset.id, listed: names(selectBackends(undefined, env)) }).toEqual({
        id: preset.id,
        listed: [preset.id, "duckduckgo"],
      });
    }
  });

  test("alias env vars count too", () => {
    expect(
      names(selectBackends(undefined, { BRAVE_SEARCH_API_KEY: "b" } as NodeJS.ProcessEnv)),
    ).toEqual(["brave", "duckduckgo"]);
    expect(names(selectBackends(undefined, { SERPAPI_KEY: "s" } as NodeJS.ProcessEnv))).toEqual([
      "serpapi",
      "duckduckgo",
    ]);
    expect(names(selectBackends(undefined, { YOU_API_KEY: "y" } as NodeJS.ProcessEnv))).toEqual([
      "you",
      "duckduckgo",
    ]);
  });

  test("a self-hosted SearXNG is connected by URL, not by key", () => {
    const env = { SEARXNG_URL: "http://localhost:8080" } as NodeJS.ProcessEnv;
    expect(names(selectBackends(undefined, env))).toEqual(["searxng", "duckduckgo"]);
  });

  test("with everything connected, the answer order is the roster's rank", () => {
    const env = Object.fromEntries(
      keyedSearchPresets().map((p) => [p.envVar!, "k"]),
    ) as NodeJS.ProcessEnv;
    env.SEARXNG_URL = "http://localhost:8080";
    expect(names(selectBackends(undefined, env))).toEqual(searchPresetsByRank().map((p) => p.id));
  });

  test("orderBackends keeps the rest in rank order behind the preferred one", () => {
    const list = ["a", "b", "c", "d"].map((n) => fakeBackend(n, async () => ({ results: [] })));
    expect(names(orderBackends(list, "c"))).toEqual(["c", "a", "b", "d"]);
    expect(names(orderBackends(list, "a"))).toEqual(["a", "b", "c", "d"]);
    expect(names(orderBackends(list, "auto"))).toEqual(["a", "b", "c", "d"]);
  });
});

// ─── The wire, per engine ───
// Each new backend is one documented request. These pin the request shape
// (auth header, method, freshness parameter) and the response mapping, with
// fetch stubbed — no key on this machine ever completed a live call.

type Captured = { url: string; init?: RequestInit };
const realFetch = globalThis.fetch;
function stubFetch(body: unknown, status = 200): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls };
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("engine wire formats", () => {
  test("exa: POST with x-api-key, text excerpts as snippets, start date for recency", async () => {
    const { calls } = stubFetch({
      results: [{ title: "T", url: "https://t", text: "body words", publishedDate: "2026-09-01" }],
    });
    const out = await new ExaBackend("k").search("q", { maxResults: 3, recencyDays: 7 });
    expect(calls[0]!.url).toBe("https://api.exa.ai/search");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-api-key"]).toBe("k");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.numResults).toBe(3);
    expect(typeof body.startPublishedDate).toBe("string");
    expect(out.results[0]).toMatchObject({ title: "T", url: "https://t", snippet: "body words" });
  });

  test("serper: X-API-KEY, Google tbs buckets, answer box surfaced", async () => {
    const { calls } = stubFetch({
      answerBox: { answer: "42" },
      organic: [{ title: "T", link: "https://t", snippet: "s" }],
    });
    const out = await new SerperBackend("k").search("q", { maxResults: 5, recencyDays: 1 });
    expect((calls[0]!.init!.headers as Record<string, string>)["X-API-KEY"]).toBe("k");
    expect(JSON.parse(String(calls[0]!.init!.body)).tbs).toBe("qdr:d");
    expect(out.answer).toBe("42");
    expect(out.results[0]!.url).toBe("https://t");
  });

  test("serpapi: key in the query string, organic_results mapped", async () => {
    const { calls } = stubFetch({
      organic_results: [{ title: "T", link: "https://t", snippet: "s" }],
    });
    const out = await new SerpApiBackend("k").search("q", { maxResults: 2 });
    expect(calls[0]!.url).toContain("api_key=k");
    expect(calls[0]!.url).toContain("engine=google");
    expect(out.results).toHaveLength(1);
  });

  test("jina: bearer, JSON, no page content", async () => {
    const { calls } = stubFetch({ data: [{ title: "T", url: "https://t", description: "d" }] });
    const out = await new JinaBackend("k").search("hello world", { maxResults: 5 });
    const h = calls[0]!.init!.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer k");
    expect(h["X-Respond-With"]).toBe("no-content");
    expect(calls[0]!.url).toContain("q=hello%20world");
    expect(out.results[0]!.snippet).toBe("d");
  });

  test("firecrawl: bearer POST, description first then markdown", async () => {
    stubFetch({ success: true, data: [{ title: "T", url: "https://t", markdown: "# md body" }] });
    const out = await new FirecrawlBackend("k").search("q", { maxResults: 5 });
    expect(out.results[0]!.snippet).toBe("# md body");
  });

  test("you.com: reads both generations of the response shape", async () => {
    stubFetch({ results: { web: [{ title: "New", url: "https://n", description: "d" }] } });
    expect((await new YouBackend("k").search("q", { maxResults: 5 })).results[0]!.title).toBe(
      "New",
    );
    stubFetch({ hits: [{ title: "Old", url: "https://o", snippets: ["a", "b"] }] });
    const old = (await new YouBackend("k").search("q", { maxResults: 5 })).results[0]!;
    expect(old.title).toBe("Old");
    expect(old.snippet).toBe("a b");
  });

  test("kagi: Bot token, related-query rows (t=1) dropped", async () => {
    const { calls } = stubFetch({
      data: [
        { t: 0, title: "T", url: "https://t", snippet: "s" },
        { t: 1, list: ["related"] },
      ],
    });
    const out = await new KagiBackend("k").search("q", { maxResults: 5 });
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bot k");
    expect(out.results).toHaveLength(1);
  });

  test("perplexity: bearer POST with a named recency window", async () => {
    const { calls } = stubFetch({
      results: [{ title: "T", url: "https://t", snippet: "s", date: "2026" }],
    });
    const out = await new PerplexityBackend("k").search("q", { maxResults: 5, recencyDays: 30 });
    expect(calls[0]!.url).toBe("https://api.perplexity.ai/search");
    expect(JSON.parse(String(calls[0]!.init!.body)).search_recency_filter).toBe("month");
    expect(out.results[0]!.publishedDate).toBe("2026");
  });

  test("searxng: json format and time_range on the instance's own URL", async () => {
    const { calls } = stubFetch({ results: [{ title: "T", url: "https://t", content: "c" }] });
    const out = await new SearxngBackend("http://search.lan:8080/").search("q", {
      maxResults: 5,
      recencyDays: 365,
    });
    expect(calls[0]!.url.startsWith("http://search.lan:8080/search?")).toBe(true);
    expect(calls[0]!.url).toContain("format=json");
    expect(calls[0]!.url).toContain("time_range=year");
    expect(out.results[0]!.snippet).toBe("c");
  });

  test("a non-2xx answer carries the host's own words", async () => {
    stubFetch("invalid api key", 401);
    await expect(new ExaBackend("bad").search("q", { maxResults: 1 })).rejects.toThrow(
      /Exa HTTP 401: invalid api key/,
    );
  });
});

describe("probeSearchBackend", () => {
  test("a working key: ok, with the host's answer count and latency", async () => {
    stubFetch({ results: [{ title: "T", url: "https://t", text: "x" }] });
    const probe = await probeSearchBackend("exa", { EXA_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(probe.ok).toBe(true);
    expect(probe.detail).toBe("1 result");
    expect(probe.ms).toBeGreaterThanOrEqual(0);
  });

  test("a rejected key: not ok, in the host's words", async () => {
    stubFetch("invalid api key", 401);
    const probe = await probeSearchBackend("exa", { EXA_API_KEY: "bad" } as NodeJS.ProcessEnv);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("Exa HTTP 401");
  });

  test("nothing configured or an unknown engine: not ok, and no network call", async () => {
    const { calls } = stubFetch({});
    expect((await probeSearchBackend("exa", none)).detail).toBe("no key or URL configured");
    expect((await probeSearchBackend("nope", none)).detail).toBe("unknown search engine");
    expect(calls).toHaveLength(0);
  });

  test("a silent host times out instead of hanging the login", async () => {
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    const probe = await probeSearchBackend("exa", { EXA_API_KEY: "k" } as NodeJS.ProcessEnv, {
      timeoutMs: 20,
    });
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("no answer within 20ms");
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

// ─── Backend cooldown (2026-09-05) ───
// Brave answered 429 on fifteen consecutive searches in one afternoon and
// was tried first every time. A backend that rate-limits is skipped for the
// cooldown window and the next backend answers in the same call.

describe("backend cooldown after a rate limit", () => {
  test("a backend that 429s is skipped for the window, then retried", async () => {
    let t = 0;
    let braveCalls = 0;
    const brave = fakeBackend("brave", async () => {
      braveCalls++;
      throw new Error('Brave HTTP 429: {"type":"ErrorResponse"}');
    });
    const ddg = fakeBackend("duckduckgo", async () => ({
      results: [{ title: "D", url: "https://d", snippet: "s" }],
    }));
    const handler = createWebSearchHandler(() => [brave, ddg], {
      cooldownMs: 1_000,
      now: () => t,
    });

    const first = await handler.execute(input({ query: "a" }));
    expect(first.success).toBe(true);
    expect(JSON.parse(first.result).backend).toBe("duckduckgo");
    expect(braveCalls).toBe(1);

    const second = await handler.execute(input({ query: "b" }));
    expect(second.success).toBe(true);
    expect(braveCalls).toBe(1); // skipped: cooling down

    t = 1_001;
    await handler.execute(input({ query: "c" }));
    expect(braveCalls).toBe(2); // window over: tried again
  });

  test("an ordinary failure does not cool a backend down", async () => {
    let calls = 0;
    const flaky = fakeBackend("tavily", async () => {
      calls++;
      throw new Error("Tavily HTTP 500");
    });
    const ddg = fakeBackend("duckduckgo", async () => ({
      results: [{ title: "D", url: "https://d", snippet: "s" }],
    }));
    const handler = createWebSearchHandler(() => [flaky, ddg]);
    await handler.execute(input({ query: "a" }));
    await handler.execute(input({ query: "b" }));
    expect(calls).toBe(2);
  });

  test("when every backend is cooling down the error says so", async () => {
    const brave = fakeBackend("brave", async () => {
      throw new Error("Brave HTTP 429");
    });
    const handler = createWebSearchHandler(() => [brave], { cooldownMs: 60_000, now: () => 0 });
    await handler.execute(input({ query: "a" }));
    const out = await handler.execute(input({ query: "b" }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("brave: cooling down after a rate limit");
  });
});
