/**
 * P8.7 — the same tool, phrased for the family reading it.
 *
 * The registry already gated `apply_patch` by family ("should this model see
 * this tool at all"). This is the next question: "how should it be described
 * to THIS model". The rules that matter here are the boring ones — a variant
 * must never change what a tool DOES, and an unknown model must get the plain
 * description rather than nothing.
 */

import { describe, test, expect } from "bun:test";
import {
  modelFamily,
  toolDescriptionFor,
} from "../../../packages/tool-registry/src/model-families";

describe("family detection", () => {
  test.each([
    ["claude-opus-5", "claude"],
    ["anthropic/claude-sonnet-4-6", "claude"],
    ["gpt-5", "gpt"],
    ["gpt-5.6-sol", "gpt"],
    ["o3", "gpt"],
    ["codex-mini", "gpt"],
    ["openai/gpt-4o", "gpt"],
    ["gemini-2.5-flash", "gemini"],
    ["google/gemini-3-pro", "gemini"],
    ["minimax/minimax-m3:free", "generic"],
    ["llama3.1", "generic"],
  ])("%s is the %s lineage", (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });
});

describe("descriptions", () => {
  const BASE = "Edit a file by replacing an exact string.";

  test("an unknown model gets the base description, never an empty one", () => {
    expect(toolDescriptionFor(BASE, "edit_file", undefined)).toBe(BASE);
    expect(toolDescriptionFor(BASE, "edit_file", "some-model-from-2027")).toBe(BASE);
  });

  test("a tool with no variant is passed through unchanged for every family", () => {
    for (const model of ["claude-opus-5", "gpt-5", "gemini-2.5-flash", "llama3.1"]) {
      expect(toolDescriptionFor(BASE, "read_file", model)).toBe(BASE);
    }
  });

  test("every variant is additive — the base text always survives", () => {
    for (const model of ["claude-opus-5", "gpt-5", "gemini-2.5-flash", "llama3.1"]) {
      expect(toolDescriptionFor(BASE, "edit_file", model).startsWith(BASE)).toBe(true);
    }
  });

  test("the gpt lineage is steered off apply_patch for single-file edits", () => {
    // It carries both tools and will otherwise reach for the multi-file
    // envelope on a one-line change, where a single context mismatch fails the
    // whole patch instead of one edit.
    expect(toolDescriptionFor(BASE, "edit_file", "gpt-5")).toContain("apply_patch");
  });

  test("gemini is told the call IS the change", () => {
    // The family most prone to narrating an edit it never made.
    expect(toolDescriptionFor(BASE, "edit_file", "gemini-2.5-flash")).toContain(
      "the call is the change",
    );
  });

  test("claude gets no variant, because none has earned one", () => {
    expect(toolDescriptionFor(BASE, "edit_file", "claude-opus-5")).toBe(BASE);
  });
});
