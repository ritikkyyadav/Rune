import type { SearchBackend, SearchOptions, SearchResponse } from "./types";
import { fetchJson, str } from "./http";

interface JinaResponse {
  data?: Array<{
    title?: string;
    url?: string;
    description?: string;
    content?: string;
    date?: string;
  }>;
}

/**
 * Jina — `s.jina.ai`, the search half of the Reader API. `X-Respond-With:
 * no-content` keeps the call to titles + descriptions; web_fetch reads the
 * pages that matter. Requires JINA_API_KEY.
 */
export class JinaBackend implements SearchBackend {
  readonly name = "jina";
  constructor(private readonly apiKey = process.env.JINA_API_KEY ?? "") {}

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const json = await fetchJson<JinaResponse>(
      "Jina",
      `https://s.jina.ai/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "X-Respond-With": "no-content",
        },
      },
    );
    return {
      results: (json.data ?? []).slice(0, opts.maxResults).map((r) => ({
        title: str(r.title),
        url: str(r.url),
        snippet: str(r.description) || str(r.content).slice(0, 400),
        publishedDate: r.date,
      })),
    };
  }
}
