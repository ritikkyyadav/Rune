// Acceptance for `dependent-migration`. Run by the runtime, never shown to the model.
// Split out of tests/eval/comparison/tasks.ts's single grader so each half of
// the migration has its own status in the report.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];
const safe = (message) =>
  String(message)
    .replace(/no such file or directory/gi, "missing")
    .replace(/command not found/gi, "unavailable");
const store = async () => await import(pathToFileURL(join(root, "store.ts")).href);
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-notes-"));
  return {
    dir,
    path: join(dir, "nested", "notes.json"),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const checks = {
  async migration() {
    const m = await store();
    const { path, done } = scratch();
    try {
      assert.deepEqual(await m.load(path), { version: 2, notes: [] });
      await m.save(path, { version: 2, notes: [] });
      writeFileSync(
        path,
        JSON.stringify({ version: 1, items: [{ key: "legacy", body: "keep me" }] }),
      );
      assert.deepEqual(await m.load(path), {
        version: 2,
        notes: [{ id: "legacy", text: "keep me", tags: [] }],
      });
      writeFileSync(path, "{bad");
      await assert.rejects(() => m.load(path));
      writeFileSync(path, JSON.stringify({ version: 2, notes: "bad" }));
      await assert.rejects(() => m.load(path));
    } finally {
      done();
    }
  },
  async upsert() {
    const m = await store();
    const before = {
      version: 2,
      notes: [
        { id: "a", text: "old", tags: [] },
        { id: "b", text: "b", tags: [] },
      ],
    };
    const frozen = JSON.stringify(before);
    const next = m.upsert(before, { id: "a", text: "new", tags: [" z ", "a", "a"] });
    assert.equal(JSON.stringify(before), frozen, "upsert mutated its input");
    assert.deepEqual(next.notes, [
      { id: "a", text: "new", tags: ["a", "z"] },
      { id: "b", text: "b", tags: [] },
    ]);
    const appended = m.upsert(next, { id: "c", text: "c", tags: [] });
    assert.deepEqual(
      appended.notes.map((entry) => entry.id),
      ["a", "b", "c"],
    );
  },
  async persistence() {
    const m = await store();
    const { path, done } = scratch();
    try {
      const value = { version: 2, notes: [{ id: "a", text: "one", tags: ["x"] }] };
      await m.save(path, value);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), value);
      const cli = spawnSync(process.execPath, [join(root, "cli.ts"), path, "new", "hello"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(cli.status, 0, `the CLI exited ${cli.status}: ${safe(cli.stderr ?? "")}`);
      assert.equal((await m.load(path)).notes.length, 2);
    } finally {
      done();
    }
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
