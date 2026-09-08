// ─── Backend selection ───
// One engine per SEARCH_PROVIDER_PRESETS row (the roster `/login` offers), built
// from the environment at call time so a key connected mid-session is picked
// up by the next search. The presets own the order; this file owns the wiring.

import { searchKeyFromEnv, searchPresetsByRank, type SearchProviderPreset } from "@rune/shared";
import type { SearchBackend, SearchResponse } from "./types";
import { TavilyBackend } from "./tavily";
import { BraveBackend } from "./brave";
import { DuckDuckGoBackend } from "./duckduckgo";
import { ExaBackend } from "./exa";
import { SerperBackend } from "./serper";
import { SerpApiBackend } from "./serpapi";
import { JinaBackend } from "./jina";
import { FirecrawlBackend } from "./firecrawl";
import { YouBackend } from "./you";
import { KagiBackend } from "./kagi";
import { PerplexityBackend } from "./perplexity";
import { SearxngBackend } from "./searxng";

export type { SearchBackend, SearchResult, SearchResponse, SearchOptions } from "./types";
export {
  TavilyBackend,
  BraveBackend,
  DuckDuckGoBackend,
  ExaBackend,
  SerperBackend,
  SerpApiBackend,
  JinaBackend,
  FirecrawlBackend,
  YouBackend,
  KagiBackend,
  PerplexityBackend,
  SearxngBackend,
};

export type SearchBackendName =
  | "tavily"
  | "exa"
  | "brave"
  | "serper"
  | "perplexity"
  | "firecrawl"
  | "jina"
  | "you"
  | "kagi"
  | "serpapi"
  | "searxng"
  | "duckduckgo";

type Factory = (preset: SearchProviderPreset, env: NodeJS.ProcessEnv) => SearchBackend;

const key = (p: SearchProviderPreset, env: NodeJS.ProcessEnv): string =>
  searchKeyFromEnv(p, env) ?? "";

/** Preset id → the backend that speaks to it. A preset with no row here is listed but never asked. */
const FACTORIES: Record<string, Factory> = {
  tavily: (p, env) => new TavilyBackend(key(p, env)),
  exa: (p, env) => new ExaBackend(key(p, env)),
  brave: (p, env) => new BraveBackend(key(p, env)),
  serper: (p, env) => new SerperBackend(key(p, env)),
  perplexity: (p, env) => new PerplexityBackend(key(p, env)),
  firecrawl: (p, env) => new FirecrawlBackend(key(p, env)),
  jina: (p, env) => new JinaBackend(key(p, env)),
  you: (p, env) => new YouBackend(key(p, env)),
  kagi: (p, env) => new KagiBackend(key(p, env)),
  serpapi: (p, env) => new SerpApiBackend(key(p, env)),
  searxng: (p, env) => new SearxngBackend((p.urlEnvVar && env[p.urlEnvVar]) || ""),
  duckduckgo: () => new DuckDuckGoBackend(),
};

/** The backend for one engine id, built from `env`, whether or not it is usable. */
export function searchBackendFor(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): SearchBackend | undefined {
  const preset = searchPresetsByRank().find((p) => p.id === id);
  const make = FACTORIES[id];
  return preset && make ? make(preset, env) : undefined;
}

/**
 * Return the available backends to try, in priority order. The first is the
 * primary; the rest are fallbacks the web_search tool walks on failure.
 *
 * `preferred` (from `[search].provider` config, RUNE_SEARCH_BACKEND, or the
 * engine `/login` connected last) moves one backend to the front; "auto" or
 * unset keeps the presets' rank order. Unavailable backends (no key, no URL)
 * are dropped — DuckDuckGo is always available, so the list is never empty.
 */
export function selectBackends(
  preferred?: string,
  env: NodeJS.ProcessEnv = process.env,
): SearchBackend[] {
  const pref = (preferred ?? env.RUNE_SEARCH_BACKEND ?? "auto").toLowerCase();
  const available = searchPresetsByRank()
    .map((p) => FACTORIES[p.id]?.(p, env))
    .filter((b): b is SearchBackend => !!b && b.isAvailable());
  return orderBackends(available, pref);
}

/**
 * The answer order for the connected engines. `preferred` leads when it is
 * connected; everything else keeps the presets' rank (quality judgement:
 * LLM-built indexes, then general web indexes, then scraped fallbacks).
 */
export function orderBackends(available: SearchBackend[], preferred: string): SearchBackend[] {
  if (preferred !== "auto") {
    const i = available.findIndex((b) => b.name === preferred);
    if (i > 0) return [available[i]!, ...available.slice(0, i), ...available.slice(i + 1)];
    return available;
  }
  // TODO(human): the "auto" policy — what answers first when several engines
  // are connected and nobody named one. `available` arrives in the presets'
  // rank order (tavily, exa, brave, … duckduckgo last), which is a quality
  // judgement baked into search-providers.ts. Alternatives worth weighing:
  // the engine connected most recently (prefs.search already records it),
  // the cheapest one first, or rotating past an engine that answered empty
  // last time. Returning `available` unchanged keeps rank order, which is what
  // the tests in tests/unit/tool-registry/search.test.ts currently pin.
  return available;
}

export interface SearchProbe {
  ok: boolean;
  backend: string;
  /** What happened, in the host's words when it failed. */
  detail?: string;
  ms: number;
}

/**
 * One real search against one engine — the login-time check that a pasted key
 * actually works. A format check would pass a revoked key; the host's own
 * answer is the only verification that means anything. Bounded and
 * never-throwing: the outcome is a result, not an exception.
 */
export async function probeSearchBackend(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { query?: string; timeoutMs?: number } = {},
): Promise<SearchProbe> {
  const backend = searchBackendFor(id, env);
  if (!backend) return { ok: false, backend: id, detail: "unknown search engine", ms: 0 };
  if (!backend.isAvailable()) {
    return { ok: false, backend: id, detail: "no key or URL configured", ms: 0 };
  }
  const start = performance.now();
  const timeoutMs = opts.timeoutMs ?? 8_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const resp: SearchResponse = await Promise.race([
      backend.search(opts.query ?? "rune terminal coding agent", { maxResults: 1 }),
      timeout,
    ]);
    const n = resp.results.length;
    const ms = Math.round(performance.now() - start);
    return n > 0 || resp.answer
      ? { ok: true, backend: id, detail: `${n} result${n === 1 ? "" : "s"}`, ms }
      : { ok: false, backend: id, detail: "no results", ms };
  } catch (err) {
    return {
      ok: false,
      backend: id,
      detail: err instanceof Error ? err.message : String(err),
      ms: Math.round(performance.now() - start),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
