// ─── The variants registry: everything the loop is allowed to change ───
//
// This file is the allowlist, and it is closed on purpose. A self-improving
// system changes behaviour only inside a DECLARED, enumerable space; a system
// that can reach any field it can name is mutating, whatever the measurement
// says. So the space is a literal object here, the ids are a union derived
// from it, and every consumer — the tuner, the A/B runner, `gear evolve
// promote` — takes a `VariantId` rather than a config fragment.
//
// What is structurally absent, and why that is a stronger claim than a check:
// the value type is `Partial<AbConfig>`, and `AbConfig` has no field under
// `permissions`, `sandbox`, `autoMode`, `yoloMode`, `trustWorkspace`, cost
// caps or the `verify.*` gates. A variant that tried to turn the sandbox off
// would not fail a test — it would fail to compile, and `configHash` would not
// see the field even if someone cast past the type.
//
// The same reasoning covers `GARDENER_OFF_LIMITS`: those are FILES, and no
// variant can name a file at all. A variant is a handful of config values; it
// cannot patch source. The invariants test asserts both halves so the property
// survives someone widening `AbConfig` in a hurry.
//
// Not here in v1, deliberately: doctrine-SECTION overrides (a variant that
// drops one `# Heading` from the prompt). The section gates are derived from
// what the session can actually do — a delegation tool registered, a workspace
// with an interface — and a variant that overrode that would be claiming a
// capability the session does not have. `doctrine_full` covers the delivery
// question, which is the one with evidence behind it.

import type { EngineConfig } from "../engine";
import type { AbConfig } from "./config-hash";

/**
 * Compile-time proof that the allowlist is a real subset of what the engine
 * accepts. If `AbConfig` ever grows a field `EngineConfig` does not have, or
 * changes a field's type away from the engine's, this line stops compiling
 * rather than the A/B silently measuring a config the engine ignores.
 */
type _AbConfigIsEngineSubset = AbConfig extends Partial<EngineConfig> ? true : never;
const _abConfigIsEngineSubset: _AbConfigIsEngineSubset = true;
void _abConfigIsEngineSubset;

export interface Variant {
  /** Stable id: the string a ledger entry, a proposal and a CLI argument share. */
  id: string;
  /** One line, for `gear evolve ab --list` and the proposal printout. */
  summary: string;
  /**
   * What this variant is a bet ON — the thing it should improve if the belief
   * is right. Written down so a promotion can be read back and disagreed with.
   */
  hypothesis: string;
  /** The configuration delta. The control arm is this object empty. */
  config: Partial<AbConfig>;
}

/**
 * The closed set. Adding a variant is a source change and a code review; that
 * is the intended cost.
 */
export const VARIANTS = {
  doctrine_full: {
    id: "doctrine_full",
    summary: "ship the situational doctrine on every request instead of once, just in time",
    hypothesis:
      "JIT delivery saves ~2k tokens per request but pays for it when the model needed the section before the moment the trigger fired. If full delivery raises the clean pass rate without raising cost beyond the band, the saving was not free.",
    config: { doctrineDelivery: "full" },
  },
  effort_ceiling: {
    id: "effort_ceiling",
    summary: "run every turn at the reasoning ceiling instead of a notch below it",
    hypothesis:
      "Conservative routing latches back to the ceiling on the first sign of difficulty. If it latches too late, the tasks it loses are worth more than the tokens it saves.",
    config: { effortRouting: "off" },
  },
  effort_medium: {
    id: "effort_medium",
    summary: "lower the reasoning ceiling to medium",
    hypothesis:
      "The ceiling is high everywhere. On a suite this size, medium may be indistinguishable on pass rate and materially cheaper — the cheapest real win available if it holds.",
    config: { reasoningEffort: "medium" },
  },
  notebook_on: {
    id: "notebook_on",
    summary: "inject the learned notebook under its default budget",
    hypothesis:
      "The notebook is off by default and its whole premise is that a repository's own lessons beat generic doctrine. This is the arm that tests the premise instead of assuming it.",
    config: { notebook: { enabled: true } },
  },
  notebook_wide: {
    id: "notebook_wide",
    summary: "inject the learned notebook at double the token budget",
    hypothesis:
      "If the notebook helps at 600 tokens, the question is whether it helps more at 1,200 or whether the extra rows are noise the model pays for on every request.",
    config: { notebook: { enabled: true, maxInjectTokens: 1200 } },
  },
  repo_map_off: {
    id: "repo_map_off",
    summary: "drop the structural repository map from context assembly",
    hypothesis:
      "The repo map is on by default and costs tokens on every request. A control group is the only way to know it earns them.",
    config: { context: { repoMap: false } },
  },
  playbook_off: {
    id: "playbook_off",
    summary: "stop writing the repository playbook at run end",
    hypothesis:
      "The playbook is the widest automatic action in the loop. Measuring the run WITHOUT it is the permanent control group the 2026-07 plan asked for.",
    config: { evolve: { playbook: false } },
  },
} as const satisfies Record<string, Variant>;

export type VariantId = keyof typeof VARIANTS;

export const VARIANT_IDS = Object.keys(VARIANTS) as VariantId[];

export function isVariantId(id: string): id is VariantId {
  return Object.prototype.hasOwnProperty.call(VARIANTS, id);
}

export function variant(id: VariantId): Variant {
  return VARIANTS[id];
}

/** The config delta for a variant, or `{}` for the control arm. */
export function variantConfig(id: VariantId): Partial<AbConfig> {
  return VARIANTS[id].config;
}

/**
 * The `~/.gear/config.toml` lines a promotion writes. Kept beside the registry
 * so the config surface and the variant cannot drift apart: a variant with no
 * rendering here cannot be promoted, and `promote.ts` treats an empty result as
 * a refusal rather than as a no-op write.
 */
export function variantConfigLines(id: VariantId): string[] {
  const c = VARIANTS[id].config as Partial<AbConfig>;
  const lines: string[] = [];
  const llm: string[] = [];
  if (c.reasoningEffort !== undefined) llm.push(`reasoningEffort = "${c.reasoningEffort}"`);
  if (c.doctrineDelivery !== undefined) llm.push(`doctrineDelivery = "${c.doctrineDelivery}"`);
  if (c.effortRouting !== undefined) llm.push(`effortRouting = "${c.effortRouting}"`);
  if (llm.length > 0) lines.push("[llm]", ...llm);
  if (c.notebook !== undefined) {
    const rows: string[] = [];
    if (c.notebook.enabled !== undefined) rows.push(`enabled = ${c.notebook.enabled}`);
    if (c.notebook.maxInjectTokens !== undefined) {
      rows.push(`maxInjectTokens = ${c.notebook.maxInjectTokens}`);
    }
    if (rows.length > 0) lines.push("[notebook]", ...rows);
  }
  if (c.context?.repoMap !== undefined) lines.push("[context]", `repoMap = ${c.context.repoMap}`);
  if (c.evolve?.playbook !== undefined) lines.push("[evolve]", `playbook = ${c.evolve.playbook}`);
  return lines;
}
