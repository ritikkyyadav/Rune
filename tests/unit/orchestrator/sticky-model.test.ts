/**
 * The model you last used IS the model you get.
 *
 * The bug: pick GPT-5.6 on a ChatGPT/Codex account, quit, reopen — and the
 * session comes up on google/gemini-2.5-flash. `~/.gear/model.json` was written
 * correctly the whole time; the STARTUP GATE threw it away, in two places, for
 * two separate reasons:
 *
 *   1. `isCliProvider` was a hand-written list of seven ids (five, in
 *      engine-host) that was never updated when the subscription providers were
 *      added. `codex` is not in it, so the sticky pick failed the gate.
 *   2. `hasCreds` knew env vars, `[llm.*].apiKey` and the legacy secrets file —
 *      none of which a subscription provider uses. A Codex account is an OAuth
 *      blob in the credential store, so "do you have credentials?" answered no
 *      even when signed in.
 *
 * Both had to be true to restore a model, so both had to be wrong to lose it,
 * and either one alone was enough. The gate now asks the provider registry and
 * the credential store, so adding a provider cannot break stickiness again.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasStoredCredential,
  getPreset,
  CUSTOM_PROVIDER_ID,
} from "../../../packages/shared/src/index";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gear-sticky-"));
  mkdirSync(join(dir, ".gear"), { recursive: true });
  env = { GEAR_CREDENTIAL_INDEX_PATH: join(dir, "index.json") } as NodeJS.ProcessEnv;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeIndex = (accounts: string[]) =>
  writeFileSync(join(dir, "index.json"), JSON.stringify({ accounts }));

describe("credentials a subscription provider actually uses", () => {
  test("an OAuth session counts as having credentials", () => {
    // This is the exact shape in a real ~/.gear/credentials.index.json after
    // signing in to ChatGPT.
    writeIndex(["provider:codex:oauth", "provider:openrouter"]);
    expect(hasStoredCredential("codex", env)).toBe(true);
  });

  test("a saved API key counts too", () => {
    writeIndex(["provider:openrouter"]);
    expect(hasStoredCredential("openrouter", env)).toBe(true);
  });

  test("a provider with nothing stored does not", () => {
    writeIndex(["provider:codex:oauth"]);
    expect(hasStoredCredential("anthropic", env)).toBe(false);
  });

  test("a missing index is a clean no, never a throw", () => {
    expect(
      hasStoredCredential("codex", { GEAR_CREDENTIAL_INDEX_PATH: "/nope/x.json" } as any),
    ).toBe(false);
  });

  test("prefix collisions do not grant credentials to a sibling provider", () => {
    // "provider:openrouter" must not answer for "openrouter-alt".
    writeIndex(["provider:openrouter"]);
    expect(hasStoredCredential("openrouter-alt", env)).toBe(false);
  });
});

describe("the gate the sticky model has to pass", () => {
  // Mirrors the predicate both entry points now use. `custom` is checked
  // FIRST because it deliberately has no preset: it is the escape hatch for a
  // provider the catalogue does not know, so the preset gate would reject it
  // forever. It is usable exactly when the gateway would register it.
  const stickyUsable = (
    p: string,
    e: NodeJS.ProcessEnv,
    custom?: { baseUrl?: string; key?: string },
  ) =>
    p === CUSTOM_PROVIDER_ID
      ? !!(custom?.baseUrl && custom?.key)
      : getPreset(p) !== undefined && (p === "ollama" || hasStoredCredential(p, e));

  test("a signed-in Codex account passes — the case that was broken", () => {
    writeIndex(["provider:codex:oauth"]);
    expect(stickyUsable("codex", env)).toBe(true);
  });

  test("every provider in the registry is eligible, not a hardcoded seven", () => {
    // The original defect was a list that rotted. Anything with a preset and a
    // credential must qualify — including the ones added after that list was
    // written.
    for (const id of ["codex", "groq", "xai", "deepseek"]) {
      writeIndex([`provider:${id}:oauth`]);
      expect({ id, ok: stickyUsable(id, env) }).toEqual({ id, ok: true });
    }
  });

  test("local runtimes need no credential at all", () => {
    writeIndex([]);
    expect(stickyUsable("ollama", env)).toBe(true);
    expect(stickyUsable("ollama", env)).toBe(true);
  });

  test("an unknown provider id never passes", () => {
    writeIndex(["provider:madeup:oauth"]);
    expect(stickyUsable("madeup", env)).toBe(false);
  });

  test("a real provider with no credentials falls through rather than booting keyless", () => {
    writeIndex([]);
    expect(stickyUsable("anthropic", env)).toBe(false);
  });

  // P8.6 removed the `lmstudio` preset and told people to reach a local
  // OpenAI-compatible server through `/keys custom …` instead. `/model`
  // accepts `custom`, but the startup gate threw it away on the preset check,
  // so the replacement path was reachable and never kept: pick it, restart,
  // and the session came up on the auto-detected provider again.
  test("a configured custom endpoint survives a restart", () => {
    writeIndex([]);
    expect(
      stickyUsable(CUSTOM_PROVIDER_ID, env, {
        baseUrl: "http://localhost:1234/v1",
        key: "lm-studio",
      }),
    ).toBe(true);
  });

  test("an unconfigured custom endpoint does not — half a config is not a provider", () => {
    writeIndex([]);
    expect(stickyUsable(CUSTOM_PROVIDER_ID, env, undefined)).toBe(false);
    expect(stickyUsable(CUSTOM_PROVIDER_ID, env, { baseUrl: "http://localhost:1234/v1" })).toBe(
      false,
    );
    expect(stickyUsable(CUSTOM_PROVIDER_ID, env, { key: "lm-studio" })).toBe(false);
  });
});
