import { describe, expect, test } from "bun:test";

import {
  CLAUDE_CODE_SAFE_MODE_MIN_VERSION,
  CLAUDE_DEFAULT_AUTH_ENV,
  CLAUDE_PARITY_CONFIG_ENV,
  claudeCodeArm,
  supportsClaudeSafeMode,
} from "../../eval/comparison/arms/claude-code";

const task = { id: "fixture", prompt: "Fix the fixture" };
const directory = "/evidence/claude";
const limits = { timeoutMs: 1000, model: "sonnet", reasoningEffort: "medium" };

describe("Claude product default-auth opt-in", () => {
  test("normal auth requires an explicit opt-in and adds safe mode", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/founder",
      CLAUDE_CONFIG_DIR: "/home/founder/custom",
      ANTHROPIC_API_KEY: "synthetic-api-key",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth-token",
      [CLAUDE_DEFAULT_AUTH_ENV]: "1",
    };
    const plan = claudeCodeArm.plan(task, directory, { ...limits, env });
    expect(plan.refusal).toBeUndefined();
    expect(plan.command).toContain("--safe-mode");
    expect(plan.command).toContain("--setting-sources");
    expect(plan.command).toContain("--strict-mcp-config");
    expect(plan.command).toContain("--no-session-persistence");
    expect(plan.env).toEqual({ PATH: "/usr/bin", HOME: "/home/founder" });
    expect(
      plan.parityGaps.some((gap) => gap.includes("normal Claude login under --safe-mode")),
    ).toBe(true);
    expect(CLAUDE_CODE_SAFE_MODE_MIN_VERSION).toBe("2.1.291");
  });

  test("unset or non-1 opt-in still refuses without a dedicated profile", () => {
    for (const choice of [undefined, "true", "0"]) {
      const plan = claudeCodeArm.plan(task, directory, {
        ...limits,
        env: { PATH: "/usr/bin", ...(choice ? { [CLAUDE_DEFAULT_AUTH_ENV]: choice } : {}) },
      });
      expect(plan.refusal).toContain(CLAUDE_PARITY_CONFIG_ENV);
      expect(plan.command).not.toContain("--safe-mode");
    }
  });

  test("an explicit dedicated profile takes precedence, including when invalid", () => {
    const env = {
      PATH: "/usr/bin",
      [CLAUDE_DEFAULT_AUTH_ENV]: "1",
      [CLAUDE_PARITY_CONFIG_ENV]: "/",
      CLAUDE_CONFIG_DIR: "/home/founder/custom",
      ANTHROPIC_API_KEY: "synthetic-api-key",
    };
    const dedicated = claudeCodeArm.plan(task, directory, { ...limits, env });
    expect(dedicated.refusal).toBeUndefined();
    expect(dedicated.env.CLAUDE_CONFIG_DIR).toBe("/");
    expect(dedicated.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(dedicated.command).not.toContain("--safe-mode");
    expect(dedicated.parityGaps.some((gap) => gap.includes("dedicated CLAUDE_CONFIG_DIR"))).toBe(
      true,
    );

    const invalid = claudeCodeArm.plan(task, directory, {
      ...limits,
      env: { ...env, [CLAUDE_PARITY_CONFIG_ENV]: "relative-profile" },
    });
    expect(invalid.refusal).toContain("absolute path");
    expect(invalid.command).not.toContain("--safe-mode");
  });

  test("the opt-in does not change harness API auth", () => {
    const plan = claudeCodeArm.plan(task, directory, {
      ...limits,
      mode: "harness",
      env: { [CLAUDE_DEFAULT_AUTH_ENV]: "1", ANTHROPIC_API_KEY: "synthetic-api-key" },
    });
    expect(plan.command).toContain("--bare");
    expect(plan.command).not.toContain("--safe-mode");
    expect(plan.env.ANTHROPIC_API_KEY).toBe("synthetic-api-key");
  });

  test("safe mode has a documented minimum CLI version", () => {
    expect(supportsClaudeSafeMode("2.1.284 (Claude Code)")).toBe(false);
    expect(supportsClaudeSafeMode("2.1.291 (Claude Code)")).toBe(true);
    expect(supportsClaudeSafeMode("2.2.0 (Claude Code)")).toBe(true);
    expect(supportsClaudeSafeMode(null)).toBe(false);
  });
});
