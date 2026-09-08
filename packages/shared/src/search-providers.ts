// ─── Web-search providers ───
// The second roster. A model provider is the intelligence; a search provider
// is the eyes — the index the `web_search` tool (and /research) queries. Both
// are connected the same way — `/login`, pick it, paste a key, kept in the OS
// keychain — and both are read from one list, so adding a search engine is one
// entry here plus a backend in @rune/tool-registry.
//
// Kept apart from PROVIDER_PRESETS on purpose. Everything that walks that list
// assumes a chat endpoint behind each row: the gateway builder registers it,
// the model picker lists its models, the tier resolver names ids on it. A
// search engine has no models, no tiers and no gateway registration; a row in
// that list would mean teaching every consumer to skip it. The two rosters
// share only what they genuinely have in common — `ConnectablePreset`, the
// fields a sign-in flow needs — so the one API-key strategy serves both.

import type { ConnectablePreset } from "./providers.js";

export interface SearchProviderPreset extends ConnectablePreset {
  /** The picker's one-line pitch: what this engine is good FOR. */
  hint: string;
  /** Other env vars the key may already live under (BRAVE_SEARCH_API_KEY). */
  altEnvVars?: string[];
  /** Nothing to connect: works with no credential at all (DuckDuckGo). */
  keyless?: boolean;
  /** Env var that carries the base URL of a self-hosted engine (SearXNG). */
  urlEnvVar?: string;
  /**
   * Default priority when several engines are connected — lower answers
   * first, the rest are fallbacks the tool walks on failure. The order is a
   * quality judgement, not a fact: indexes built for LLM consumers first
   * (clean snippets, a synthesized answer), general web indexes next, scraped
   * fallbacks last. `[search] provider`, RUNE_SEARCH_BACKEND, or the engine
   * you connected most recently overrides it.
   */
  rank: number;
}

export const SEARCH_PROVIDER_PRESETS: SearchProviderPreset[] = [
  {
    id: "tavily",
    label: "Tavily",
    hint: "built for agents: answers + clean snippets",
    envVar: "TAVILY_API_KEY",
    docsUrl: "https://app.tavily.com/home",
    keyHint: "tvly-…",
    rank: 10,
  },
  {
    id: "exa",
    label: "Exa",
    hint: "neural search, strong for research",
    envVar: "EXA_API_KEY",
    docsUrl: "https://dashboard.exa.ai/api-keys",
    rank: 20,
  },
  {
    id: "brave",
    label: "Brave Search",
    hint: "independent web index, free tier",
    envVar: "BRAVE_API_KEY",
    altEnvVars: ["BRAVE_SEARCH_API_KEY"],
    docsUrl: "https://brave.com/search/api/",
    keyHint: "BSA…",
    rank: 30,
  },
  {
    id: "serper",
    label: "Serper",
    hint: "Google results, cheap and fast",
    envVar: "SERPER_API_KEY",
    docsUrl: "https://serper.dev/api-key",
    rank: 40,
  },
  {
    id: "perplexity",
    label: "Perplexity Search",
    hint: "Perplexity's own web index",
    envVar: "PERPLEXITY_API_KEY",
    docsUrl: "https://www.perplexity.ai/settings/api",
    keyHint: "pplx-…",
    rank: 50,
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    hint: "search with page content in one call",
    envVar: "FIRECRAWL_API_KEY",
    docsUrl: "https://www.firecrawl.dev/app/api-keys",
    keyHint: "fc-…",
    rank: 60,
  },
  {
    id: "jina",
    label: "Jina",
    hint: "s.jina.ai search + reader",
    envVar: "JINA_API_KEY",
    docsUrl: "https://jina.ai/api-dashboard/",
    keyHint: "jina_…",
    rank: 70,
  },
  {
    id: "you",
    label: "You.com",
    hint: "web search API with snippets",
    envVar: "YDC_API_KEY",
    altEnvVars: ["YOU_API_KEY"],
    docsUrl: "https://api.you.com/",
    rank: 80,
  },
  {
    id: "kagi",
    label: "Kagi",
    hint: "premium ad-free index (paid)",
    envVar: "KAGI_API_KEY",
    docsUrl: "https://kagi.com/settings?p=api",
    rank: 90,
  },
  {
    id: "serpapi",
    label: "SerpAPI",
    hint: "Google and other engines, scraped",
    envVar: "SERPAPI_API_KEY",
    altEnvVars: ["SERPAPI_KEY"],
    docsUrl: "https://serpapi.com/manage-api-key",
    rank: 100,
  },
  {
    // Self-hosted metasearch: a URL, not a key. The instance must serve JSON
    // (`search.formats` includes "json" in its settings.yml).
    id: "searxng",
    label: "SearXNG",
    hint: "self-hosted metasearch, by URL",
    local: true,
    baseUrl: "http://localhost:8080",
    urlEnvVar: "SEARXNG_URL",
    docsUrl: "https://docs.searxng.org/",
    rank: 110,
  },
  {
    // The zero-config fallback: HTML scraping, rate-limited, always last.
    id: "duckduckgo",
    label: "DuckDuckGo",
    hint: "built in, no key (rate-limited)",
    keyless: true,
    docsUrl: "https://duckduckgo.com/",
    rank: 999,
  },
];

/** Look up a search preset by id. */
export function getSearchPreset(id: string): SearchProviderPreset | undefined {
  return SEARCH_PROVIDER_PRESETS.find((p) => p.id === id);
}

export function isSearchProviderId(id: string): boolean {
  return SEARCH_PROVIDER_PRESETS.some((p) => p.id === id);
}

/** The engines that take an API key (everything but the keyless and URL ones). */
export function keyedSearchPresets(): SearchProviderPreset[] {
  return SEARCH_PROVIDER_PRESETS.filter((p) => !!p.envVar);
}

/** The key for an engine as the environment supplies it (primary var, then aliases). */
export function searchKeyFromEnv(
  preset: SearchProviderPreset,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const vars = [preset.envVar, ...(preset.altEnvVars ?? [])].filter((v): v is string => !!v);
  for (const v of vars) {
    const val = env[v];
    if (val) return val;
  }
  return undefined;
}

/** Presets in answer order (lowest rank first). */
export function searchPresetsByRank(): SearchProviderPreset[] {
  return [...SEARCH_PROVIDER_PRESETS].sort((a, b) => a.rank - b.rank);
}
