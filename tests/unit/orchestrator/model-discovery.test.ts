/**
 * `/model` shows what a signed-in cloud account serves, not only what
 * providers.ts was told on the day it was last edited.
 *
 * discoverModels is the bounded, never-throwing fetch; mergeDiscovered is the
 * rule for folding a live catalogue into the curated seed. Together they are
 * why a release newer than the preset (GPT-6 Sol on 2026-09-22) appears in the
 * picker without a code change.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModels } from "../../../packages/orchestrator/src/model-discovery";
import {
  DISCOVERED_EXTRA_CAP,
  mergeDiscovered,
} from "../../../packages/orchestrator/src/bin/ui/model-picker";
import { loadCachedModels, saveCachedModels } from "../../../packages/shared/src/model-catalog";
import type { ModelInfo } from "../../../packages/llm-gateway/src/types";

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-discovery-"));
  cachePath = join(dir, "model-cache.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const listing = (models: ModelInfo[]) => ({ listModels: async () => models });

describe("discoverModels", () => {
  test("asks the provider, returns ids and labels, and fills the cache", async () => {
    const out = await discoverModels(
      "codex",
      listing([
        { id: "gpt-6-sol", label: "GPT-6 Sol", live: true, contextLimit: 1_050_000 },
        { id: "gpt-6-luna", live: true },
      ]),
      { cachePath },
    );
    expect(out).toEqual([{ id: "gpt-6-sol", label: "GPT-6 Sol" }, { id: "gpt-6-luna" }]);
    expect(loadCachedModels("codex", { path: cachePath })).toEqual(out);
  });

  test("an hour-fresh cache is served without asking", async () => {
    saveCachedModels("openai", [{ id: "gpt-6-sol" }], { path: cachePath });
    let asked = false;
    const out = await discoverModels(
      "openai",
      {
        listModels: async () => {
          asked = true;
          return [];
        },
      },
      { cachePath },
    );
    expect(out).toEqual([{ id: "gpt-6-sol" }]);
    expect(asked).toBe(false);
  });

  test("a stale cache is asked again", async () => {
    const hourAndABitAgo = Date.now() - 61 * 60_000;
    saveCachedModels("openai", [{ id: "gpt-5.6-sol" }], { path: cachePath, now: hourAndABitAgo });
    const out = await discoverModels("openai", listing([{ id: "gpt-6-sol" }]), { cachePath });
    expect(out).toEqual([{ id: "gpt-6-sol" }]);
  });

  test("a failed listing is null — the picker shows the seed, never an error", async () => {
    const out = await discoverModels(
      "codex",
      {
        listModels: async () => {
          throw new Error("401 Unauthorized");
        },
      },
      { cachePath },
    );
    expect(out).toBeNull();
  });

  test("an empty listing, or no listing method at all, is null", async () => {
    expect(await discoverModels("x", listing([]), { cachePath })).toBeNull();
    expect(await discoverModels("x", {}, { cachePath })).toBeNull();
    expect(await discoverModels("x", undefined, { cachePath })).toBeNull();
  });

  test("a slow listing times out to null, but still fills the cache for next time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      listModels: async () => {
        await gate;
        return [{ id: "gpt-6-sol" }] as ModelInfo[];
      },
    };
    const started = Date.now();
    expect(await discoverModels("codex", slow, { cachePath, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);

    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(loadCachedModels("codex", { path: cachePath })).toEqual([{ id: "gpt-6-sol" }]);
  });
});

describe("mergeDiscovered", () => {
  const SEED = [
    { id: "gpt-6-astra", label: "GPT-6 Astra (flagship)" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ];

  test("no catalogue leaves the seed exactly as curated", () => {
    expect(mergeDiscovered(SEED, [])).toEqual(SEED);
  });

  test("a model the seed has never heard of appears beneath it", () => {
    const out = mergeDiscovered(SEED, [
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
      { id: "gpt-6-sol", label: "GPT-6 Sol" },
    ]);
    expect(out).toEqual([...SEED, { id: "gpt-6-sol", label: "GPT-6 Sol" }]);
  });

  test("a seed row the listing omits is KEPT — listings speak snapshots, seeds speak aliases", () => {
    // Anthropic lists claude-haiku-4-5-20251001 and never the alias. Dropping
    // unlisted seed rows would hide a model that works.
    const out = mergeDiscovered(SEED, [{ id: "claude-haiku-4-5-20251001" }]);
    expect(out.map((m) => m.id)).toEqual(["gpt-6-astra", "claude-haiku-4-5"]);
  });

  test("dated snapshots of a seed alias fold into it, in either date spelling", () => {
    const out = mergeDiscovered(SEED, [
      { id: "claude-haiku-4-5-20251001" },
      { id: "gpt-6-astra-2026-09-01" },
    ]);
    expect(out).toEqual(SEED);
  });

  test("non-text models are skipped, text ones with similar words are not", () => {
    const out = mergeDiscovered(
      [],
      [
        { id: "gemini-3.8-flash-tts" },
        { id: "gemini-3.1-flash-image" },
        { id: "gemini-3.8-live" },
        { id: "veo-3.1-generate-preview" },
        { id: "gemini-embedding-2-preview" },
        { id: "gemini-3.7-flash" },
        { id: "deliverance-7b" }, // "live" inside a word is not the live modality
      ],
    );
    expect(out.map((m) => m.id)).toEqual(["gemini-3.7-flash", "deliverance-7b"]);
  });

  test("extras are capped, in the provider's own order", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `vendor/model-${i}` }));
    const out = mergeDiscovered(SEED, many);
    expect(out).toHaveLength(SEED.length + DISCOVERED_EXTRA_CAP);
    expect(out[SEED.length]?.id).toBe("vendor/model-0");
  });

  test("a blank label falls back to the id", () => {
    expect(mergeDiscovered([], [{ id: "gpt-6-sol", label: "  " }])).toEqual([
      { id: "gpt-6-sol", label: "gpt-6-sol" },
    ]);
  });
});
