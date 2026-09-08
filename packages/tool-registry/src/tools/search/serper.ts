import type { SearchBackend, SearchOptions, SearchResponse } from "./types";
import { fetchJson, str, tbsFor } from "./http";

interface SerperResponse {
  answerBox?: { answer?: string; snippet?: string };
  organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
}

/** Serper — Google results over a simple JSON API. Requires SERPER_API_KEY. */
export class SerperBackend implements SearchBackend {
  readonly name = "serper";
  constructor(private readonly apiKey = process.env.SERPER_API_KEY ?? "") {}

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const body: Record<string, unknown> = { q: query, num: opts.maxResults };
    const tbs = tbsFor(opts.recencyDays);
    if (tbs) body.tbs = tbs;
    const json = await fetchJson<SerperResponse>("Serper", "https://google.serper.dev/search", {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": this.apiKey },
      body: JSON.stringify(body),
    });
    const answer = json.answerBox?.answer || json.answerBox?.snippet;
    return {
      ...(answer ? { answer } : {}),
      results: (json.organic ?? []).slice(0, opts.maxResults).map((r) => ({
        title: str(r.title),
        url: str(r.link),
        snippet: str(r.snippet),
        publishedDate: r.date,
      })),
    };
  }
}
