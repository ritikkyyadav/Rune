// ─── How hard the ink presses: the vocabulary ───
//
// The second theme axis, beside light/dark: `matte` (the default) or `crisp`.
// The pigments themselves live in design-tokens.ts; this file is only the
// names, how a written value folds onto them, and the precedence between the
// environment, the saved choice, the config file and the default. Pure -- no
// process state, no terminal -- for the same reason ui-layout.ts is: the engine
// may have to read `[ui] finish` back for `/config` without importing the
// terminal layer.
//
// The founder's words, 2026-09-26: "right now colours are too chunky, they
// create irritation on eyes due to glossy contrast". Matte is the answer and
// the default; crisp is the same palette at its published poles, one choice
// away in `/theme`.

import { DEFAULT_RUNE_FINISH, RUNE_FINISHES, type RuneFinish } from "./design-tokens.js";

export type UiFinish = RuneFinish;

export const DEFAULT_UI_FINISH: UiFinish = DEFAULT_RUNE_FINISH;

/**
 * Fold a written value onto the two we have. Anything else is `undefined`, so
 * the next source in the precedence decides -- a typo in config.toml must not
 * decide how the whole screen reads.
 */
export function parseUiFinish(value: string | undefined | null): UiFinish | undefined {
  if (value == null) return undefined;
  const folded = value.trim().toLowerCase();
  if (folded === "") return undefined;
  // The words people reach for. "glossy" is the founder's own name for what
  // crisp is; "soft" and "calm" are what matte is for.
  if (folded === "soft" || folded === "calm" || folded === "dim") return "matte";
  // Not "high-contrast": that is a legacy palette's name, and a theme name
  // must never be read as a finish.
  if (folded === "glossy" || folded === "gloss" || folded === "sharp" || folded === "contrast") {
    return "crisp";
  }
  return RUNE_FINISHES.includes(folded as UiFinish) ? (folded as UiFinish) : undefined;
}

/**
 * env beats the saved choice beats config beats the default. Pure, so the
 * precedence is a test. The saved choice outranks config for the same reason
 * `~/.rune/theme.json` does for the theme: it is the most recent thing the
 * person actually picked, from inside the product.
 */
export function resolveUiFinish(input: {
  env?: string | null;
  saved?: string | null;
  configured?: string | null;
}): UiFinish {
  return (
    parseUiFinish(input.env) ??
    parseUiFinish(input.saved) ??
    parseUiFinish(input.configured) ??
    DEFAULT_UI_FINISH
  );
}
