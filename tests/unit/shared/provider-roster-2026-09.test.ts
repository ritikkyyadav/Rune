/**
 * The first-party rosters, as verified on 2026-09-16.
 *
 * Why a dated snapshot rather than a rule: the rot this pins is not a logic
 * error, it is the passage of time. The product shipped a `codex` preset with
 * no `gpt-6-astra` in it — the model OpenAI had already made the bundled
 * default for Codex — so signing in with a ChatGPT account offered a lineup a
 * generation behind the account's own entitlement. The founder found it by
 * using the product. Nothing failed; every table agreed with every other table;
 * they were all agreeing about a world that had moved on.
 *
 * A test that names the ids AND the date it was told them turns the next drift
 * into a red build with a timestamp on it: when this fails, the question is not
 * "what broke" but "what did the vendor change, and when". Update the list and
 * the date together, from the vendor's own page, and say so in the commit.
 *
 * Scope is deliberate. Only the FIRST-PARTY rosters are pinned — the vendors
 * whose model pages were actually read. The wider OpenAI-compatible roster
 * (deepinfra, fireworks, together, …) is a seed list per host with no keyless
 * catalogue to check it against, so pinning it would be pinning a guess.
 * `rune models <provider>` is the truth there.
 */

import { describe, test, expect } from "bun:test";
import { getPreset, PROVIDER_PRESETS } from "../../../packages/shared/src/providers";
import { PROVIDER_TIER_DEFAULTS } from "../../../packages/shared/src/tiers";
import { DEFAULT_MODELS } from "../../../packages/orchestrator/src/startup-selection";

/**
 * Verified 2026-09-16 from each vendor's own documentation; codex, openai,
 * anthropic, xai and vertex re-verified 2026-09-28 (GPT-6 Sol/Luna released
 * 2026-09-22, Claude Opus 5.5 the documented starting point, grok-4.7).
 */
const ROSTER: Record<
  string,
  {
    models: string[];
    defaultModel: string;
    tiers: { heavy: string; standard: string; light: string };
    fallbackModel?: string;
  }
> = {
  // OpenAI, through a ChatGPT subscription (2026-09-28). The Codex models page
  // recommends exactly astra/sol/luna. gpt-5.5 retires 2026-10-14 and is
  // deliberately absent.
  codex: {
    models: [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ],
    defaultModel: "gpt-6-astra",
    tiers: { heavy: "gpt-6-astra", standard: "gpt-6-sol", light: "gpt-6-luna" },
    fallbackModel: "gpt-6-sol",
  },
  // OpenAI's API (2026-09-28). gpt-6-astra-pro dropped: no OpenAI page
  // documents it. gpt-5 / gpt-5-mini / gpt-4o / gpt-4o-mini / o3 dropped.
  openai: {
    models: [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
    ],
    defaultModel: "gpt-6-astra",
    tiers: { heavy: "gpt-6-astra", standard: "gpt-6-sol", light: "gpt-6-luna" },
    fallbackModel: "gpt-6-sol",
  },
  // Anthropic API ids (2026-09-28). Opus 5.5 is the documented starting point;
  // Opus 5 moved to legacy and stays as a pinnable row. claude-fable-5 and
  // claude-sonnet-4-5 dropped; Haiku ships as the alias, not the dated id.
  anthropic: {
    models: [
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ],
    defaultModel: "claude-opus-5-5",
    tiers: { heavy: "claude-opus-5-5", standard: "claude-sonnet-5", light: "claude-haiku-4-5" },
    fallbackModel: "claude-sonnet-5",
  },
  // Gemini API. gemini-2.0-flash dropped; 3.1 Pro is preview and never a tier.
  google: {
    models: [
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-pro-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ],
    defaultModel: "gemini-3.8-flash",
    tiers: {
      heavy: "gemini-3.8-flash",
      standard: "gemini-3.8-flash",
      light: "gemini-3.5-flash-lite",
    },
    fallbackModel: "gemini-3.5-flash",
  },
  // xAI (2026-09-28: grok-4.7 is the latest). grok-4 / grok-4-fast /
  // grok-code-fast-1 dropped.
  xai: {
    models: [
      "grok-4.7",
      "grok-4.6",
      "grok-4.5",
      "grok-4.3",
      "grok-build-0.1",
      "grok-4.20-0309-reasoning",
    ],
    defaultModel: "grok-4.7",
    tiers: { heavy: "grok-4.7", standard: "grok-4.7", light: "grok-4.3" },
  },
  // DeepSeek's pricing page lists exactly these two.
  deepseek: {
    models: ["deepseek-flash", "deepseek-v4-pro"],
    defaultModel: "deepseek-flash",
    tiers: { heavy: "deepseek-v4-pro", standard: "deepseek-flash", light: "deepseek-flash" },
  },
  // Groq: four production ids plus two marked preview.
  groq: {
    models: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "qwen/qwen3.8-27b",
      "minimaxai/minimax-m2.7",
    ],
    defaultModel: "openai/gpt-oss-120b",
    tiers: {
      heavy: "openai/gpt-oss-120b",
      standard: "openai/gpt-oss-120b",
      light: "llama-3.1-8b-instant",
    },
  },
  // Mistral: the -latest aliases. devstral-* / magistral-* are deprecated.
  mistral: {
    models: [
      "mistral-medium-latest",
      "mistral-large-latest",
      "mistral-small-latest",
      "codestral-latest",
    ],
    defaultModel: "mistral-medium-latest",
    tiers: {
      heavy: "mistral-large-latest",
      standard: "mistral-medium-latest",
      light: "mistral-small-latest",
    },
  },
  // Moonshot (platform.kimi.ai). Every k2-0905/thinking/turbo/latest id dropped.
  moonshot: {
    models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"],
    defaultModel: "kimi-k3",
    tiers: { heavy: "kimi-k3", standard: "kimi-k2.7-code", light: "kimi-k2.6" },
  },
  // Cerebras.
  cerebras: {
    models: ["gpt-oss-120b", "qwen-3.8-27b"],
    defaultModel: "gpt-oss-120b",
    tiers: { heavy: "", standard: "", light: "" }, // no tier table; see below
  },
  // Google Cloud Vertex ids. Opus 5.5 listed 2026-09-28 but not a tier: Model
  // Garden enables each model per project.
  vertex: {
    models: [
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5@20251001",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ],
    defaultModel: "claude-sonnet-5",
    tiers: {
      heavy: "claude-opus-5",
      standard: "claude-sonnet-5",
      light: "claude-haiku-4-5@20251001",
    },
    fallbackModel: "claude-sonnet-5",
  },
  // AWS Bedrock InvokeModel ids AWS documents today. Opus 5 / Sonnet 5 /
  // Fable 5.1 are deliberately absent: they are reached only by a newer
  // request shape this build does not route. opus-4-1 and the claude-3-5 pair
  // are dropped (deprecated).
  bedrock: {
    models: [
      "global.anthropic.claude-opus-4-6-v1",
      "global.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-opus-4-5-20251101-v1:0",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    ],
    defaultModel: "global.anthropic.claude-sonnet-4-6",
    tiers: {
      heavy: "global.anthropic.claude-opus-4-6-v1",
      standard: "global.anthropic.claude-sonnet-4-6",
      light: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    },
    fallbackModel: "global.anthropic.claude-sonnet-4-6",
  },
  // Azure OpenAI deployment NAMES.
  "azure-openai": {
    models: [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
    ],
    defaultModel: "gpt-6-astra",
    tiers: { heavy: "gpt-6-astra", standard: "gpt-5.6-sol", light: "gpt-5.4-mini" },
    fallbackModel: "gpt-5.6-terra",
  },
};

describe("first-party rosters, verified 2026-09-16 and 2026-09-28", () => {
  test.each(Object.keys(ROSTER))("%s lists exactly the verified ids, in order", (id) => {
    const preset = getPreset(id);
    expect(preset, `${id} has no preset`).toBeDefined();
    expect(preset!.models?.map((m) => m.id)).toEqual(ROSTER[id]!.models);
  });

  test.each(Object.keys(ROSTER))("%s opens on the verified default", (id) => {
    expect(getPreset(id)!.defaultModel).toBe(ROSTER[id]!.defaultModel);
  });

  test.each(Object.keys(ROSTER).filter((id) => id !== "cerebras"))(
    "%s resolves its tiers to the verified ids",
    (id) => {
      expect(PROVIDER_TIER_DEFAULTS[id]).toEqual(ROSTER[id]!.tiers);
    },
  );

  test("cerebras ships no tier table — its lineup is a seed, not a reading", () => {
    // Two ids and no vendor page read for weights: the tier resolver's own
    // fallback (the session model) is the honest answer.
    expect(getPreset("cerebras")!.tiers).toBeUndefined();
    expect(PROVIDER_TIER_DEFAULTS["cerebras"]).toBeUndefined();
  });

  test.each(Object.keys(ROSTER).filter((id) => ROSTER[id]!.fallbackModel))(
    "%s falls back to the verified id",
    (id) => {
      expect(getPreset(id)!.fallbackModel).toBe(ROSTER[id]!.fallbackModel);
    },
  );

  test("no first-party preset still names a retired id", () => {
    // The exact ids this refresh removed. Named one by one rather than matched
    // by pattern: a pattern would quietly stop covering a spelling, and the
    // point is that THESE do not come back.
    const RETIRED = [
      "gpt-5",
      "gpt-5-mini",
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
      "gpt-6-astra-pro",
      "claude-fable-5",
      "claude-sonnet-4-5",
      "claude-opus-4-1@20250805",
      "claude-sonnet-4-5@20250929",
      "gemini-2.0-flash",
      "grok-4",
      "grok-4-fast",
      "grok-code-fast-1",
      "deepseek-chat",
      "deepseek-reasoner",
      "kimi-k2-0905-preview",
      "kimi-k2-thinking",
      "kimi-k2-turbo-preview",
      "kimi-latest",
      "devstral-medium-latest",
      "magistral-medium-latest",
      "stealth/ox-alpha",
      "us.anthropic.claude-opus-4-1-20250805-v1:0",
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
      "anthropic.claude-3-5-haiku-20241022-v1:0",
    ];
    const offenders: string[] = [];
    for (const id of Object.keys(ROSTER)) {
      for (const m of getPreset(id)!.models ?? []) {
        if (RETIRED.includes(m.id)) offenders.push(`${id}:${m.id}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the rosters agree with every table projected from them", () => {
  test.each(Object.keys(DEFAULT_MODELS))("%s's CLI default equals its preset default", (id) => {
    // The fourth table. See tests/unit/shared/provider-tables.test.ts for the
    // rot this closes; repeated here because a roster refresh is exactly when
    // someone edits a preset and forgets this one.
    expect(DEFAULT_MODELS[id as keyof typeof DEFAULT_MODELS]).toBe(getPreset(id)!.defaultModel);
  });

  test("github-models is gone from the registry entirely", () => {
    // GitHub retired GitHub Models on 2026-07-30: playground, catalog and
    // inference API at once. A preset pointing at a dead host is worse than no
    // preset — it is a row in the picker that cannot answer.
    expect(getPreset("github-models")).toBeUndefined();
    expect(PROVIDER_PRESETS.some((p) => p.id === "github-models")).toBe(false);
    expect(PROVIDER_TIER_DEFAULTS["github-models"]).toBeUndefined();
  });
});
