// Acceptance for `dependent-migration`. Run by the runtime, never shown to the model.
// Split out of tests/eval/comparison/tasks.ts's single grader so each half of
// the migration has its own status in the report.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
      // "invalid shape must throw" includes a version this build does not
      // know. A loader that reads {version:99} as a v2 store silently drops
      // whatever that file really was.
      writeFileSync(path, JSON.stringify({ version: 99, notes: [] }));
      await assert.rejects(
        () => m.load(path),
        "an unknown store version was accepted instead of throwing",
      );
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
    const { dir, path, done } = scratch();
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

      // "Save atomically using a temporary file in the destination directory."
      // Atomicity is observable without racing it: `rename` replaces a
      // destination the process cannot write to, because the permission that
      // matters is the DIRECTORY's. A plain `writeFile(path, …)` cannot.
      const readOnly = join(dir, "read-only.json");
      writeFileSync(readOnly, JSON.stringify({ version: 2, notes: [] }));
      chmodSync(readOnly, 0o444);
      await m.save(readOnly, value);
      assert.deepEqual(
        JSON.parse(readFileSync(readOnly, "utf8")),
        value,
        "save did not replace a read-only destination, so it is not writing a temporary file and renaming it",
      );
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
