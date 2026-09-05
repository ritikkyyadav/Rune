// ─── Model-family adapters ───
//
// The same tool, described the way each model family was trained to read it.
//
// One family gate already existed: `apply_patch` is advertised only to the
// gpt/o-series/codex lineage, because those models were trained on the
// `*** Begin Patch` envelope and nobody else has seen it. That gate answers
// "should this model see this tool at all". This file answers the next
// question — "how should it be described to THIS model" — for tools every
// family gets.
//
// Kept deliberately small. A variant earns its place only where a family
// demonstrably reads instructions differently; inventing per-family prose for
// its own sake would multiply the surface that has to stay true, and a wrong
// tool description is worse than a generic one.

/** The model lineages Rune phrases tools for. */
export type ModelFamily = "claude" | "gpt" | "gemini" | "generic";

/**
 * Which lineage a model id belongs to. Route prefixes are stripped first, so
 * `anthropic/claude-sonnet-4-6` and a bare `claude-sonnet-4-6` agree.
 */
export function modelFamily(model: string): ModelFamily {
  const id = model.toLowerCase().replace(/^.*\//, "").trim();
  if (id.startsWith("claude")) return "claude";
  if (/^(gpt-|o[134](-|$)|codex)/.test(id)) return "gpt";
  if (id.startsWith("gemini")) return "gemini";
  return "generic";
}

/**
 * Per-family suffixes appended to a tool's base description.
 *
 * Each entry names the failure it prevents, because a variant with no failure
 * behind it is decoration.
 */
const VARIANTS: Partial<Record<ModelFamily, Record<string, string>>> = {
  gpt: {
    // The gpt lineage also carries `apply_patch`, and left to itself it will
    // reach for the multi-file envelope even for a one-line change, which
    // makes a small edit an all-or-nothing patch that fails whole on any
    // context drift.
    edit_file:
      " Prefer this over apply_patch for a single-file change: a failed hunk here " +
      "costs one edit, not the whole patch.",
  },
  gemini: {
    // Gemini is the family most prone to describing an edit it has not made.
    // The instruction is about ORDER, which is the part that goes wrong.
    edit_file:
      " Call this tool to make the change. Do not describe the edit in prose first " +
      "and then call it — the call is the change.",
  },
  claude: {
    // Claude reliably reads a bare tool list; no variant has earned a place.
  },
};

/**
 * The description this model should be given for this tool: the base text,
 * plus its family's variant when one exists.
 *
 * Pure and total — an unknown family or tool returns the base description
 * unchanged, so adding a tool never requires touching this file.
 */
export function toolDescriptionFor(
  base: string,
  toolName: string,
  model: string | undefined,
): string {
  if (!model) return base;
  const suffix = VARIANTS[modelFamily(model)]?.[toolName];
  return suffix ? base + suffix : base;
}
