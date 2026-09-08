// ─── Shared HTTP for the search backends ───
// Every hosted engine is one bounded JSON round-trip with a bearer-ish header.
// The shape below is what the first three backends each hand-rolled; the nine
// that followed share it so a timeout or a truncated error body is decided in
// one place.

export const SEARCH_TIMEOUT_MS = 10_000;

/**
 * Bounded JSON request. A non-2xx becomes an Error carrying the host's own
 * words (truncated), which is what the web_search tool surfaces per backend and
 * what the login-time probe prints — "Exa HTTP 401: invalid api key" is the
 * message that tells someone what to fix.
 */
export async function fetchJson<T>(
  label: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${label} HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Google-style `tbs` freshness bucket for a day window (Serper, SerpAPI, Firecrawl). */
export function tbsFor(days?: number): string | undefined {
  if (days === undefined) return undefined;
  if (days <= 1) return "qdr:d";
  if (days <= 7) return "qdr:w";
  if (days <= 31) return "qdr:m";
  return "qdr:y";
}

/** Named window for hosts that take day|week|month|year. */
export function windowFor(days?: number): "day" | "week" | "month" | "year" | undefined {
  if (days === undefined) return undefined;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  return "year";
}

/** ISO timestamp `days` ago, for hosts that take a start date. */
export function sinceIso(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}
