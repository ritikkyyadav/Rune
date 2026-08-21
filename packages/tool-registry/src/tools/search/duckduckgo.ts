import type { SearchBackend, SearchOptions, SearchResponse } from "./types";

const TIMEOUT_MS = 10_000;

// Pull title/href + snippet out of DuckDuckGo's HTML results page.
const RESULT_REGEX =
  /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * DuckDuckGo HTML endpoint — no API key required, so this is always available
 * as the universal fallback. Lower fidelity than Tavily/Brave (HTML scraping,
 * subject to rate limits), but keeps web_search working with zero config.
 */
export class DuckDuckGoBackend implements SearchBackend {
  readonly name = "duckduckgo";

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResponse> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Gear-Agent/1.0" },
      });
      const html = await res.text();

      const results: SearchResponse["results"] = [];
      let m: RegExpExecArray | null;
      RESULT_REGEX.lastIndex = 0;
      while ((m = RESULT_REGEX.exec(html)) && results.length < opts.maxResults) {
        const rUrl = decodeURIComponent((m[1].match(/uddg=([^&]+)/) || [])[1] || m[1]);
        const title = m[2].replace(/<[^>]+>/g, "").trim();
        const snippet = m[3].replace(/<[^>]+>/g, "").trim();
        if (title && rUrl) results.push({ title, url: rUrl, snippet });
      }
      return { results };
    } finally {
      clearTimeout(timer);
    }
  }
}
