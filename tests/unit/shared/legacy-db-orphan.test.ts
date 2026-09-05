/**
 * The stranded-legacy-database warning.
 *
 * The bug this pins: migrateLegacyHome renames gear.db (or the older alan.db)
 * → rune.db only when rune.db is ABSENT. Once both exist the rename can never
 * fire, and the legacy file is orphaned permanently and silently. That was
 * assumed to be harmless pre-rename residue until an audit found an alan.db
 * holding 8 sessions from 2026-08-26 that appeared nowhere in the current
 * database — real history, written well after the rename by a build that
 * resolved the home differently, invisible to `/sessions` and one `rm` away
 * from gone.
 *
 * The migration cannot safely merge them (colliding ids, diverged schemas), so
 * the contract is: never delete, never merge, always say so.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyHome, resetRuneHomeCache } from "../../../packages/shared/src/paths";

describe("legacy database left beside the current one", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rune-home-orphan-"));
    resetRuneHomeCache();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    resetRuneHomeCache();
  });

  test("warns when both databases exist, and deletes neither", () => {
    writeFileSync(join(home, "gear.db"), "legacy");
    writeFileSync(join(home, "rune.db"), "current");

    const note = migrateLegacyHome({ RUNE_HOME: home } as NodeJS.ProcessEnv);

    expect(note).not.toBeNull();
    expect(note).toContain("gear.db");
    expect(note).toContain("NOT visible");
    // The whole point: the user's data is still there to recover.
    expect(Bun.file(join(home, "gear.db")).size).toBeGreaterThan(0);
    expect(Bun.file(join(home, "rune.db")).size).toBeGreaterThan(0);
  });

  test("an alan.db from two renames ago gets the same warning", () => {
    writeFileSync(join(home, "alan.db"), "older");
    writeFileSync(join(home, "rune.db"), "current");
    const note = migrateLegacyHome({ RUNE_HOME: home } as NodeJS.ProcessEnv);
    expect(note).toContain("alan.db");
    expect(note).toContain("NOT visible");
  });

  test("renames the newest legacy database and warns about the older one", () => {
    writeFileSync(join(home, "gear.db"), "legacy");
    writeFileSync(join(home, "alan.db"), "older");
    const note = migrateLegacyHome({ RUNE_HOME: home } as NodeJS.ProcessEnv);
    expect(note).toContain("renamed gear.db");
    expect(note).toContain("alan.db still exists");
    expect(Bun.file(join(home, "rune.db")).size).toBeGreaterThan(0);
    expect(Bun.file(join(home, "alan.db")).size).toBeGreaterThan(0);
  });

  test("still renames when only the legacy database exists", () => {
    writeFileSync(join(home, "gear.db"), "legacy");

    const note = migrateLegacyHome({ RUNE_HOME: home } as NodeJS.ProcessEnv);

    expect(note).toContain("renamed");
    expect(Bun.file(join(home, "rune.db")).size).toBeGreaterThan(0);
  });

  test("says nothing when there is no legacy database", () => {
    writeFileSync(join(home, "rune.db"), "current");
    expect(migrateLegacyHome({ RUNE_HOME: home } as NodeJS.ProcessEnv)).toBeNull();
  });
});
