// Acceptance for `queue-race`. Run by the runtime, never shown to the model.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");
const load = async () => (await import(pathToFileURL(join(root, "queue.ts")).href)).mapLimit;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the pipeline while counting starts per index and peak concurrency.
 *
 * Later items finish SOONER on purpose: a worker pool that collects results in
 * completion order rather than by index looks right when every task takes the
 * same time, and this is the cheapest way to tell the two apart.
 */
async function trace(mapLimit, items, limit) {
  const starts = new Map();
  let live = 0;
  let peak = 0;
  const results = await mapLimit(items, limit, async (item, index) => {
    starts.set(index, (starts.get(index) ?? 0) + 1);
    live += 1;
    peak = Math.max(peak, live);
    await sleep(2 + (items.length - index) * 5);
    live -= 1;
    return item * 2;
  });
  return { starts, peak, results };
}

const checks = {
  async once() {
    const mapLimit = await load();
    const { starts, results } = await trace(mapLimit, [1, 2, 3, 4, 5, 6], 3);
    assert.deepEqual(results, [2, 4, 6, 8, 10, 12], "results must keep input order");
    assert.equal(starts.size, 6, "every index must be processed");
    for (const [index, count] of starts)
      assert.equal(count, 1, `index ${index} was processed ${count} times`);
  },
  async concurrency() {
    const mapLimit = await load();
    const { peak } = await trace(mapLimit, [1, 2, 3, 4, 5, 6, 7, 8], 2);
    assert.ok(peak <= 2, `peak concurrency was ${peak}, limit was 2`);
    assert.ok(peak >= 2, `peak concurrency was ${peak}: the limit is not being used`);
  },
  async edges() {
    const mapLimit = await load();
    assert.deepEqual(await mapLimit([], 3, async (item) => item), []);
    const { results, peak } = await trace(mapLimit, [1, 2, 3], 1);
    assert.deepEqual(results, [2, 4, 6]);
    assert.equal(peak, 1);
  },
};

const run = checks[which];
if (!run) {
  console.log(`acceptance failed: unknown criterion ${which}`);
  process.exit(1);
}
try {
  await run();
  console.log(`acceptance ok: ${which}`);
  process.exit(0);
} catch (error) {
  console.log(`acceptance failed: ${which} — ${safe(error?.message ?? error)}`);
  process.exit(1);
}
