/**
 * What a comparator arm's process environment actually contains.
 *
 * `armEnv` used to be a DENY-list over eight credential-shaped suffixes plus
 * the AWS/GCP chain, and the lane's own report described it as "the caller's
 * environment minus every credential-shaped name that is not one of those
 * three". The v7 verification pass drove a hostile shell through it and both
 * arms received:
 *
 *   ANTHROPIC_BASE_URL / OPENAI_BASE_URL   the arm talks to any host, and the
 *       fixture and the prompt go with it — the measurement stops measuring
 *       the vendor it names;
 *   ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL   the recorded `model` is not
 *       what ran;
 *   CLAUDE_CODE_USE_BEDROCK   a different auth path entirely;
 *   HTTP_PROXY / HTTPS_PROXY   every request rerouted;
 *   NODE_OPTIONS=--require /tmp/pwned.js   arbitrary code into a Node CLI.
 *
 * None of those ends in a secret suffix. A deny-list over a namespace nobody
 * controls is a list plus an omission, so the scrub is an ALLOW-list now: a
 * named neutral base, plus the names the arm declares as its own auth.
 */

import { describe, expect, test } from "bun:test";

import {
  CLAUDE_CODE_AUTH_VARS,
  CLAUDE_CODE_ENV,
  claudeCodeEnv,
  harnessConfigDir,
} from "../../eval/comparison/arms/claude-code";
import { CODEX_AUTH_VARS } from "../../eval/comparison/arms/codex";
import { armEnv, neutralEnvName } from "../../eval/comparison/arms/types";

/** A founder's shell as it might plausibly be, plus everything hostile. */
const HOSTILE: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/x",
  TMPDIR: "/tmp",
  TERM: "xterm-256color",
  LANG: "en_GB.UTF-8",
  LC_ALL: "en_GB.UTF-8",
  ANTHROPIC_API_KEY: "sk-synthetic",
  OPENAI_API_KEY: "sk-openai-synthetic",
  ANTHROPIC_BASE_URL: "https://evil.example/v1",
  OPENAI_BASE_URL: "https://evil.example/v1",
  ANTHROPIC_BEDROCK_BASE_URL: "https://evil.example/v1",
  OPENAI_ORG_ID: "org-evil",
  HTTP_PROXY: "http://evil.example:8080",
  HTTPS_PROXY: "http://evil.example:8080",
  ALL_PROXY: "socks5://evil.example:1080",
  NO_PROXY: "",
  NODE_OPTIONS: "--require /tmp/pwned.js",
  BUN_INSPECT: "ws://evil.example",
  ANTHROPIC_MODEL: "claude-haiku-cheap",
  ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-cheap",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  RUNE_HOME: "/evidence/profile",
  LD_PRELOAD: "/tmp/pwned.so",
  DYLD_INSERT_LIBRARIES: "/tmp/pwned.dylib",
};

describe("the comparator arm environment is an allow-list", () => {
  const claude = armEnv(CLAUDE_CODE_AUTH_VARS, HOSTILE);
  const codex = armEnv(CODEX_AUTH_VARS, HOSTILE);

  test("a *_BASE_URL cannot point the arm at another host", () => {
    for (const env of [claude, codex]) {
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.OPENAI_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
    }
  });

  test("a model or auth-path override cannot change what was measured", () => {
    for (const env of [claude, codex]) {
      expect(env.ANTHROPIC_MODEL).toBeUndefined();
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    }
  });

  test("NODE_OPTIONS, the loaders and the proxies do not reach a Node CLI", () => {
    for (const env of [claude, codex]) {
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.BUN_INSPECT).toBeUndefined();
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(env.HTTP_PROXY).toBeUndefined();
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.ALL_PROXY).toBeUndefined();
    }
  });

  test("the other vendor's config and key stay with the other vendor", () => {
    expect(claude.OPENAI_ORG_ID).toBeUndefined();
    expect(claude.OPENAI_API_KEY).toBeUndefined();
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("Rune's own configuration never reaches the measuring instrument", () => {
    for (const env of [claude, codex]) expect(env.RUNE_HOME).toBeUndefined();
  });

  test("the whole environment is the neutral base plus the arm's own auth", () => {
    // Stated as an equality, not a list of absences: a variable added to the
    // hostile shell above has to be named here to survive, which is the
    // property a deny-list could not have.
    expect(Object.keys(claude).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TERM",
      "TMPDIR",
    ]);
    expect(Object.keys(codex).sort()).toEqual([
      "HOME",
      "LANG",
      "LC_ALL",
      "OPENAI_API_KEY",
      "PATH",
      "TERM",
      "TMPDIR",
    ]);
  });

  test("an arm's own auth location is named by the arm, not inherited by luck", () => {
    // CODEX_HOME does not end in a secret suffix, so the deny-list passed it
    // through by accident. The allow-list would have dropped it and sent a
    // founder with a relocated Codex profile to an unauthenticated ~/.codex,
    // so the Codex arm names it.
    expect(CODEX_AUTH_VARS).toContain("CODEX_HOME");
    expect(
      armEnv(CODEX_AUTH_VARS, { ...HOSTILE, CODEX_HOME: "/home/x/.codex-alt" }).CODEX_HOME,
    ).toBe("/home/x/.codex-alt");
    // And it is the arm's, not everyone's.
    expect(
      armEnv(CLAUDE_CODE_AUTH_VARS, { CODEX_HOME: "/home/x/.codex-alt" }).CODEX_HOME,
    ).toBeUndefined();
  });

  test("Claude Code's product mode keeps no key at all; only harness mode keeps one", () => {
    // `CLAUDE_CODE_AUTH_VARS` is the union of the two modes, for a reader. What
    // a PLAN hands the child is per mode, and product mode's only addition is
    // the evaluation profile — SET from RUNE_PARITY_CLAUDE_CONFIG_DIR, never
    // inherited. A key in the founder's shell would turn a plan run into an
    // API-billed one without a word.
    const env = {
      ...HOSTILE,
      RUNE_PARITY_CLAUDE_CONFIG_DIR: "/",
      CLAUDE_CONFIG_DIR: "/home/x/.claude",
    };
    const product = claudeCodeEnv({}, "/evidence/run", { timeoutMs: 1, env }).env;
    expect(product.ANTHROPIC_API_KEY).toBeUndefined();
    expect(product.CLAUDE_CONFIG_DIR).toBe("/");
    expect(Object.keys(product).sort()).toEqual([
      "CLAUDE_CONFIG_DIR",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TERM",
      "TMPDIR",
    ]);
    const harness = claudeCodeEnv({}, "/evidence/run", { timeoutMs: 1, env, mode: "harness" }).env;
    expect(harness.ANTHROPIC_API_KEY).toBe("sk-synthetic");
    expect(harness.CLAUDE_CONFIG_DIR).toBe(harnessConfigDir("/evidence/run"));
    for (const mode of [product, harness]) {
      expect(mode.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(mode.NODE_OPTIONS).toBeUndefined();
      expect(mode.RUNE_PARITY_CLAUDE_CONFIG_DIR).toBeUndefined();
    }
    expect(CLAUDE_CODE_ENV.product).not.toContain("ANTHROPIC_API_KEY");
  });

  test("the neutral base is locale, terminal and paths — nothing that steers a request", () => {
    for (const name of ["PATH", "HOME", "TMPDIR", "TERM", "LANG", "LC_CTYPE", "LC_ALL"])
      expect(neutralEnvName(name)).toBe(true);
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "NODE_OPTIONS",
      "HTTP_PROXY",
      "ANTHROPIC_API_KEY",
      "CODEX_HOME",
      "RUNE_HOME",
    ])
      expect(neutralEnvName(name)).toBe(false);
  });
});
