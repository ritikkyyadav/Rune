import type { SearchBackend, SearchOptions, SearchResponse } from "./types";
import { fetchJson, str, tbsFor } from "./http";

interface SerpApiResponse {
  answer_box?: { answer?: string; snippet?: string };
  organic_results?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
}

/** SerpAPI — scraped Google (and other engines). Requires SERPAPI_API_KEY. */
export class SerpApiBackend implements SearchBackend {
  readonly name = "serpapi";
  constructor(
    private readonly apiKey = process.env.SERPAPI_API_KEY ?? process.env.SERPAPI_KEY ?? "",
  ) {}

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const params = new URLSearchParams({
      engine: "google",
      q: query,
      num: String(opts.maxResults),
      api_key: this.apiKey,
    });
    const tbs = tbsFor(opts.recencyDays);
    if (tbs) params.set("tbs", tbs);
    const json = await fetchJson<SerpApiResponse>(
      "SerpAPI",
      `https://serpapi.com/search.json?${params.toString()}`,
    );
    const answer = json.answer_box?.answer || json.answer_box?.snippet;
    return {
      ...(answer ? { answer } : {}),
      results: (json.organic_results ?? []).slice(0, opts.maxResults).map((r) => ({
        title: str(r.title),
        url: str(r.link),
        snippet: str(r.snippet),
        publishedDate: r.date,
      })),
    };
  }
}
