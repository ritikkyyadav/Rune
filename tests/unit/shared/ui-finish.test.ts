// The finish vocabulary: two names, the words that fold onto them, and the
// precedence between env, the saved choice, config and the default.

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_UI_FINISH,
  parseUiFinish,
  resolveUiFinish,
} from "../../../packages/shared/src/ui-finish";

describe("ui finish", () => {
  it("opens matte", () => {
    expect(DEFAULT_UI_FINISH).toBe("matte");
  });

  it("folds the words people reach for onto the two finishes", () => {
    for (const word of ["matte", "MATTE", " soft ", "calm", "dim"]) {
      expect(parseUiFinish(word), word).toBe("matte");
    }
    for (const word of ["crisp", "glossy", "gloss", "sharp", "contrast"]) {
      expect(parseUiFinish(word), word).toBe("crisp");
    }
  });

  it("never reads a theme name, a typo or nothing as a finish", () => {
    for (const word of ["high-contrast", "dark", "mate", "", "   "]) {
      expect(parseUiFinish(word), word).toBeUndefined();
    }
    expect(parseUiFinish(undefined)).toBeUndefined();
    expect(parseUiFinish(null)).toBeUndefined();
  });

  it("env beats saved beats config beats the default; a typo falls through", () => {
    expect(resolveUiFinish({ env: "crisp", saved: "matte", configured: "matte" })).toBe("crisp");
    expect(resolveUiFinish({ env: "bogus", saved: "crisp", configured: "matte" })).toBe("crisp");
    expect(resolveUiFinish({ saved: null, configured: "crisp" })).toBe("crisp");
    expect(resolveUiFinish({})).toBe("matte");
  });
});
