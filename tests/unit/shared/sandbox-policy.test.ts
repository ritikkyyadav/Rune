/**
 * The sandbox policy's pure helpers: mode spellings, the quote-aware segment
 * splitter, the excluded-command grammar, path expansion, the effective path
 * lists handed to rune-tools, and the startup precedence (flag > env > sidecar
 * > config > default) including the legacy `{ "enabled": false }` sidecar.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BUILTIN_WRITE_DENY,
  commandPatternMatches,
  effectiveSandboxPaths,
  expandSandboxPath,
  isExcludedCommand,
  mergeSandboxPolicy,
  normalizeSandboxMode,
  normalizeSandboxPolicyInput,
  splitShellSegments,
  DEFAULT_SANDBOX_POLICY,
} from "../../../packages/shared/src/sandbox-policy";
import {
  forgetSavedSandboxKey,
  loadSavedSandboxState,
  resolveInitialSandbox,
  resolveInitialSandboxPolicy,
  saveSandboxState,
} from "../../../packages/shared/src/sandbox-store";

describe("normalizeSandboxMode", () => {
  test("folds every spelling onto the three modes", () => {
    for (const on of ["on", "true", "auto-allow", "Auto Allow", "enabled", true]) {
      expect(normalizeSandboxMode(on)).toBe("auto-allow");
    }
    for (const reg of ["regular", "regular permissions", "prompt", "ask"]) {
      expect(normalizeSandboxMode(reg)).toBe("regular");
    }
    for (const off of ["off", "false", "disabled", "none", "no sandbox", false]) {
      expect(normalizeSandboxMode(off)).toBe("off");
    }
  });

  test("refuses the gear's name and garbage", () => {
    // "auto" is the classifier gear; reading it as a sandbox mode would be a
    // silent category error in config.
    expect(normalizeSandboxMode("auto")).toBeUndefined();
    expect(normalizeSandboxMode("banana")).toBeUndefined();
    expect(normalizeSandboxMode(42)).toBeUndefined();
  });
});

describe("splitShellSegments", () => {
  test("splits on the shell separators and keeps quoted text whole", () => {
    expect(splitShellSegments("cd x && npm install; ls | wc -l || true")).toEqual([
      "cd x",
      "npm install",
      "ls",
      "wc -l",
      "true",
    ]);
    expect(splitShellSegments(`echo "a; b && c" | cat`)).toEqual([`echo "a; b && c"`, "cat"]);
    expect(splitShellSegments("printf 'x|y'")).toEqual(["printf 'x|y'"]);
  });

  test("does not split inside a substitution or a subshell", () => {
    expect(splitShellSegments("echo $(ls; pwd) && true")).toEqual(["echo $(ls; pwd)", "true"]);
    expect(splitShellSegments("(cd a && make) | tee log")).toEqual(["(cd a && make)", "tee log"]);
  });

  test("newlines separate segments; empty pieces are dropped", () => {
    expect(splitShellSegments("ls\n\n  git status  \n")).toEqual(["ls", "git status"]);
    expect(splitShellSegments("   ")).toEqual([]);
  });
});

describe("excludedCommands grammar", () => {
  test("a bare name is a command prefix", () => {
    expect(commandPatternMatches("docker", "docker ps")).toBe(true);
    expect(commandPatternMatches("docker", "docker")).toBe(true);
    expect(commandPatternMatches("docker", "dockerd --debug")).toBe(false);
    expect(commandPatternMatches("adb devices", "adb devices -l")).toBe(true);
    expect(commandPatternMatches("adb devices", "adb shell ls")).toBe(false);
  });

  test("a glob covers the whole segment, case-insensitively", () => {
    expect(commandPatternMatches("adb *", "adb shell getprop")).toBe(true);
    expect(commandPatternMatches("adb *", "adb")).toBe(false);
    expect(commandPatternMatches("*gradlew*", "./gradlew assembleDebug")).toBe(true);
    expect(commandPatternMatches("Docker *", "docker compose up")).toBe(true);
  });

  test("leading VAR=value assignments do not hide the command", () => {
    expect(commandPatternMatches("adb *", "ANDROID_SERIAL=emulator-5554 adb shell ls")).toBe(true);
  });

  test("any matching segment excludes the whole command, and names the pattern", () => {
    expect(isExcludedCommand("cd app && adb install app.apk", ["adb *"])).toBe("adb *");
    expect(isExcludedCommand("ls && cat x", ["adb *"])).toBeUndefined();
    expect(isExcludedCommand("adb devices", [])).toBeUndefined();
  });
});

// An expanded policy path is absolute and wears the host's separator: the list
// crosses into Rust and is matched by the kernel, which knows one spelling of a
// path per platform. So the expectations are `resolve`d the same way the
// implementation resolves them — on Windows `/ws/.rune/hooks` is
// `D:\ws\.rune\hooks`, and asserting the POSIX literal would be asserting the
// wrong answer rather than catching a wrong one.
describe("paths", () => {
  test("expandSandboxPath resolves ~, $HOME, relative and absolute forms", () => {
    expect(expandSandboxPath("~/.gradle", "/ws")).toBe(join(homedir(), ".gradle"));
    expect(expandSandboxPath("$HOME/x", "/ws")).toBe(join(homedir(), "x"));
    expect(expandSandboxPath(".rune/hooks", "/ws")).toBe(resolve("/ws", ".rune/hooks"));
    expect(expandSandboxPath("/opt/cache", "/ws")).toBe(resolve("/opt/cache"));
  });

  test("effectiveSandboxPaths always carries the built-in write denials", () => {
    const paths = effectiveSandboxPaths(
      { filesystem: { denyRead: ["~/Private"], allowWrite: ["~/.gradle"], denyWrite: ["dist"] } },
      "/ws",
    );
    expect(paths.deny_read).toEqual([join(homedir(), "Private")]);
    expect(paths.allow_write).toEqual([join(homedir(), ".gradle")]);
    expect(paths.deny_write).toContain(resolve("/ws", ".rune/hooks"));
    expect(paths.deny_write).toContain(resolve("/ws", ".git/hooks"));
    expect(paths.deny_write).toContain(resolve("/ws", "dist"));
    expect(paths.deny_write.length).toBe(BUILTIN_WRITE_DENY.length + 1);
  });
});

describe("config normalization and merge", () => {
  test("reads the new keys and the legacy `enabled` boolean", () => {
    expect(normalizeSandboxPolicyInput({ enabled: false })).toEqual({ mode: "off" });
    expect(normalizeSandboxPolicyInput({ enabled: false, mode: "regular" }).mode).toBe("regular");
    const full = normalizeSandboxPolicyInput({
      mode: "auto-allow",
      allowUnsandboxedFallback: false,
      excludedCommands: ["adb *", 7, "  "],
      filesystem: { denyWrite: ["dist"] },
    });
    expect(full).toEqual({
      mode: "auto-allow",
      allowUnsandboxedFallback: false,
      excludedCommands: ["adb *"],
      filesystem: { denyRead: [], allowWrite: [], denyWrite: ["dist"] },
    });
    expect(normalizeSandboxPolicyInput("nope")).toEqual({});
  });

  test("merge patches only what the patch names and de-duplicates lists", () => {
    const merged = mergeSandboxPolicy(DEFAULT_SANDBOX_POLICY, {
      excludedCommands: ["a", "a", " b "],
    });
    expect(merged.mode).toBe("auto-allow");
    expect(merged.excludedCommands).toEqual(["a", "b"]);
    expect(merged.filesystem).toEqual({ denyRead: [], allowWrite: [], denyWrite: [] });
  });
});

describe("resolveInitialSandboxPolicy precedence", () => {
  test("flag > env > saved > configured > default, for the mode", () => {
    expect(
      resolveInitialSandboxPolicy({ flag: false, env: "true", saved: true, configured: true }).mode,
    ).toBe("off");
    // --sandbox re-enables without discarding a saved regular choice.
    expect(resolveInitialSandboxPolicy({ flag: true, saved: { mode: "regular" } }).mode).toBe(
      "regular",
    );
    expect(resolveInitialSandboxPolicy({ flag: true, saved: { mode: "off" } }).mode).toBe(
      "auto-allow",
    );
    expect(resolveInitialSandboxPolicy({ envMode: "regular", saved: { mode: "off" } }).mode).toBe(
      "regular",
    );
    expect(resolveInitialSandboxPolicy({ env: "false", saved: true, configured: true }).mode).toBe(
      "off",
    );
    expect(resolveInitialSandboxPolicy({ saved: false, configured: true }).mode).toBe("off");
    expect(resolveInitialSandboxPolicy({ configured: { mode: "regular" } }).mode).toBe("regular");
    expect(resolveInitialSandboxPolicy({}).mode).toBe("auto-allow");
    // The boolean view agrees.
    expect(resolveInitialSandbox({ configured: false })).toBe(false);
    expect(resolveInitialSandbox({})).toBe(true);
  });

  test("the override and the lists come from the sidecar and config", () => {
    const policy = resolveInitialSandboxPolicy({
      saved: { allowUnsandboxedFallback: false },
      configured: {
        excludedCommands: ["adb *"],
        allowUnsandboxedFallback: true,
        filesystem: { denyRead: ["~/Private"] },
      },
    });
    expect(policy.allowUnsandboxedFallback).toBe(false); // sidecar wins over config
    expect(policy.excludedCommands).toEqual(["adb *"]);
    expect(policy.filesystem.denyRead).toEqual(["~/Private"]);
  });
});

describe("sidecar", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("a legacy { enabled: false } file reads as mode off; saves merge; keys can be forgotten", () => {
    dir = mkdtempSync(join(tmpdir(), "rune-sandbox-sidecar-"));
    writeFileSync(join(dir, "sandbox.json"), JSON.stringify({ enabled: false }));
    expect(loadSavedSandboxState(dir)).toEqual({ mode: "off" });

    saveSandboxState({ allowUnsandboxedFallback: false }, dir);
    expect(loadSavedSandboxState(dir)).toEqual({ mode: "off", allowUnsandboxedFallback: false });
    saveSandboxState(true, dir);
    expect(loadSavedSandboxState(dir)).toEqual({
      mode: "auto-allow",
      allowUnsandboxedFallback: false,
    });
    expect(JSON.parse(readFileSync(join(dir, "sandbox.json"), "utf8")).enabled).toBeUndefined();

    forgetSavedSandboxKey("mode", dir);
    expect(loadSavedSandboxState(dir)).toEqual({ allowUnsandboxedFallback: false });
    forgetSavedSandboxKey("allowUnsandboxedFallback", dir);
    expect(loadSavedSandboxState(dir)).toBeNull();
  });
});
