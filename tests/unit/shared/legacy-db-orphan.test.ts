/**
 * The stranded-legacy-database warning.
 *
 * The bug this pins: migrateLegacyHome renames alan.db → gear.db only when
 * gear.db is ABSENT. Once both exist the rename can never fire, and the legacy
 * file is orphaned permanently and silently. That was assumed to be harmless
 * pre-rename residue until an audit found ~/.gear/alan.db holding 8 sessions
 * from 2026-08-26 that appear nowhere in gear.db — real history, written well
 * after the rename by a build that resolved the home differently, invisible to
 * `/sessions` and one `rm` away from gone.
 *
 * The migration cannot safely merge them (colliding ids, diverged schemas), so
 * the contract is: never delete, never merge, always say so.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyHome, resetGearHomeCache } from "../../../packages/shared/src/paths";

describe("legacy database left beside the current one", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gear-home-orphan-"));
    resetGearHomeCache();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    resetGearHomeCache();
  });

  test("warns when both databases exist, and deletes neither", () => {
    writeFileSync(join(home, "alan.db"), "legacy");
    writeFileSync(join(home, "gear.db"), "current");

    const note = migrateLegacyHome({ GEAR_HOME: home } as NodeJS.ProcessEnv);

    expect(note).not.toBeNull();
    expect(note).toContain("alan.db");
    expect(note).toContain("NOT visible");
    // The whole point: the user's data is still there to recover.
    expect(Bun.file(join(home, "alan.db")).size).toBeGreaterThan(0);
    expect(Bun.file(join(home, "gear.db")).size).toBeGreaterThan(0);
  });

  test("still renames when only the legacy database exists", () => {
    writeFileSync(join(home, "alan.db"), "legacy");

    const note = migrateLegacyHome({ GEAR_HOME: home } as NodeJS.ProcessEnv);

    expect(note).toContain("renamed");
    expect(Bun.file(join(home, "gear.db")).size).toBeGreaterThan(0);
  });

  test("says nothing when there is no legacy database", () => {
    writeFileSync(join(home, "gear.db"), "current");
    expect(migrateLegacyHome({ GEAR_HOME: home } as NodeJS.ProcessEnv)).toBeNull();
  });
});
