/**
 * Thinking depth as a step in the model picker.
 *
 * It used to live behind `/config effort max`, which is the wrong shape twice
 * over: nobody discovers a setting whose name they must already know, and a
 * person mid-decision about a model should not have to leave that decision to
 * type an incantation. Depth is a property of the model being chosen, so it is
 * asked for where the model is chosen — arrow keys, enter, same as every other
 * level of the tree.
 *
 * The values are not invented. Codex's list is what the live ChatGPT backend
 * answered on 2026-08-30: it validates `reasoning.effort` and 400s the whole
 * request on anything the model rejects, so the set is the model's own. The
 * OpenAI API path is deliberately narrower — low/medium/high are known-good
 * there and xhigh/max have not been probed on that endpoint.
 */

import { describe, test, expect } from "bun:test";
import {
  effortChoices,
  effortValuesFor,
  modelChoices,
} from "../../../packages/orchestrator/src/bin/ui/model-picker";
import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";

const codexPreset = PROVIDER_PRESETS.find((p) => p.id === "codex");

describe("the Codex model list", () => {
  test("offers the three current models and nothing else", () => {
    // gpt-5.5 is gone: previous frontier, 400s on some Plus tiers, and a fourth
    // row that may not work is clutter in the one list a person reads while
    // deciding.
    expect(codexPreset?.models.map((m) => m.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  test("the picker surfaces exactly those three", () => {
    const models = modelChoices(codexPreset, "codex", {
      current: { provider: "codex", model: "gpt-5.6-sol" },
      def: null,
    });
    expect(models).toHaveLength(3);
    expect(models.find((m) => m.id === "gpt-5.6-sol")?.current).toBe(true);
  });
});

describe("the depth step", () => {
  test("Codex gpt-5.6 offers every depth the backend accepts", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(effortValuesFor("codex", model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  test("'max' is reachable — it is the whole point of this step", () => {
    // Before this, a ChatGPT subscription ran at the server default and max was
    // unreachable from anywhere in the product.
    expect(effortValuesFor("codex", "gpt-5.6-sol")).toContain("max");
  });

  test("'none' is never offered", () => {
    // It is the internal value for thinking-off (utility calls, the fast
    // classifier). An agent driven at none is not a setting anyone wants.
    for (const p of ["codex", "openai"]) {
      for (const m of ["gpt-5.6-sol", "gpt-5"]) {
        expect(effortValuesFor(p, m)).not.toContain("none");
      }
    }
  });

  test("'minimal' is never offered on gpt-5.6 — the model rejects it", () => {
    expect(effortValuesFor("codex", "gpt-5.6-sol")).not.toContain("minimal");
  });

  test("the step does not appear where the dial does nothing", () => {
    // Anthropic and Google ignore the field entirely; they approximate depth by
    // thinking budget. Offering a control that changes nothing is worse than
    // offering none.
    for (const p of ["anthropic", "google", "ollama", "openrouter", "custom"]) {
      expect({ p, values: effortValuesFor(p, "some-model") }).toEqual({ p, values: [] });
    }
    // ...and not on a non-reasoning OpenAI model either.
    expect(effortValuesFor("openai", "gpt-4o")).toEqual([]);
  });

  test("every choice carries a plain-language hint", () => {
    const choices = effortChoices("codex", "gpt-5.6-sol", "high");
    expect(choices).toHaveLength(5);
    for (const c of choices) {
      expect(c.hint.length).toBeGreaterThan(0);
      expect(c.label).toBe(c.id);
    }
    expect(choices.find((c) => c.id === "max")?.hint).toContain("deepest");
  });

  test("the current depth is marked, and defaults to high when unset", () => {
    expect(effortChoices("codex", "gpt-5.6-sol", "max").find((c) => c.current)?.id).toBe("max");
    expect(effortChoices("codex", "gpt-5.6-sol", undefined).find((c) => c.current)?.id).toBe(
      "high",
    );
  });
});
