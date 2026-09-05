import type { SearchBackend } from "./types";
import { TavilyBackend } from "./tavily";
import { BraveBackend } from "./brave";
import { DuckDuckGoBackend } from "./duckduckgo";

export type { SearchBackend, SearchResult, SearchResponse, SearchOptions } from "./types";
export { TavilyBackend, BraveBackend, DuckDuckGoBackend };

export type SearchBackendName = "tavily" | "brave" | "duckduckgo";

// Priority order when no preference is given: best data first, free fallback last.
const DEFAULT_ORDER: SearchBackendName[] = ["tavily", "brave", "duckduckgo"];

function makeBackend(name: SearchBackendName): SearchBackend {
  switch (name) {
    case "tavily":
      return new TavilyBackend();
    case "brave":
      return new BraveBackend();
    case "duckduckgo":
      return new DuckDuckGoBackend();
  }
}

/**
 * Return the available backends to try, in priority order. The first is the
 * primary; the rest are fallbacks the web_search tool walks on failure.
 *
 * `preferred` (from `[search].provider` config or RUNE_SEARCH_BACKEND) moves one
 * backend to the front; "auto"/unset keeps the default order. Unavailable
 * backends (missing API key) are dropped — DuckDuckGo is always available, so
 * the list is never empty.
 */
export function selectBackends(preferred?: string): SearchBackend[] {
  const pref = (preferred ?? process.env.RUNE_SEARCH_BACKEND ?? "auto").toLowerCase();

  let order = [...DEFAULT_ORDER];
  if (pref !== "auto" && (DEFAULT_ORDER as string[]).includes(pref)) {
    order = [pref as SearchBackendName, ...DEFAULT_ORDER.filter((n) => n !== pref)];
  }

  return order.map(makeBackend).filter((b) => b.isAvailable());
}
