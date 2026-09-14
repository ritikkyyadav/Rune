export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  // TODO: the claim below is still not atomic.
  const runners = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const at = next;
      await Promise.resolve();
      next = at + 1;
      results[at] = await worker(items[at]!, at);
    }
  });
  await Promise.all(runners);
  return results;
}
