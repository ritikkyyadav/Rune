/**
 * Live model catalogues — what a signed-in account can run, asked of the
 * provider rather than read from providers.ts.
 *
 * The failure this pins: GPT-6 Sol and Luna shipped on 2026-09-22 and were
 * still missing from `/model` a week later, because the ChatGPT route's
 * `listModels()` returned [] ("the Codex backend has no listing endpoint") and
 * the OpenAI route listed every product on the key unfiltered. The picker only
 * ever showed the hand-written preset, so a new release waited on a code edit.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  CodexProvider,
  CODEX_CLIENT_VERSION_FLOOR,
  codexClientVersion,
  newerClientVersion,
  parseCodexCatalog,
  resetCodexClientVersion,
} from "../../../packages/llm-gateway/src/providers/codex";
import {
  OpenAIProvider,
  isOpenAIChatModel,
} from "../../../packages/llm-gateway/src/providers/openai";

const realFetch = globalThis.fetch;
const realOverride = process.env.RUNE_CODEX_CLIENT_VERSION;
let calls: { url: string; init: RequestInit }[] = [];

function mockFetch(respond: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input));
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Trimmed from the codex-rs ModelInfo shape; only the fields Rune reads matter. */
function entry(slug: string, over: Record<string, unknown> = {}) {
  return {
    slug,
    display_name: slug.toUpperCase(),
    visibility: "list",
    priority: 10,
    supported_in_api: true,
    supported_reasoning_levels: [{ effort: "low", description: "" }],
    context_window: 1_050_000,
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  resetCodexClientVersion();
  delete process.env.RUNE_CODEX_CLIENT_VERSION;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetCodexClientVersion();
  if (realOverride === undefined) delete process.env.RUNE_CODEX_CLIENT_VERSION;
  else process.env.RUNE_CODEX_CLIENT_VERSION = realOverride;
});

describe("parseCodexCatalog", () => {
  test("keeps only listed models, in the backend's priority order", () => {
    const models = parseCodexCatalog({
      models: [
        entry("gpt-6-luna", { priority: 3, display_name: "GPT-6 Luna" }),
        entry("internal-review-model", { priority: 0, visibility: "hide" }),
        entry("gpt-6-astra", { priority: 1, display_name: "GPT-6 Astra" }),
        entry("gpt-6-sol", { priority: 2, display_name: "GPT-6 Sol" }),
        entry("retired-thing", { priority: 0, visibility: "none" }),
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
    expect(models.map((m) => m.label)).toEqual(["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna"]);
    expect(models.every((m) => m.live === true)).toBe(true);
  });

  test("carries the real context window, so compaction is not guessed", () => {
    const [m] = parseCodexCatalog({ models: [entry("gpt-6-sol", { context_window: 1_050_000 })] });
    expect(m?.contextLimit).toBe(1_050_000);
    const [n] = parseCodexCatalog({ models: [entry("gpt-6-sol", { context_window: null })] });
    expect(n?.contextLimit).toBeUndefined();
  });

  test("a malformed entry drops that entry, never the list", () => {
    const models = parseCodexCatalog({
      models: [
        null,
        "gpt-6-astra",
        { visibility: "list" },
        entry(""),
        entry("gpt-6-sol", { display_name: 42, priority: "first" }),
        entry("gpt-6-luna", { priority: 5 }),
      ],
    });
    // Missing priority sorts last; a non-string display name falls to the id.
    expect(models.map((m) => [m.id, m.label])).toEqual([
      ["gpt-6-luna", "GPT-6-LUNA"],
      ["gpt-6-sol", "gpt-6-sol"],
    ]);
  });

  test("an unrecognizable body is an empty catalogue, not a throw", () => {
    expect(parseCodexCatalog(null)).toEqual([]);
    expect(parseCodexCatalog({})).toEqual([]);
    expect(parseCodexCatalog({ models: "nope" })).toEqual([]);
  });
});

describe("the catalogue's client_version", () => {
  test("newerClientVersion compares numerically and normalises to x.y.z", () => {
    expect(newerClientVersion("0.160.0", "0.157.1")).toBe("0.160.0");
    expect(newerClientVersion("0.157.1", "0.160.0")).toBe("0.160.0");
    // 0.99 < 0.157: a string compare would get this backwards.
    expect(newerClientVersion("0.99.0", "0.157.1")).toBe("0.157.1");
    expect(newerClientVersion("0.158.0-alpha.2", "0.157.1")).toBe("0.158.0");
    expect(newerClientVersion("", "0.157.1")).toBe("0.157.1");
    expect(newerClientVersion("garbage", "0.157.1")).toBe("0.157.1");
  });

  test("tracks the published Codex CLI, so a new model is not hidden by a stale pin", async () => {
    mockFetch((url) =>
      url.includes("registry.npmjs.org") ? json({ version: "0.162.3" }) : json({}, 404),
    );
    expect(await codexClientVersion()).toBe("0.162.3");
  });

  test("never goes BELOW the floor, whatever the registry says", async () => {
    mockFetch(() => json({ version: "0.100.0" }));
    expect(await codexClientVersion()).toBe(CODEX_CLIENT_VERSION_FLOOR);
  });

  test("an unreachable registry falls to the floor, and is asked only once", async () => {
    mockFetch(() => {
      throw new Error("offline");
    });
    expect(await codexClientVersion()).toBe(CODEX_CLIENT_VERSION_FLOOR);
    expect(await codexClientVersion()).toBe(CODEX_CLIENT_VERSION_FLOOR);
    expect(calls).toHaveLength(1);
  });

  test("RUNE_CODEX_CLIENT_VERSION wins outright and asks nobody", async () => {
    process.env.RUNE_CODEX_CLIENT_VERSION = "9.9.9";
    mockFetch(() => json({ version: "0.162.3" }));
    expect(await codexClientVersion()).toBe("9.9.9");
    expect(calls).toHaveLength(0);
  });
});

describe("CodexProvider.listModels", () => {
  test("asks the account's catalogue, as the Codex CLI, at the resolved version", async () => {
    process.env.RUNE_CODEX_CLIENT_VERSION = "0.157.1";
    mockFetch(() =>
      json({
        models: [entry("gpt-6-astra", { priority: 1 }), entry("gpt-6-sol", { priority: 2 })],
      }),
    );
    const models = await new CodexProvider("tok-123", "acct-9").listModels();

    expect(models.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-sol"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.157.1",
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-123");
    expect(headers["chatgpt-account-id"]).toBe("acct-9");
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers.accept).toBe("application/json");
    // A GET carries no body, so none of the streaming request's headers.
    expect(headers["openai-beta"]).toBeUndefined();
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
  });

  test("a refused listing throws WITH the reason, so `rune models` can say why", async () => {
    process.env.RUNE_CODEX_CLIENT_VERSION = "0.157.1";
    mockFetch(() => json({ detail: "Unauthorized" }, 401));
    await expect(new CodexProvider("expired").listModels()).rejects.toThrow(
      /Codex request failed \(401\): Unauthorized/,
    );
  });
});

describe("OpenAI's /v1/models, narrowed to what an agent can drive", () => {
  test.each([
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-terra",
    "gpt-5.4-mini",
    "o4-mini",
    "gpt-5.6-cyber",
    "gpt-7-nova", // a release nobody has named yet is admitted by default
  ])("%s is offered", (id) => {
    expect(isOpenAIChatModel(id)).toBe(true);
  });

  test.each([
    "text-embedding-3-large",
    "gpt-image-2.5-flare",
    "gpt-realtime-2.1",
    "gpt-realtime-2.1-mini",
    "gpt-4o-mini-tts",
    "gpt-transcribe",
    "gpt-live-1",
    "gpt-4o-search-preview",
    "gpt-3.5-turbo-instruct",
    "whisper-1",
    "dall-e-3",
    "omni-moderation-latest",
    "davinci-002",
    "gpt-6-sol-2026-09-22", // a dated snapshot duplicates its listed alias
  ])("%s is not", (id) => {
    expect(isOpenAIChatModel(id)).toBe(false);
  });

  function withListing(provider: OpenAIProvider, data: { id: string; created: number }[]) {
    (provider as unknown as { client: unknown }).client = {
      models: { list: async () => ({ data }) },
    };
    return provider;
  }

  const LISTING = [
    { id: "gpt-5.4-mini", created: 1_770_000_000 },
    { id: "text-embedding-3-large", created: 1_700_000_000 },
    { id: "gpt-6-sol", created: 1_790_000_000 },
    { id: "gpt-6-sol-2026-09-22", created: 1_790_000_000 },
    { id: "gpt-6-astra", created: 1_780_000_000 },
  ];

  test("first-party listing is filtered and newest first", async () => {
    const models = await withListing(new OpenAIProvider("k"), LISTING).listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-6-sol", "gpt-6-astra", "gpt-5.4-mini"]);
  });

  test("other hosts on the same adapter are returned exactly as they list", async () => {
    const provider = new OpenAIProvider("k", "https://api.groq.com/openai/v1", "groq");
    const models = await withListing(provider, LISTING).listModels();
    expect(models.map((m) => m.id)).toEqual(LISTING.map((m) => m.id));
  });
});

describe("the GPT-6 effort floor follows each model's page", () => {
  test("sol and luna document `none`; astra does not, so it floors at `low`", () => {
    expect(OpenAIProvider.minimalReasoningEffort("gpt-6-sol")).toBe("none");
    expect(OpenAIProvider.minimalReasoningEffort("gpt-6-luna")).toBe("none");
    // Sending `none` to astra would 400 every Auto-mode classifier call.
    expect(OpenAIProvider.minimalReasoningEffort("gpt-6-astra")).toBe("low");
    // Not a prefix trap: a hypothetical `gpt-6-solar` is unknown, so `low`.
    expect(OpenAIProvider.minimalReasoningEffort("gpt-6-solar")).toBe("low");
  });
});
