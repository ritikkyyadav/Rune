// ─── Which frame the session draws: the vocabulary ───
//
// The two names, how a written value folds onto them, and the precedence
// between the environment, the config file and the default. Pure — no process
// state, no terminal — which is why it lives here rather than in `bin/ui`:
// `Engine.readConfigSetting` has to answer "what does [ui] layout say" for
// `/config`, and the engine may not import the terminal layer (the graph law in
// tests/unit/orchestrator/engine-graph-purity.test.ts). The process's CURRENT
// layout, set once at launch, stays in bin/ui/layout.ts beside the frame it
// draws; that module re-exports these four names, so nothing else moved.

export type UiLayout = "single" | "split";

/** The founder's default, 2026-09-15. */
export const DEFAULT_UI_LAYOUT: UiLayout = "single";

const LAYOUTS: readonly UiLayout[] = ["single", "split"];

/** Fold a written value onto the two we have. Anything else is the default --
 *  a typo in config.toml must not decide the shape of the window. */
export function parseUiLayout(value: string | undefined | null): UiLayout | undefined {
  if (value == null) return undefined;
  const folded = value.trim().toLowerCase();
  if (folded === "") return undefined;
  // The two names people reach for. `workspace` is what Phase 4's own document
  // calls the split, and `wide`/`panel` are what the founder called it aloud.
  if (folded === "workspace" || folded === "wide" || folded === "panel") return "split";
  if (folded === "simple" || folded === "column" || folded === "classic") return "single";
  return LAYOUTS.includes(folded as UiLayout) ? (folded as UiLayout) : undefined;
}

/** env beats config beats the default. Pure, so the precedence is a test. */
export function resolveUiLayout(input: {
  env?: string | undefined;
  configured?: string | undefined;
}): UiLayout {
  return parseUiLayout(input.env) ?? parseUiLayout(input.configured) ?? DEFAULT_UI_LAYOUT;
}
