export interface FetchResult {
  status: number;
  body: string;
}

/** Every call goes to the network. There is no cache and no coalescing. */
export async function fetchJson(url: string): Promise<FetchResult> {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}
