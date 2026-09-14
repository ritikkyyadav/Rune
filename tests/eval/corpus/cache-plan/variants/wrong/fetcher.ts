export interface FetchResult {
  status: number;
  body: string;
}

const cache = new Map<string, FetchResult>();

export async function fetchJson(url: string): Promise<FetchResult> {
  const hit = cache.get(url);
  if (hit) return hit;
  const response = await fetch(url);
  const result = { status: response.status, body: await response.text() };
  cache.set(url, result);
  return result;
}
