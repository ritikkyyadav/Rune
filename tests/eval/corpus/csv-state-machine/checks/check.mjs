// Acceptance for `csv-state-machine`. Run by the runtime, never shown to the model.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// The acceptance script is STAGED OUTSIDE the workspace and run with cwd set
// to the workspace (see rune-cli's --acceptance help). A path resolved from
// import.meta.url would point at the staging directory, not at the tree under
// test, so the tree is addressed through the working directory.
const root = process.cwd();
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
    // Whitespace is DATA, inside quotes and outside them. "Keep whitespace
    // inside cells exactly" was stated in the prompt and checked nowhere: a
    // parser that trims unquoted fields passed every criterion.
    assert.deepEqual(parseCsv(" a , b "), [[" a ", " b "]]);
    // The BOM is stripped only where the prompt says it may appear — at the
    // very front. Anywhere else it is a character in a cell.
    assert.deepEqual(parseCsv("a,b\uFEFFc"), [["a", "b\uFEFFc"]]);
    assert.deepEqual(parseCsv("\uFEFFa,\uFEFFb"), [["a", "\uFEFFb"]]);
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
