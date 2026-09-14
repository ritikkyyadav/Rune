export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const results: R[] = new Array(items.length);
  let next = 0;
  // The index is claimed synchronously, before any await, so no two runners
  // can read the same one.
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const at = next++;
      if (at >= items.length) return;
      results[at] = await worker(items[at]!, at);
    }
  });
  await Promise.all(runners);
  return results;
}
