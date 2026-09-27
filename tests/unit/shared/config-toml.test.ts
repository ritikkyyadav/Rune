/**
 * Changelog-mining pilot, failure type T24 (config loading), 2026-09-27.
 *
 * `config.toml` was read by a line-at-a-time reader that understood a subset
 * of TOML, and the subset missed shapes people write: a list over several
 * lines became the string "[" (its entries dropped without a word), a quoted
 * value was cut at the first `#`, a quoted list item was split at its commas,
 * and a path Rune itself wrote came back with its backslashes doubled.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfigFilePath, loadConfig, setConfigValue } from "../../../packages/shared/src/config";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rune-config-toml-"));
  mkdirSync(join(root, ".rune"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function project(lines: string[]): void {
  writeFileSync(getConfigFilePath("project", root), lines.join("\n") + "\n");
}

describe("config.toml is read as TOML", () => {
  test("a list written over several lines is read whole", () => {
    project([
      "[permissions.autoMode]",
      "denyRules = [",
      '  "Bash(npm publish*)",',
      '  "Bash(git push*)",',
      "]",
    ]);
    expect(loadConfig(root).permissions.autoMode?.denyRules).toEqual([
      "Bash(npm publish*)",
      "Bash(git push*)",
    ]);
  });

  test("a # inside a quoted value belongs to the value", () => {
    project(["[telemetry]", 'endpoint = "http://localhost:8080/#/ingest" # local collector']);
    expect(loadConfig(root).telemetry.endpoint).toBe("http://localhost:8080/#/ingest");
  });

  test("a comma inside a quoted list item stays in the item", () => {
    project(["[permissions.autoMode]", `allow = ["Bash(git commit -m 'a, b')", "Read"]`]);
    expect(loadConfig(root).permissions.autoMode?.allow).toEqual([
      "Bash(git commit -m 'a, b')",
      "Read",
    ]);
  });

  test("a path Rune writes reads back as it was written", () => {
    const path = "C:\\Users\\me\\rune-logs";
    setConfigValue("engine.logDir", path, { scope: "project", workspaceRoot: root });
    expect(loadConfig(root).engine.logDir).toBe(path);
  });

  test("replacing a list written over several lines replaces all of it", () => {
    project([
      "[sandbox]",
      "excludedCommands = [",
      '  "docker",',
      '  "adb *", # device tools',
      "]",
      "networkDeny = true",
    ]);
    const res = setConfigValue("sandbox.excludedCommands", ["docker"], {
      scope: "project",
      workspaceRoot: root,
    });
    const text = readFileSync(getConfigFilePath("project", root), "utf8");
    expect(Bun.TOML.parse(text)).toEqual({
      sandbox: { excludedCommands: ["docker"], networkDeny: true },
    });
    expect(res.previousRaw).toContain('"adb *"');
  });

  test("a list that never closes does not license deleting what follows it", () => {
    project(["[sandbox]", "excludedCommands = [", '  "docker",', "[engine]", 'logDir = "logs"']);
    setConfigValue("sandbox.excludedCommands", ["adb *"], {
      scope: "project",
      workspaceRoot: root,
    });
    const text = readFileSync(getConfigFilePath("project", root), "utf8");
    expect(text).toContain('  "docker",');
    expect(text).toContain('[engine]\nlogDir = "logs"');
  });

  test("a file the parser refuses still applies what it can, and says so", () => {
    project(["[permissions]", 'mode = "a"', 'mode = "b"', "[research]", "maxRounds = 7"]);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      expect(loadConfig(root).research?.maxRounds).toBe(7);
    } finally {
      console.warn = warn;
    }
    const file = getConfigFilePath("project", root);
    expect(warnings.some((w) => w.includes(file) && w.includes("not valid TOML"))).toBe(true);
  });
});
