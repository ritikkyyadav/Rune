/**
 * The second roster: web-search engines. They connect through the same
 * `/login` flow and the same keychain account shape as model providers, so
 * these tests pin the two things that make that work — a clean, collision-free
 * roster, and an env bridge whose precedence matches the model providers'
 * (keychain → secrets file → environment).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SEARCH_PROVIDER_PRESETS,
  getSearchPreset,
  isSearchProviderId,
  keyedSearchPresets,
  searchKeyFromEnv,
  searchPresetsByRank,
} from "../../../packages/shared/src/search-providers";
import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";
import {
  SEARCH_KEY_PRESETS,
  applySearchKeysToEnv,
  searchKeyStatus,
  searchProviderConnected,
  setProviderKey,
  setLocalEndpoint,
} from "../../../packages/shared/src/secrets";

describe("the search roster", () => {
  it("has unique ids that never collide with a model provider", () => {
    const ids = SEARCH_PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const models = new Set(PROVIDER_PRESETS.map((p) => p.id));
    for (const id of ids) expect({ id, collides: models.has(id) }).toEqual({ id, collides: false });
  });

  it("offers the engines people ask for by name", () => {
    const ids = SEARCH_PROVIDER_PRESETS.map((p) => p.id);
    for (const id of [
      "tavily",
      "exa",
      "brave",
      "serper",
      "perplexity",
      "jina",
      "firecrawl",
      "kagi",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("gives every engine a pitch and an https docs URL", () => {
    for (const p of SEARCH_PROVIDER_PRESETS) {
      expect(p.hint.length).toBeGreaterThan(0);
      expect(p.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("uses a distinct env var per keyed engine, aliases included", () => {
    const vars = keyedSearchPresets().flatMap((p) => [p.envVar!, ...(p.altEnvVars ?? [])]);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it("ranks the built-in scraper last and an LLM-built index first", () => {
    const byRank = searchPresetsByRank().map((p) => p.id);
    expect(byRank[0]).toBe("tavily");
    expect(byRank.at(-1)).toBe("duckduckgo");
  });

  it("has exactly one keyless engine and one URL-addressed engine", () => {
    expect(SEARCH_PROVIDER_PRESETS.filter((p) => p.keyless).map((p) => p.id)).toEqual([
      "duckduckgo",
    ]);
    const local = SEARCH_PROVIDER_PRESETS.filter((p) => p.local);
    expect(local.map((p) => p.id)).toEqual(["searxng"]);
    expect(local[0]!.urlEnvVar).toBe("SEARXNG_URL");
    expect(local[0]!.envVar).toBeUndefined();
  });

  it("keyedSearchPresets is everything that takes a key", () => {
    const keyed = keyedSearchPresets().map((p) => p.id);
    expect(keyed).not.toContain("duckduckgo");
    expect(keyed).not.toContain("searxng");
    expect(keyed).toContain("exa");
  });

  it("resolves a key from the primary env var, then the aliases", () => {
    const brave = getSearchPreset("brave")!;
    expect(searchKeyFromEnv(brave, { BRAVE_API_KEY: "a" } as NodeJS.ProcessEnv)).toBe("a");
    expect(searchKeyFromEnv(brave, { BRAVE_SEARCH_API_KEY: "b" } as NodeJS.ProcessEnv)).toBe("b");
    expect(
      searchKeyFromEnv(brave, {
        BRAVE_API_KEY: "a",
        BRAVE_SEARCH_API_KEY: "b",
      } as NodeJS.ProcessEnv),
    ).toBe("a");
    expect(searchKeyFromEnv(brave, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("looks engines up by id", () => {
    expect(getSearchPreset("exa")?.label).toBe("Exa");
    expect(getSearchPreset("mistral")).toBeUndefined(); // a model provider, not an engine
    expect(isSearchProviderId("kagi")).toBe(true);
    expect(isSearchProviderId("openai")).toBe(false);
  });

  it("the legacy SEARCH_KEY_PRESETS list is a projection of the keyed roster", () => {
    expect(SEARCH_KEY_PRESETS.map((p) => p.id)).toEqual(keyedSearchPresets().map((p) => p.id));
    const brave = SEARCH_KEY_PRESETS.find((p) => p.id === "brave")!;
    expect(brave.envVar).toBe("BRAVE_API_KEY");
    expect(brave.altEnvVar).toBe("BRAVE_SEARCH_API_KEY");
  });
});

describe("the env bridge", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-search-"));
    process.env.RUNE_SECRETS_PATH = join(dir, "secrets.json");
  });
  afterEach(() => {
    delete process.env.RUNE_SECRETS_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies keychain keys, then secrets-file keys, into the engines' env vars", () => {
    setProviderKey("brave", "brave-from-secrets");
    setProviderKey("exa", "exa-from-secrets");
    const env = {} as NodeJS.ProcessEnv;
    applySearchKeysToEnv(env, { exa: "exa-from-keychain" });
    expect(env.EXA_API_KEY).toBe("exa-from-keychain"); // keychain outranks the file
    expect(env.BRAVE_API_KEY).toBe("brave-from-secrets");
    expect(env.TAVILY_API_KEY).toBeUndefined();
  });

  it("carries a self-hosted engine's URL into its URL variable", () => {
    setLocalEndpoint("searxng", "http://search.lan:8080");
    const env = {} as NodeJS.ProcessEnv;
    applySearchKeysToEnv(env);
    expect(env.SEARXNG_URL).toBe("http://search.lan:8080");
  });

  it("reports where each key came from, never the key itself", () => {
    setProviderKey("brave", "brave-from-secrets-1234");
    const rows = searchKeyStatus({ TAVILY_API_KEY: "tvly-env-1234" } as NodeJS.ProcessEnv, {
      exa: "exa-keychain-1234",
    });
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.exa!.source).toBe("keychain");
    expect(by.brave!.source).toBe("saved");
    expect(by.tavily!.source).toBe("env");
    expect(by.serper!.source).toBe("none");
    for (const r of rows) expect(r.masked).not.toContain("keychain-1234");
  });

  it("knows what counts as connected on each kind of engine", () => {
    const none = {} as NodeJS.ProcessEnv;
    expect(searchProviderConnected("duckduckgo", none)).toBe(true); // nothing to connect
    expect(searchProviderConnected("exa", none)).toBe(false);
    expect(searchProviderConnected("exa", none, { exa: "k" })).toBe(true);
    expect(searchProviderConnected("exa", { EXA_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe(true);
    expect(searchProviderConnected("searxng", none)).toBe(false);
    setLocalEndpoint("searxng", "http://localhost:8080");
    expect(searchProviderConnected("searxng", none)).toBe(true);
    expect(searchProviderConnected("nope", none)).toBe(false);
  });
});
