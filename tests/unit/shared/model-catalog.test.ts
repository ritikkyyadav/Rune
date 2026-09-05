/**
 * P10.5 — the live-model cache.
 *
 * `rune models` asks the provider what it serves, because a hand-maintained
 * catalogue rots. That is a network call on a command people run to look at a
 * list, so it is cached for an hour. The tests here pin the two things a cache
 * has to get right — that a fresh entry is served and a stale one is not — and
 * the two things this one must never do: fail a command because the cache is
 * broken, and store anything account-specific.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedModelsAge,
  clearCachedModels,
  describeAge,
  loadCachedModels,
  MODEL_CACHE_TTL_MS,
  saveCachedModels,
} from "../../../packages/shared/src/model-catalog";

let path = "";
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "rune-model-cache-")), "model-cache.json");
});

const MODELS = [
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Claude Sonnet 4.5" },
  { id: "anthropic.claude-3-5-haiku-20241022-v1:0", label: "Claude 3.5 Haiku" },
];

describe("round trip", () => {
  test("a saved catalogue reads back", () => {
    saveCachedModels("bedrock", MODELS, { path });
    expect(loadCachedModels("bedrock", { path })).toEqual(MODELS);
  });

  test("providers do not see each other's entries", () => {
    saveCachedModels("bedrock", MODELS, { path });
    expect(loadCachedModels("vertex", { path })).toBeNull();
  });

  test("a re-save replaces rather than merges", () => {
    saveCachedModels("bedrock", MODELS, { path });
    saveCachedModels("bedrock", [{ id: "only-this" }], { path });
    expect(loadCachedModels("bedrock", { path })).toEqual([{ id: "only-this" }]);
  });
});

describe("freshness", () => {
  test("an entry inside the TTL is served", () => {
    const now = 1_800_000_000_000;
    saveCachedModels("bedrock", MODELS, { path, now });
    expect(loadCachedModels("bedrock", { path, now: now + MODEL_CACHE_TTL_MS - 1 })).toEqual(
      MODELS,
    );
  });

  test("an entry past the TTL is not", () => {
    const now = 1_800_000_000_000;
    saveCachedModels("bedrock", MODELS, { path, now });
    expect(loadCachedModels("bedrock", { path, now: now + MODEL_CACHE_TTL_MS + 1 })).toBeNull();
  });

  test("the TTL is an hour", () => {
    // Chosen against the failure it protects: catalogues change on the order of
    // weeks, so a stale row costs one confusing pick that the next refresh
    // fixes, while an uncached list costs a round trip every invocation.
    expect(MODEL_CACHE_TTL_MS).toBe(3_600_000);
  });

  test("age is reported for the status line", () => {
    const now = 1_800_000_000_000;
    saveCachedModels("bedrock", MODELS, { path, now });
    expect(cachedModelsAge("bedrock", { path, now: now + 180_000 })).toBe(180_000);
    expect(cachedModelsAge("nothing-here", { path })).toBeNull();
  });
});

describe("clearing", () => {
  test("one provider", () => {
    saveCachedModels("bedrock", MODELS, { path });
    saveCachedModels("vertex", [{ id: "gemini-2.5-flash" }], { path });
    clearCachedModels("bedrock", { path });
    expect(loadCachedModels("bedrock", { path })).toBeNull();
    expect(loadCachedModels("vertex", { path })).not.toBeNull();
  });

  test("all of them", () => {
    saveCachedModels("bedrock", MODELS, { path });
    clearCachedModels(undefined, { path });
    expect(loadCachedModels("bedrock", { path })).toBeNull();
  });
});

describe("a broken cache never breaks the command", () => {
  test("a corrupt file reads as empty", () => {
    writeFileSync(path, "{ not json at all");
    expect(loadCachedModels("bedrock", { path })).toBeNull();
  });

  test("a file from a future version reads as empty", () => {
    writeFileSync(path, JSON.stringify({ version: 99, providers: { bedrock: {} } }));
    expect(loadCachedModels("bedrock", { path })).toBeNull();
  });

  test("an empty catalogue is treated as no catalogue", () => {
    // A provider that answered with nothing must fall through to the curated
    // list, not show an empty picker.
    saveCachedModels("bedrock", [], { path });
    expect(loadCachedModels("bedrock", { path })).toBeNull();
  });

  test("an unwritable location is swallowed", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-ro-"));
    chmodSync(dir, 0o500);
    expect(() => saveCachedModels("bedrock", MODELS, { path: join(dir, "x.json") })).not.toThrow();
    chmodSync(dir, 0o700);
  });

  test("a missing file reads as empty", () => {
    expect(existsSync(path)).toBe(false);
    expect(loadCachedModels("bedrock", { path })).toBeNull();
  });
});

describe("what the cache holds", () => {
  test("ids and labels only — no credential, no endpoint", () => {
    saveCachedModels("bedrock", MODELS, { path });
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as {
      providers: Record<string, { fetchedAt: number; models: Record<string, unknown>[] }>;
    };
    for (const model of parsed.providers.bedrock!.models) {
      expect(Object.keys(model).sort()).toEqual(["id", "label"]);
    }
    expect(raw).not.toContain("key");
    expect(raw).not.toContain("token");
  });

  test("a model with no label stores no empty one", () => {
    saveCachedModels("ollama", [{ id: "llama3.1" }], { path });
    expect(loadCachedModels("ollama", { path })).toEqual([{ id: "llama3.1" }]);
  });
});

describe("describeAge", () => {
  test("reads as a person would say it", () => {
    expect(describeAge(5_000)).toBe("just now");
    expect(describeAge(60_000)).toBe("1 minute ago");
    expect(describeAge(15 * 60_000)).toBe("15 minutes ago");
    expect(describeAge(60 * 60_000)).toBe("1 hour ago");
    expect(describeAge(3 * 60 * 60_000)).toBe("3 hours ago");
  });
});
