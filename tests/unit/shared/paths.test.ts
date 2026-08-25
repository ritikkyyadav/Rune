import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adoptLegacyEnv,
  ensureGearHome,
  getGearHome,
  migrateLegacyHome,
  resetGearHomeCache,
  takeHomeMigrationNote,
  usesLegacyWorkspaceDir,
  workspaceConfigDir,
  workspaceConfigPath,
} from "../../../packages/shared/src/paths";

let base: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "gear-paths-"));
  env = { HOME: base };
  resetGearHomeCache();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  resetGearHomeCache();
});

describe("getGearHome", () => {
  test("resolves ~/.gear on a fresh machine without creating anything", () => {
    expect(getGearHome(env)).toBe(join(base, ".gear"));
    expect(existsSync(join(base, ".gear"))).toBe(false);
  });

  test("honors GEAR_HOME and the legacy ALAN_HOME override", () => {
    expect(getGearHome({ ...env, GEAR_HOME: "/x/gear" })).toBe("/x/gear");
    expect(getGearHome({ ...env, ALAN_HOME: "/x/alan" })).toBe("/x/alan");
    expect(getGearHome({ ...env, GEAR_HOME: "/x/gear", ALAN_HOME: "/x/alan" })).toBe("/x/gear");
  });

  test("resolves a not-yet-migrated ~/.alan so data is never split in two", () => {
    mkdirSync(join(base, ".alan"));
    expect(getGearHome(env)).toBe(join(base, ".alan"));
    mkdirSync(join(base, ".gear"));
    resetGearHomeCache();
    expect(getGearHome(env)).toBe(join(base, ".gear"));
  });

  test("re-resolves when HOME changes", () => {
    const other = mkdtempSync(join(tmpdir(), "gear-paths-other-"));
    try {
      expect(getGearHome(env)).toBe(join(base, ".gear"));
      expect(getGearHome({ HOME: other })).toBe(join(other, ".gear"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("ensureGearHome creates the directory", () => {
    const dir = ensureGearHome();
    expect(existsSync(dir)).toBe(true);
  });
});

describe("migrateLegacyHome", () => {
  test("moves ~/.alan to ~/.gear, leaves a symlink, renames alan.db and reports once", () => {
    const legacy = join(base, ".alan");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "secrets.json"), "{}");
    writeFileSync(join(legacy, "alan.db"), "db");
    writeFileSync(join(legacy, "alan.db-wal"), "wal");

    const note = migrateLegacyHome(env);
    expect(note).toContain("moved");
    expect(note).toContain("gear.db");
    const modern = join(base, ".gear");
    expect(readFileSync(join(modern, "secrets.json"), "utf8")).toBe("{}");
    expect(existsSync(join(modern, "gear.db"))).toBe(true);
    expect(existsSync(join(modern, "gear.db-wal"))).toBe(true);
    expect(existsSync(join(modern, "alan.db"))).toBe(false);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(legacy, "secrets.json"), "utf8")).toBe("{}");
    expect(getGearHome(env)).toBe(modern);
    expect(takeHomeMigrationNote()).toBe(note);
    expect(takeHomeMigrationNote()).toBeNull();

    // Idempotent.
    expect(migrateLegacyHome(env)).toBeNull();
  });

  test("does nothing on a fresh machine or when ~/.gear already exists", () => {
    expect(migrateLegacyHome(env)).toBeNull();
    mkdirSync(join(base, ".gear"));
    mkdirSync(join(base, ".alan"));
    writeFileSync(join(base, ".alan", "alan.db"), "old");
    expect(migrateLegacyHome(env)).toBeNull();
    expect(existsSync(join(base, ".alan", "alan.db"))).toBe(true);
    expect(lstatSync(join(base, ".alan")).isDirectory()).toBe(true);
  });

  test("renames a stray alan.db inside an existing ~/.gear", () => {
    mkdirSync(join(base, ".gear"));
    writeFileSync(join(base, ".gear", "alan.db"), "old");
    expect(migrateLegacyHome(env)).toContain("renamed alan.db");
    expect(existsSync(join(base, ".gear", "gear.db"))).toBe(true);
  });

  test("an explicit GEAR_HOME override disables the directory move", () => {
    mkdirSync(join(base, ".alan"));
    expect(migrateLegacyHome({ ...env, GEAR_HOME: join(base, "custom") })).toBeNull();
    expect(lstatSync(join(base, ".alan")).isDirectory()).toBe(true);
  });
});

describe("workspace config dir", () => {
  test("prefers .gear, reads legacy .alan, defaults to .gear", () => {
    const ws = mkdtempSync(join(tmpdir(), "gear-ws-"));
    try {
      expect(workspaceConfigDir(ws)).toBe(join(ws, ".gear"));
      expect(usesLegacyWorkspaceDir(ws)).toBe(false);
      mkdirSync(join(ws, ".alan"));
      expect(workspaceConfigDir(ws)).toBe(join(ws, ".alan"));
      expect(workspaceConfigPath(ws, "config.toml")).toBe(join(ws, ".alan", "config.toml"));
      expect(usesLegacyWorkspaceDir(ws)).toBe(true);
      mkdirSync(join(ws, ".gear"));
      expect(workspaceConfigDir(ws)).toBe(join(ws, ".gear"));
      expect(usesLegacyWorkspaceDir(ws)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("adoptLegacyEnv", () => {
  test("maps ALAN_* onto unset GEAR_* names only", () => {
    const e: NodeJS.ProcessEnv = {
      ALAN_THEME: "dark",
      ALAN_MODEL: "x",
      GEAR_MODEL: "keep",
      OTHER: "1",
    };
    expect(adoptLegacyEnv(e).sort()).toEqual(["ALAN_THEME"]);
    expect(e.GEAR_THEME).toBe("dark");
    expect(e.GEAR_MODEL).toBe("keep");
    expect(adoptLegacyEnv(e)).toEqual([]);
  });
});
