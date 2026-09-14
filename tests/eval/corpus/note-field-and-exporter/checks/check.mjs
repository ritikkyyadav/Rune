// Acceptance for `note-field-and-exporter`. Run by the runtime, never shown to the model.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");
const load = async (file, name) => (await import(pathToFileURL(join(root, file)).href))[name];

const checks = {
  async field() {
    const createNote = await load("notes.ts", "createNote");
    assert.deepEqual(createNote("a", "hello").tags, []);
    assert.deepEqual(createNote("a", "hello", ["x", "y"]).tags, ["x", "y"]);
  },
  async column() {
    const createNote = await load("notes.ts", "createNote");
    const toCsv = await load("export-csv.ts", "toCsv");
    const csv = toCsv([createNote("a", "hello", ["x", "y"]), createNote("b", "bye")]);
    assert.equal(csv, "id,text,tags\na,hello,x;y\nb,bye,\n");
  },
  async quoting() {
    const createNote = await load("notes.ts", "createNote");
    const toCsv = await load("export-csv.ts", "toCsv");
    const csv = toCsv([createNote("a", 'say "hi", twice', ["x"])]);
    assert.equal(csv, 'id,text,tags\na,"say ""hi"", twice",x\n');
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
