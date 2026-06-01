import type { SearchBackend, SearchOptions, SearchResponse } from "./types";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const TIMEOUT_MS = 10_000;

interface TavilyApiResponse {
  answer?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
  }>;
}

/**
 * Tavily — a search API purpose-built for LLMs. Returns clean, ranked snippets
 * and an optional synthesized answer. Requires TAVILY_API_KEY.
 */
export class TavilyBackend implements SearchBackend {
  readonly name = "tavily";
  private apiKey: string;

  constructor(apiKey = process.env.TAVILY_API_KEY ?? "") {
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const body: Record<string, unknown> = {
        api_key: this.apiKey,
        query,
        max_results: opts.maxResults,
        search_depth: "basic",
        include_answer: true,
      };
      // For freshness-sensitive queries, switch to the news topic with a day window.
      if (opts.recencyDays !== undefined) {
        body.topic = "news";
        body.days = opts.recencyDays;
      }

      const res = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Tavily HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      }

      const json = (await res.json()) as TavilyApiResponse;
      return {
        answer: json.answer,
        results: (json.results ?? []).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: r.content ?? "",
          publishedDate: r.published_date,
        })),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
