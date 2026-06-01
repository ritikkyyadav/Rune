import type { SearchBackend, SearchOptions, SearchResponse } from "./types";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const TIMEOUT_MS = 10_000;

interface BraveApiResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      page_age?: string;
    }>;
  };
}

/** Map a day window to Brave's coarse freshness buckets. */
function freshnessFor(days?: number): string | undefined {
  if (days === undefined) return undefined;
  if (days <= 1) return "pd";
  if (days <= 7) return "pw";
  if (days <= 31) return "pm";
  return "py";
}

/**
 * Brave Search API — independent, high-quality web index with a generous free
 * tier. Requires BRAVE_API_KEY (a.k.a. BRAVE_SEARCH_API_KEY).
 */
export class BraveBackend implements SearchBackend {
  readonly name = "brave";
  private apiKey: string;

  constructor(apiKey = process.env.BRAVE_API_KEY ?? process.env.BRAVE_SEARCH_API_KEY ?? "") {
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query, count: String(opts.maxResults) });
    const freshness = freshnessFor(opts.recencyDays);
    if (freshness) params.set("freshness", freshness);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BRAVE_ENDPOINT}?${params.toString()}`, {
        signal: ctrl.signal,
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
        },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Brave HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      }

      const json = (await res.json()) as BraveApiResponse;
      return {
        results: (json.web?.results ?? []).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: r.description ?? "",
          publishedDate: r.page_age,
        })),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
