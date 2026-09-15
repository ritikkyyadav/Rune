# A response cache for fetchJson

## Step 1 — a cache interface, in `cache.ts`

Add `cache.ts` exporting `interface ResponseCache { get(key): Entry | undefined; set(key, entry): void }`
and an in-memory implementation keyed by URL.
Verified by: `bun test cache.test.ts`, which stores and reads back an entry.

## Step 2 — read through the cache, in `fetcher.ts`

Change `fetchJson` to take an optional cache and return a stored entry when
there is one. Nothing evicts an entry, and two concurrent calls each go out.
Verified by: `bun test fetcher.test.ts`, with a stub fetch that counts calls.

## Step 3 — mention the cache in `README.md`

Add a paragraph to `README.md` saying `fetchJson` can take a cache.
Verified by: `bun test docs.test.ts`, which checks the paragraph is present.
