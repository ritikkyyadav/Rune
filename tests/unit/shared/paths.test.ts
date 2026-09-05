import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adoptLegacyEnv,
  ensureRuneHome,
  getRuneHome,
  migrateLegacyHome,
  resetRuneHomeCache,
  takeHomeMigrationNote,
  usesLegacyWorkspaceDir,
  workspaceConfigDir,
  workspaceConfigPath,
} from "../../../packages/shared/src/paths";

let base: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "rune-paths-"));
  env = { HOME: base };
  resetRuneHomeCache();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  resetRuneHomeCache();
});

describe("getRuneHome", () => {
  test("resolves ~/.rune on a fresh machine without creating anything", () => {
    expect(getRuneHome(env)).toBe(join(base, ".rune"));
    expect(existsSync(join(base, ".rune"))).toBe(false);
  });

  test("honors RUNE_HOME and the previous name's GEAR_HOME override", () => {
    expect(getRuneHome({ ...env, RUNE_HOME: "/x/rune" })).toBe("/x/rune");
    expect(getRuneHome({ ...env, GEAR_HOME: "/x/gear" })).toBe("/x/gear");
    expect(getRuneHome({ ...env, RUNE_HOME: "/x/rune", GEAR_HOME: "/x/gear" })).toBe("/x/rune");
  });

  test("resolves a not-yet-migrated ~/.gear so data is never split in two", () => {
    mkdirSync(join(base, ".gear"));
    expect(getRuneHome(env)).toBe(join(base, ".gear"));
    // A ~/.rune that holds data is the home; an empty one is not (next test).
    mkdirSync(join(base, ".rune"));
    writeFileSync(join(base, ".rune", "rune.db"), "db");
    resetRuneHomeCache();
    expect(getRuneHome(env)).toBe(join(base, ".rune"));
  });

  test("falls back to an older real ~/.alan when neither newer home exists", () => {
    mkdirSync(join(base, ".alan"));
    expect(getRuneHome(env)).toBe(join(base, ".alan"));
  });

  test("re-resolves when HOME changes", () => {
    const other = mkdtempSync(join(tmpdir(), "rune-paths-other-"));
    try {
      expect(getRuneHome(env)).toBe(join(base, ".rune"));
      expect(getRuneHome({ HOME: other })).toBe(join(other, ".rune"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("ensureRuneHome creates the directory", () => {
    // Redirected: the real home must never be created by a test run — a fresh
    // `~/.rune` created here once pre-empted the founder's data migration.
    const prev = process.env.RUNE_HOME;
    process.env.RUNE_HOME = join(base, "ensured");
    try {
      resetRuneHomeCache();
      const dir = ensureRuneHome();
      expect(dir).toBe(join(base, "ensured"));
      expect(existsSync(dir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.RUNE_HOME;
      else process.env.RUNE_HOME = prev;
      resetRuneHomeCache();
    }
  });

  test("a fresh, data-less ~/.rune does not shadow a real ~/.gear", () => {
    mkdirSync(join(base, ".rune"));
    mkdirSync(join(base, ".gear"));
    writeFileSync(join(base, ".gear", "gear.db"), "db");
    expect(getRuneHome(env)).toBe(join(base, ".gear"));
  });
});

describe("migrateLegacyHome", () => {
  test("moves ~/.gear to ~/.rune, leaves a symlink, renames gear.db and GEAR.md, reports once", () => {
    const legacy = join(base, ".gear");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "secrets.json"), "{}");
    writeFileSync(join(legacy, "gear.db"), "db");
    writeFileSync(join(legacy, "gear.db-wal"), "wal");
    writeFileSync(join(legacy, "GEAR.md"), "my instructions");

    const note = migrateLegacyHome(env);
    expect(note).toContain("moved");
    expect(note).toContain("rune.db");
    expect(note).toContain("RUNE.md");
    const modern = join(base, ".rune");
    expect(readFileSync(join(modern, "secrets.json"), "utf8")).toBe("{}");
    expect(existsSync(join(modern, "rune.db"))).toBe(true);
    expect(existsSync(join(modern, "rune.db-wal"))).toBe(true);
    expect(existsSync(join(modern, "gear.db"))).toBe(false);
    expect(readFileSync(join(modern, "RUNE.md"), "utf8")).toBe("my instructions");
    expect(existsSync(join(modern, "GEAR.md"))).toBe(false);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(legacy, "secrets.json"), "utf8")).toBe("{}");
    expect(getRuneHome(env)).toBe(modern);
    expect(takeHomeMigrationNote()).toBe(note);
    expect(takeHomeMigrationNote()).toBeNull();

    // Idempotent.
    expect(migrateLegacyHome(env)).toBeNull();
  });

  test("moves ~/.gear in even when a fresh ~/.rune already exists, keeping the fresh entries", () => {
    // The case that bit on 2026-09-03: a test run had created an empty
    // ~/.rune, the installer saw "already migrated", and 200 MB of sessions
    // stayed behind in ~/.gear.
    mkdirSync(join(base, ".rune", "bin"), { recursive: true });
    writeFileSync(join(base, ".rune", "bin", "rune"), "#!/bin/sh\n");
    const legacy = join(base, ".gear");
    mkdirSync(join(legacy, "bin"), { recursive: true });
    writeFileSync(join(legacy, "gear.db"), "db");
    writeFileSync(join(legacy, "secrets.json"), "{}");
    writeFileSync(join(legacy, "bin", "gear"), "old launcher");

    const note = migrateLegacyHome(env);
    expect(note).toContain("moved");
    const modern = join(base, ".rune");
    expect(readFileSync(join(modern, "secrets.json"), "utf8")).toBe("{}");
    expect(existsSync(join(modern, "rune.db"))).toBe(true);
    // The legacy `bin` won the collision (it is the one with data); the fresh
    // copy is parked beside the home rather than lost.
    expect(readFileSync(join(modern, "bin", "gear"), "utf8")).toBe("old launcher");
    const parked = readdirSync(base).find((n) => n.startsWith(".rune.fresh-"));
    expect(parked).toBeDefined();
    expect(existsSync(join(base, parked!, "bin", "rune"))).toBe(true);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(getRuneHome(env)).toBe(modern);
  });

  test("a fresh ~/.rune with nothing colliding is folded in and removed", () => {
    mkdirSync(join(base, ".rune"));
    writeFileSync(join(base, ".rune", "prefs.json"), "{}");
    mkdirSync(join(base, ".gear"));
    writeFileSync(join(base, ".gear", "gear.db"), "db");
    expect(migrateLegacyHome(env)).toContain("moved");
    expect(readFileSync(join(base, ".rune", "prefs.json"), "utf8")).toBe("{}");
    expect(existsSync(join(base, ".rune", "rune.db"))).toBe(true);
    expect(readdirSync(base).some((n) => n.startsWith(".rune.fresh-"))).toBe(false);
  });

  test("a ~/.rune that already holds data is never touched", () => {
    mkdirSync(join(base, ".rune"));
    writeFileSync(join(base, ".rune", "rune.db"), "mine");
    mkdirSync(join(base, ".gear"));
    writeFileSync(join(base, ".gear", "gear.db"), "old");
    expect(migrateLegacyHome(env)).toBeNull();
    expect(readFileSync(join(base, ".rune", "rune.db"), "utf8")).toBe("mine");
    expect(lstatSync(join(base, ".gear")).isDirectory()).toBe(true);
  });

  test("a machine that already migrated Alan → Gear keeps its whole symlink chain", () => {
    // ~/.alan → ~/.gear (the previous rename's courtesy link), ~/.gear real.
    const gear = join(base, ".gear");
    mkdirSync(gear);
    writeFileSync(join(gear, "gear.db"), "db");
    symlinkSync(gear, join(base, ".alan"), "dir");

    expect(migrateLegacyHome(env)).toContain("moved");
    const modern = join(base, ".rune");
    expect(lstatSync(gear).isSymbolicLink()).toBe(true);
    // The old link still resolves, through the new one, to the same files.
    expect(readFileSync(join(base, ".alan", "rune.db"), "utf8")).toBe("db");
    expect(getRuneHome(env)).toBe(modern);
  });

  test("moves an older ~/.alan when there is no ~/.gear either", () => {
    const legacy = join(base, ".alan");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "alan.db"), "db");
    const note = migrateLegacyHome(env);
    expect(note).toContain("moved");
    expect(note).toContain("renamed alan.db");
    expect(existsSync(join(base, ".rune", "rune.db"))).toBe(true);
  });

  test("does nothing on a fresh machine or when ~/.rune already holds data", () => {
    expect(migrateLegacyHome(env)).toBeNull();
    mkdirSync(join(base, ".rune"));
    writeFileSync(join(base, ".rune", "config.toml"), "");
    mkdirSync(join(base, ".gear"));
    writeFileSync(join(base, ".gear", "gear.db"), "old");
    expect(migrateLegacyHome(env)).toBeNull();
    expect(existsSync(join(base, ".gear", "gear.db"))).toBe(true);
    expect(lstatSync(join(base, ".gear")).isDirectory()).toBe(true);
  });

  test("renames a stray gear.db inside an existing ~/.rune", () => {
    mkdirSync(join(base, ".rune"));
    writeFileSync(join(base, ".rune", "gear.db"), "old");
    expect(migrateLegacyHome(env)).toContain("renamed gear.db");
    expect(existsSync(join(base, ".rune", "rune.db"))).toBe(true);
  });

  test("an explicit RUNE_HOME override disables the directory move", () => {
    mkdirSync(join(base, ".gear"));
    expect(migrateLegacyHome({ ...env, RUNE_HOME: join(base, "custom") })).toBeNull();
    expect(lstatSync(join(base, ".gear")).isDirectory()).toBe(true);
  });
});

describe("workspace config dir", () => {
  test("prefers .rune, reads legacy .gear then .alan, defaults to .rune", () => {
    const ws = mkdtempSync(join(tmpdir(), "rune-ws-"));
    try {
      expect(workspaceConfigDir(ws)).toBe(join(ws, ".rune"));
      expect(usesLegacyWorkspaceDir(ws)).toBe(false);
      mkdirSync(join(ws, ".alan"));
      expect(workspaceConfigDir(ws)).toBe(join(ws, ".alan"));
      mkdirSync(join(ws, ".gear"));
      expect(workspaceConfigDir(ws)).toBe(join(ws, ".gear"));
      expect(workspaceConfigPath(ws, "config.toml")).toBe(join(ws, ".gear", "config.toml"));
      expect(usesLegacyWorkspaceDir(ws)).toBe(true);
      mkdirSync(join(ws, ".rune"));
      expect(workspaceConfigDir(ws)).toBe(join(ws, ".rune"));
      expect(usesLegacyWorkspaceDir(ws)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("adoptLegacyEnv", () => {
  test("maps GEAR_* onto unset RUNE_* names only", () => {
    const e: NodeJS.ProcessEnv = {
      GEAR_THEME: "dark",
      GEAR_MODEL: "x",
      RUNE_MODEL: "keep",
      OTHER: "1",
    };
    expect(adoptLegacyEnv(e).sort()).toEqual(["GEAR_THEME"]);
    expect(e.RUNE_THEME).toBe("dark");
    expect(e.RUNE_MODEL).toBe("keep");
    expect(adoptLegacyEnv(e)).toEqual([]);
  });
});
