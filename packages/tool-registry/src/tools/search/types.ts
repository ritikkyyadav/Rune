// ─── Pluggable Web-Search Backend Contract ───
// A backend is one search provider (Tavily, Brave, DuckDuckGo, …). The
// web_search tool selects the best available backend at call time and falls
// through to the next one on failure, so the agent always gets results.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ISO date or human age string when the source exposes one. */
  publishedDate?: string;
}

export interface SearchOptions {
  /** Max results to return. */
  maxResults: number;
  /** When set, bias toward results from the last N days (latest news/updates). */
  recencyDays?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Some backends (e.g. Tavily) can synthesize a direct answer. */
  answer?: string;
}

export interface SearchBackend {
  /** Stable identifier, surfaced in tool output so results are attributable. */
  readonly name: string;
  /** True when the backend has what it needs to run (e.g. an API key present). */
  isAvailable(): boolean;
  search(query: string, opts: SearchOptions): Promise<SearchResponse>;
}
