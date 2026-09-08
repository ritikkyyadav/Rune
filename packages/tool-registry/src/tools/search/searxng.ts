import type { SearchBackend, SearchOptions, SearchResponse } from "./types";
import { fetchJson, str, windowFor } from "./http";

interface SearxngResponse {
  results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }>;
}

/**
 * SearXNG — a self-hosted metasearch instance, reached by URL (SEARXNG_URL or
 * `/login` → Web search → SearXNG). The instance must allow the JSON format
 * (`search.formats` in its settings.yml), or it answers 403.
 */
export class SearxngBackend implements SearchBackend {
  readonly name = "searxng";
  constructor(private readonly baseUrl = process.env.SEARXNG_URL ?? "") {}

  isAvailable(): boolean {
    return this.baseUrl.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query, format: "json" });
    const range = windowFor(opts.recencyDays);
    if (range) params.set("time_range", range);
    const base = this.baseUrl.replace(/\/+$/, "");
    const json = await fetchJson<SearxngResponse>(
      "SearXNG",
      `${base}/search?${params.toString()}`,
      { headers: { Accept: "application/json" } },
    );
    return {
      results: (json.results ?? []).slice(0, opts.maxResults).map((r) => ({
        title: str(r.title),
        url: str(r.url),
        snippet: str(r.content),
        publishedDate: r.publishedDate,
      })),
    };
  }
}
