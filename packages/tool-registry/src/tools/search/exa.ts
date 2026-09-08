import type { SearchBackend, SearchOptions, SearchResponse } from "./types";
import { fetchJson, sinceIso, str } from "./http";

interface ExaResponse {
  results?: Array<{
    title?: string;
    url?: string;
    publishedDate?: string;
    text?: string;
    highlights?: string[];
  }>;
}

/**
 * Exa — neural search built for LLM consumers. Asks for a short text excerpt
 * per result so the snippet is the page's own words rather than a meta tag.
 * Requires EXA_API_KEY.
 */
export class ExaBackend implements SearchBackend {
  readonly name = "exa";
  constructor(private readonly apiKey = process.env.EXA_API_KEY ?? "") {}

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const body: Record<string, unknown> = {
      query,
      numResults: opts.maxResults,
      type: "auto",
      contents: { text: { maxCharacters: 600 } },
    };
    if (opts.recencyDays !== undefined) body.startPublishedDate = sinceIso(opts.recencyDays);
    const json = await fetchJson<ExaResponse>("Exa", "https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify(body),
    });
    return {
      results: (json.results ?? []).map((r) => ({
        title: str(r.title),
        url: str(r.url),
        snippet: (r.highlights?.join(" ") || str(r.text)).slice(0, 600),
        publishedDate: r.publishedDate,
      })),
    };
  }
}
