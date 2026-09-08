import type { SearchBackend, SearchOptions, SearchResponse } from "./types";
import { fetchJson, str, windowFor } from "./http";

interface YouHit {
  title?: string;
  url?: string;
  description?: string;
  snippets?: string[];
}
interface YouResponse {
  results?: { web?: YouHit[] };
  hits?: YouHit[];
}

/** You.com — web search API. Requires YDC_API_KEY (or YOU_API_KEY). */
export class YouBackend implements SearchBackend {
  readonly name = "you";
  constructor(private readonly apiKey = process.env.YDC_API_KEY ?? process.env.YOU_API_KEY ?? "") {}

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const params = new URLSearchParams({ query, count: String(opts.maxResults) });
    const freshness = windowFor(opts.recencyDays);
    if (freshness) params.set("freshness", freshness);
    const json = await fetchJson<YouResponse>(
      "You.com",
      `https://api.ydc-index.io/v1/search?${params.toString()}`,
      { headers: { "X-API-Key": this.apiKey } },
    );
    // Two generations of the API answer with two shapes; read whichever came.
    const hits = json.results?.web ?? json.hits ?? [];
    return {
      results: hits.slice(0, opts.maxResults).map((r) => ({
        title: str(r.title),
        url: str(r.url),
        snippet: str(r.description) || (r.snippets ?? []).join(" ").slice(0, 400),
      })),
    };
  }
}
