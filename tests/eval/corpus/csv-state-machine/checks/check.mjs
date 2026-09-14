// Acceptance for `csv-state-machine`. Run by the runtime, never shown to the model.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");
const ok = () => {
  console.log(`acceptance ok: ${which}`);
  process.exit(0);
};
const load = async () => (await import(pathToFileURL(join(root, "csv.ts")).href)).parseCsv;

const checks = {
  async empty() {
    const parseCsv = await load();
    assert.deepEqual(parseCsv(""), []);
    assert.deepEqual(parseCsv("a,b\r\n"), [["a", "b"]]);
    assert.deepEqual(parseCsv("a,,c\n\n"), [["a", "", "c"], [""]]);
  },
  async quoted() {
    const parseCsv = await load();
    assert.deepEqual(parseCsv('\uFEFF"a,b","x""y",z'), [["a,b", 'x"y', "z"]]);
    assert.deepEqual(parseCsv('"a\r\nb",c\r\n" d ",""'), [
      ["a\r\nb", "c"],
      [" d ", ""],
    ]);
  },
  async unterminated() {
    const parseCsv = await load();
    assert.throws(() => parseCsv('"unfinished'));
  },
};

const run = checks[which];
if (!run) {
  console.log(`acceptance failed: unknown criterion ${which}`);
  process.exit(1);
}
try {
  await run();
  ok();
} catch (error) {
  console.log(`acceptance failed: ${which} — ${safe(error?.message ?? error)}`);
  process.exit(1);
}
