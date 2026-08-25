import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setConfigValue, getConfigFilePath, loadConfig } from "../../../packages/shared/src/config";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gear-config-"));
  mkdirSync(join(root, ".gear"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function projectPath(): string {
  return getConfigFilePath("project", root);
}

function read(): string {
  return readFileSync(projectPath(), "utf-8");
}

describe("setConfigValue", () => {
  it("creates the file, section, and key when nothing exists", () => {
    const res = setConfigValue("permissions.mode", "hands-free", {
      scope: "project",
      workspaceRoot: root,
    });
    expect(res.created).toBe(true);
    expect(read()).toContain("[permissions]");
    expect(read()).toContain('mode = "hands-free"');
  });

  it("replaces an existing key in place and reports the previous value", () => {
    writeFileSync(
      projectPath(),
      ["# my config", "[permissions]", 'mode = "confirm"', "trustWorkspace = false", ""].join("\n"),
    );
    const res = setConfigValue("permissions.mode", "auto", {
      scope: "project",
      workspaceRoot: root,
    });
    expect(res.created).toBe(false);
    expect(res.previousRaw).toBe('"confirm"');
    const out = read();
    expect(out).toContain('mode = "auto"');
    expect(out).not.toContain('mode = "confirm"');
    // Untouched lines survive verbatim.
    expect(out).toContain("# my config");
    expect(out).toContain("trustWorkspace = false");
  });

  it("adds a key to an existing section without disturbing other keys/comments", () => {
    writeFileSync(
      projectPath(),
      ["[sandbox]", "# keep me", "enabled = true", "", "[llm]", 'defaultProvider = "google"'].join(
        "\n",
      ),
    );
    setConfigValue("sandbox.networkDeny", false, { scope: "project", workspaceRoot: root });
    const out = read();
    expect(out).toContain("networkDeny = false");
    expect(out).toContain("# keep me");
    expect(out).toContain("enabled = true");
    expect(out).toContain('defaultProvider = "google"');
    // The new key lands inside [sandbox], before [llm].
    expect(out.indexOf("networkDeny")).toBeLessThan(out.indexOf("[llm]"));
    expect(out.indexOf("networkDeny")).toBeGreaterThan(out.indexOf("[sandbox]"));
  });

  it("appends a new section when the section is absent", () => {
    writeFileSync(projectPath(), ["[llm]", 'defaultProvider = "google"', ""].join("\n"));
    setConfigValue("git.autoCommit", true, { scope: "project", workspaceRoot: root });
    const out = read();
    expect(out).toContain("[git]");
    expect(out).toContain("autoCommit = true");
    expect(out).toContain('defaultProvider = "google"'); // original intact
  });

  it("supports dotted (nested) section paths", () => {
    setConfigValue("llm.planner.model", "gpt-5", { scope: "project", workspaceRoot: root });
    const out = read();
    expect(out).toContain("[llm.planner]");
    expect(out).toContain('model = "gpt-5"');
  });

  it("loads classifier-backed Auto mode policy from a nested TOML section", () => {
    writeFileSync(
      projectPath(),
      [
        "[permissions]",
        'mode = "auto"',
        "",
        "[permissions.autoMode]",
        'classifierProvider = "anthropic"',
        'classifierModel = "reviewer-model"',
        "failClosed = true",
        'askRules = ["bash(git push *)"]',
        'environment = ["Internal GitHub org: example-inc."]',
        "",
      ].join("\n"),
    );

    const cfg = loadConfig(root);
    expect(cfg.permissions.mode).toBe("auto");
    expect(cfg.permissions.autoMode?.classifierProvider).toBe("anthropic");
    expect(cfg.permissions.autoMode?.classifierModel).toBe("reviewer-model");
    expect(cfg.permissions.autoMode?.failClosed).toBe(true);
    expect(cfg.permissions.autoMode?.askRules).toEqual(["bash(git push *)"]);
    expect(cfg.permissions.autoMode?.environment).toEqual(["Internal GitHub org: example-inc."]);
  });

  it("writes each value type as valid TOML that loadConfig reads back", () => {
    setConfigValue("permissions.mode", "hands-free", { scope: "project", workspaceRoot: root });
    setConfigValue("sandbox.enabled", false, { scope: "project", workspaceRoot: root });
    setConfigValue("engine.maxSessions", 12, { scope: "project", workspaceRoot: root });
    const cfg = loadConfig(root);
    expect(cfg.permissions.mode).toBe("hands-free");
    expect(cfg.sandbox.enabled).toBe(false);
    expect(cfg.engine.maxSessions).toBe(12);
  });

  it("round-trips a normal string value through loadConfig", () => {
    setConfigValue("ui.theme", "savoir-dark", { scope: "project", workspaceRoot: root });
    expect(loadConfig(root).ui?.theme).toBe("savoir-dark");
  });

  it("escapes embedded quotes so the file stays valid TOML (no corruption)", () => {
    setConfigValue("ui.theme", 'a"b', { scope: "project", workspaceRoot: root });
    // The written line is a single well-formed quoted value, not a broken one.
    expect(read()).toContain('theme = "a\\"b"');
    // And loadConfig treats it as one value (never throws / splits the file).
    expect(() => loadConfig(root)).not.toThrow();
  });

  it("is idempotent — setting the same value twice is a no-op replace", () => {
    setConfigValue("permissions.mode", "auto", { scope: "project", workspaceRoot: root });
    const first = read();
    setConfigValue("permissions.mode", "auto", { scope: "project", workspaceRoot: root });
    expect(read()).toBe(first);
  });

  it("rejects a bare (section-less) key", () => {
    expect(() =>
      setConfigValue("mode", "auto", { scope: "project", workspaceRoot: root }),
    ).toThrow();
  });
});
