import type { SearchBackend, SearchOptions, SearchResponse } from "./types";
import { fetchJson, str, tbsFor } from "./http";

interface FirecrawlResponse {
  success?: boolean;
  data?: Array<{ title?: string; url?: string; description?: string; markdown?: string }>;
}

/** Firecrawl — search with optional page content. Requires FIRECRAWL_API_KEY. */
export class FirecrawlBackend implements SearchBackend {
  readonly name = "firecrawl";
  constructor(private readonly apiKey = process.env.FIRECRAWL_API_KEY ?? "") {}

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const body: Record<string, unknown> = { query, limit: opts.maxResults };
    const tbs = tbsFor(opts.recencyDays);
    if (tbs) body.tbs = tbs;
    const json = await fetchJson<FirecrawlResponse>(
      "Firecrawl",
      "https://api.firecrawl.dev/v1/search",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      },
    );
    return {
      results: (json.data ?? []).slice(0, opts.maxResults).map((r) => ({
        title: str(r.title),
        url: str(r.url),
        snippet: str(r.description) || str(r.markdown).slice(0, 400),
      })),
    };
  }
}
