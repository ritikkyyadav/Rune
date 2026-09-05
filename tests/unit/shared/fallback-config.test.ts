/**
 * `[fallback] order` end to end: config.toml → loadConfig → normalize → gateway.
 *
 * A knob that parses but never reaches the thing it configures is worse than no
 * knob, because the user believes it took effect. This walks the whole path
 * with a real file, so a change to the TOML parser, the default-config merge,
 * or the normalizer cannot quietly disconnect it.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../packages/shared/src/config";
import {
  normalizeFallbackOrder,
  normalizeQuotaPolicy,
} from "../../../packages/shared/src/providers";

const dirs: string[] = [];
function configWith(toml: string) {
  const dir = mkdtempSync(join(tmpdir(), "rune-fallback-cfg-"));
  dirs.push(dir);
  const path = join(dir, "config.toml");
  writeFileSync(path, toml);
  process.env.RUNE_CONFIG_PATH = path;
  return loadConfig();
}

afterEach(() => {
  delete process.env.RUNE_CONFIG_PATH;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("[fallback] order reaches the gateway", () => {
  test("a written order survives parsing and normalization", () => {
    const config = configWith(`
[fallback]
order = ["anthropic", "codex"]
`);
    expect(config.fallback?.order).toEqual(["anthropic", "codex"]);
    expect(normalizeFallbackOrder(config.fallback?.order).order).toEqual(["anthropic", "codex"]);
  });

  test("the section is optional — absent config yields no order, not a crash", () => {
    const config = configWith(`
[llm]
`);
    expect(config.fallback?.order).toBeUndefined();
    expect(normalizeFallbackOrder(config.fallback?.order).order).toEqual([]);
  });

  test("a typo'd provider is reported, and the rest of the list still applies", () => {
    const config = configWith(`
[fallback]
order = ["anthropik", "codex"]
`);
    const r = normalizeFallbackOrder(config.fallback?.order);
    expect(r.order).toEqual(["codex"]);
    expect(r.unknown).toEqual(["anthropik"]);
  });

  test("an empty list is honored as 'no preference', not as an error", () => {
    const config = configWith(`
[fallback]
order = []
`);
    expect(normalizeFallbackOrder(config.fallback?.order).order).toEqual([]);
  });

  test("other config sections are unaffected by the new one", () => {
    // The section is additive: a config carrying both must keep both.
    const config = configWith(`
[reliability]
maxConsecutiveErrors = 5

[fallback]
order = ["google"]
`);
    expect(config.reliability?.maxConsecutiveErrors).toBe(5);
    expect(config.fallback?.order).toEqual(["google"]);
  });
});

describe("[fallback] onQuotaExceeded", () => {
  test("a written policy survives parsing", () => {
    const config = configWith(`
[fallback]
onQuotaExceeded = "degrade"
`);
    expect(normalizeQuotaPolicy(config.fallback?.onQuotaExceeded)).toBe("degrade");
  });

  test("absent means stop — the safe direction", () => {
    // Stopping when the user meant degrade costs one message and a /model
    // switch. Degrading when they meant stop costs a long task finished, and
    // reported, by a model they did not choose.
    const config = configWith(`
[llm]
`);
    expect(normalizeQuotaPolicy(config.fallback?.onQuotaExceeded)).toBe("stop");
  });

  test("a typo falls to stop rather than silently degrading", () => {
    const config = configWith(`
[fallback]
onQuotaExceeded = "degrede"
`);
    expect(normalizeQuotaPolicy(config.fallback?.onQuotaExceeded)).toBe("stop");
  });

  test("order and onQuotaExceeded coexist in one section", () => {
    const config = configWith(`
[fallback]
order = ["google"]
onQuotaExceeded = "degrade"
`);
    expect(normalizeFallbackOrder(config.fallback?.order).order).toEqual(["google"]);
    expect(normalizeQuotaPolicy(config.fallback?.onQuotaExceeded)).toBe("degrade");
  });
});
