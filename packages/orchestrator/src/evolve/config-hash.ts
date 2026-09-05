// ─── The A/B-relevant configuration, and its hash ───
//
// A measured difference between two runs is worth nothing unless you can say
// which configuration each one ran under. `EngineConfig` has ~50 fields, most
// of which are environment (paths, binaries, db locations) rather than
// behaviour; hashing all of them would make every run look unique and hashing
// none of them makes every run look identical. This file names the exact
// subset that changes how the agent behaves and can therefore be A/B'd.
//
// The list is also a boundary. Everything a variant may touch must appear
// here, and this file deliberately contains NO field under `permissions`,
// `sandbox`, `autoMode`, `yoloMode`, `trustWorkspace`, cost caps or the
// `verify.*` gates. `variants.ts` enforces that with a type; the invariants
// test enforces it against the text.

import { createHash } from "node:crypto";
import type { ReasoningEffort } from "@rune/llm-gateway";

/**
 * The behaviour-bearing slice of `EngineConfig`. Structural, not an import:
 * `Partial<EngineConfig>` would let a variant reach any field the engine ever
 * grows, and the point of an allowlist is that it does not grow by accident.
 *
 * Field names and types mirror `EngineConfig` exactly, and
 * `variants.ts` asserts the assignability at compile time.
 */
export interface AbConfig {
  /** Reasoning depth ceiling for every model call. */
  reasoningEffort: ReasoningEffort;
  /** Whether situational doctrine ships in every request or is injected once. */
  doctrineDelivery: "jit" | "full";
  /** Whether ordinary turns run a notch below the ceiling. */
  effortRouting: "conservative" | "off";
  /** The learned-notebook injection. */
  notebook: { enabled?: boolean; maxInjectTokens?: number };
  /** Context assembly. */
  context: { repoMap?: boolean };
  /** Whether the run writes the repository playbook. */
  evolve: { playbook?: boolean };
}

/**
 * The keys, in a fixed order, so the hash does not depend on how an object
 * happened to be constructed. Exported because the invariants test reads it.
 */
export const AB_CONFIG_KEYS = [
  "reasoningEffort",
  "doctrineDelivery",
  "effortRouting",
  "notebook",
  "context",
  "evolve",
] as const satisfies ReadonlyArray<keyof AbConfig>;

/**
 * Fields a variant may NEVER carry, named here so the test that proves it can
 * read the list rather than re-deriving it from prose. Every one of these is
 * either a safety posture or a spend ceiling: measuring your way into turning
 * one off is exactly the mutation this phase exists to prevent.
 */
export const AB_FORBIDDEN_KEYS: readonly string[] = [
  "permissions",
  "permissionMode",
  "sandbox",
  "sandboxEnabled",
  "autoMode",
  "yoloMode",
  "trustWorkspace",
  "maxSessionCostUsd",
  "egressAllowlist",
  "redactOutputs",
  "enableVerification",
  "verifyCommand",
  "verifyPerStep",
  "verifyTimeoutMs",
  "orgPolicy",
];

/** The defaults a run has when a variant says nothing — the control arm. */
export const AB_CONFIG_DEFAULTS: AbConfig = {
  reasoningEffort: "high",
  doctrineDelivery: "jit",
  effortRouting: "conservative",
  notebook: {},
  context: {},
  evolve: {},
};

/** Deterministic JSON: object keys sorted at every depth, arrays left alone. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = stable(v);
    }
    return out;
  }
  return value;
}

/**
 * The A/B-relevant projection of a config, with defaults filled in — so a run
 * that leaves `doctrineDelivery` unset and one that sets it to its default
 * hash the same, because they ARE the same run.
 */
export function abConfigOf(config: Partial<AbConfig> | Record<string, unknown>): AbConfig {
  const src = config as Partial<AbConfig>;
  return {
    reasoningEffort: src.reasoningEffort ?? AB_CONFIG_DEFAULTS.reasoningEffort,
    doctrineDelivery: src.doctrineDelivery ?? AB_CONFIG_DEFAULTS.doctrineDelivery,
    effortRouting: src.effortRouting ?? AB_CONFIG_DEFAULTS.effortRouting,
    notebook: { ...(src.notebook ?? {}) },
    context: { ...(src.context ?? {}) },
    evolve: { ...(src.evolve ?? {}) },
  };
}

/**
 * Twelve hex characters over the A/B-relevant fields alone. Two runs with the
 * same `configHash` and the same `doctrineHash` are the same arm; that pair is
 * what `rune evolve promote` refuses to act without.
 */
export function configHash(config: Partial<AbConfig> | Record<string, unknown>): string {
  const ab = abConfigOf(config);
  const ordered: Record<string, unknown> = {};
  for (const k of AB_CONFIG_KEYS) ordered[k] = stable(ab[k]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 12);
}
