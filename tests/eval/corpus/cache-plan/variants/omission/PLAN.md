# A response cache for fetchJson

## Step 1 — a cache interface, in `cache.ts`

Add `cache.ts` exporting `interface ResponseCache { get(key): Entry | undefined; set(key, entry): void }`
and an in-memory implementation keyed by URL, each entry carrying the body, the
status and the epoch milliseconds it was stored at.
Verified by: `bun test cache.test.ts`, which stores and reads back an entry and
shows a miss for an unknown key.

## Step 2 — read through the cache, in `fetcher.ts`

Change `fetchJson` to take an optional cache and a max age, returning a stored
entry when it is younger than the max age and going to the network otherwise.
The exported signature keeps `fetchJson(url)` working with no cache.
Verified by: `bun test fetcher.test.ts`, with a stub fetch that counts calls —
two calls to the same URL must reach the network once.
