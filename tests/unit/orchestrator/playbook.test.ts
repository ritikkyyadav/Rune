import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PLAYBOOK_PENDING_REL,
  PLAYBOOK_REL,
  playbookEntries,
  renderPlaybookBlock,
  writePlaybook,
} from "../../../packages/orchestrator/src/playbook";
import type { NotebookEntry } from "../../../packages/orchestrator/src/notebook/store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-playbook-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function entry(
  title: string,
  body: string,
  sessions: string[],
  extra: Partial<NotebookEntry> = {},
): NotebookEntry {
  return {
    id: `id-${++n}`,
    kind: "fact",
    scope: "repo",
    repoKey: "r1",
    stackKey: null,
    title,
    body,
    provenance: { sessions },
    uses: 0,
    wins: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastUsed: null,
    retired: false,
    // Active by default here: P7.7 restricts the playbook to ACTIVE lessons,
    // so every fixture that is meant to reach the file has to have climbed the
    // ladder. The stage cases are covered in tests/unit/evolve/lessons.test.ts.
    stage: "active",
    ...extra,
  };
}

describe("playbookEntries", () => {
  test("keeps only this repo's live entries seen in two or more sessions", () => {
    const rows = [
      entry("test-command", "test: `bun test`", ["a", "b"]),
      entry("build-command", "build: `bun run build`", ["a"]),
      entry("avoid:x:1", "`x` fails here", ["a", "b"], { retired: true }),
      entry("monorepo-layout", "Monorepo", ["a", "b"], {
        scope: "stack",
        repoKey: null,
        stackKey: "bun",
      }),
    ];
    expect(playbookEntries(rows).map((e) => e.title)).toEqual(["test-command"]);
    // A trial lesson is still being measured; writing it into an executable
    // skill would be acting on it before the measurement finished.
    expect(
      playbookEntries([entry("trial-command", "not yet", ["a", "b"], { stage: "trial" })]),
    ).toEqual([]);
    expect(playbookEntries(rows, { minSessions: 1 }).map((e) => e.title)).toEqual([
      "build-command",
      "test-command",
    ]);
  });
});

describe("renderPlaybookBlock", () => {
  test("groups lessons under sections and counts distinct sessions", () => {
    const block = renderPlaybookBlock([
      entry("avoid:npm:abc", "`npm test` fails here: ENOENT", ["a", "b"]),
      entry("test-command", "test: `bun test` (verified working here)", ["b", "c"]),
      entry("fix:npm:def", "`npm install` needs network: true here", ["a", "c"]),
      entry("monorepo-layout", "Monorepo — JS workspaces: packages/*", ["a", "b", "c"]),
    ]);
    expect(block.startsWith("<!-- rune:learned:start -->")).toBe(true);
    expect(block.endsWith("<!-- rune:learned:end -->")).toBe(true);
    expect(block).toContain("from 3 sessions");
    const order = ["## Verified commands", "## Layout", "## Fixes", "## Pitfalls"].map((h) =>
      block.indexOf(h),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(block).toContain("- test: `bun test` (verified working here) _(2 sessions)_");
  });
});

describe("writePlaybook", () => {
  const recurring = [entry("test-command", "test: `bun test` (verified working here)", ["a", "b"])];

  test("nothing recurring and no file → nothing written", () => {
    expect(writePlaybook(dir, [entry("x", "y", ["a"])])).toBeNull();
    expect(existsSync(join(dir, PLAYBOOK_REL))).toBe(false);
  });

  test("writes a skill with frontmatter, the block, and a notes section", () => {
    const w = writePlaybook(dir, recurring)!;
    expect(w).toMatchObject({ changed: true, lessons: 1, sessions: 2 });
    const text = readFileSync(w.path, "utf8");
    expect(text.startsWith("---\nname: playbook\ndescription: How to work in ")).toBe(true);
    expect(text).toContain("learned from 2 sessions here");
    expect(text).toContain("# Playbook");
    expect(text).toContain("<!-- rune:learned:start -->");
    expect(text).toContain("## Notes");
  });

  test("a playbook written under the previous name is adopted, not duplicated", () => {
    const w = writePlaybook(dir, recurring)!;
    const legacy = readFileSync(w.path, "utf8").replaceAll("rune:learned", "gear:learned");
    writeFileSync(w.path, legacy);
    const again = writePlaybook(dir, recurring)!;
    expect(again.changed).toBe(true);
    const text = readFileSync(w.path, "utf8");
    expect(text.split("<!-- rune:learned:start -->")).toHaveLength(2);
    expect(text).not.toContain("gear:learned");
  });

  test("an unchanged block is not rewritten", () => {
    writePlaybook(dir, recurring);
    const again = writePlaybook(dir, recurring)!;
    expect(again.changed).toBe(false);
  });

  test("a person's edits outside the markers survive a rewrite", () => {
    const w = writePlaybook(dir, recurring)!;
    const edited = readFileSync(w.path, "utf8").replace(
      "## Notes\n",
      "## Notes\n\nRun the suite unsandboxed.\n",
    );
    writeFileSync(w.path, edited);
    const next = writePlaybook(dir, [
      ...recurring,
      entry("avoid:npm:abc", "`npm test` fails here: ENOENT", ["a", "b"]),
    ])!;
    expect(next.changed).toBe(true);
    const text = readFileSync(next.path, "utf8");
    expect(text).toContain("Run the suite unsandboxed.");
    expect(text).toContain("## Pitfalls");
    expect(text.split("<!-- rune:learned:start -->")).toHaveLength(2);
  });

  test("a hand-written playbook without markers gets the block appended, not replaced", () => {
    const path = join(dir, PLAYBOOK_REL);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "---\nname: playbook\n---\n\nAlways run `make setup` first.\n");
    const w = writePlaybook(dir, recurring, { enabled: true })!;
    expect(w.path).toBe(path);
    const text = readFileSync(w.path, "utf8");
    expect(text).toContain("Always run `make setup` first.");
    expect(text).toContain("<!-- rune:learned:start -->");
    expect(text.indexOf("make setup")).toBeLessThan(text.indexOf("<!-- rune:learned:start -->"));
  });

  // ── The consent gate (P7.7) ──

  test("without consent the block goes to PENDING.md, which the loader never reads", () => {
    const w = writePlaybook(dir, recurring)!;
    expect(w.pending).toBe(true);
    expect(w.path).toBe(join(dir, PLAYBOOK_PENDING_REL));
    // The whole point: no SKILL.md exists, so nothing the loader globs for is
    // there to load. A learned skill that can direct multi-step behaviour is
    // inert until a person turns it on.
    expect(existsSync(join(dir, PLAYBOOK_REL))).toBe(false);
    expect(readFileSync(w.path, "utf8")).toContain("<!-- rune:learned:start -->");
  });

  test("with consent it writes the real skill file", () => {
    const w = writePlaybook(dir, recurring, { enabled: true })!;
    expect(w.pending).toBe(false);
    expect(w.path).toBe(join(dir, PLAYBOOK_REL));
    expect(existsSync(join(dir, PLAYBOOK_REL))).toBe(true);
  });
});
