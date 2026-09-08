import type { SearchBackend, SearchOptions, SearchResponse } from "./types";
import { fetchJson, str } from "./http";

interface KagiResponse {
  data?: Array<{ t?: number; url?: string; title?: string; snippet?: string; published?: string }>;
}

/** Kagi — the paid ad-free index. `t === 0` rows are results (1 = related queries). Requires KAGI_API_KEY. */
export class KagiBackend implements SearchBackend {
  readonly name = "kagi";
  constructor(private readonly apiKey = process.env.KAGI_API_KEY ?? "") {}

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query, limit: String(opts.maxResults) });
    const json = await fetchJson<KagiResponse>(
      "Kagi",
      `https://kagi.com/api/v0/search?${params.toString()}`,
      { headers: { Authorization: `Bot ${this.apiKey}` } },
    );
    return {
      results: (json.data ?? [])
        .filter((r) => (r.t ?? 0) === 0)
        .slice(0, opts.maxResults)
        .map((r) => ({
          title: str(r.title),
          url: str(r.url),
          snippet: str(r.snippet),
          publishedDate: r.published,
        })),
    };
  }
}
