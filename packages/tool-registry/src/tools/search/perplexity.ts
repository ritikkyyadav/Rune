import type { SearchBackend, SearchOptions, SearchResponse } from "./types";
import { fetchJson, str, windowFor } from "./http";

interface PerplexityResponse {
  results?: Array<{ title?: string; url?: string; snippet?: string; date?: string }>;
}

/** Perplexity Search API — Perplexity's own index, results only (no LLM). Requires PERPLEXITY_API_KEY. */
export class PerplexityBackend implements SearchBackend {
  readonly name = "perplexity";
  constructor(private readonly apiKey = process.env.PERPLEXITY_API_KEY ?? "") {}

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const body: Record<string, unknown> = { query, max_results: opts.maxResults };
    const recency = windowFor(opts.recencyDays);
    if (recency) body.search_recency_filter = recency;
    const json = await fetchJson<PerplexityResponse>(
      "Perplexity",
      "https://api.perplexity.ai/search",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      },
    );
    return {
      results: (json.results ?? []).slice(0, opts.maxResults).map((r) => ({
        title: str(r.title),
        url: str(r.url),
        snippet: str(r.snippet),
        publishedDate: r.date,
      })),
    };
  }
}
