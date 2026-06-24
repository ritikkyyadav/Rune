import { describe, it, expect } from "vitest";
import {
  PROVIDER_PRESETS,
  getPreset,
  CUSTOM_PROVIDER_ID,
} from "../../../packages/shared/src/providers";

describe("provider presets", () => {
  it("offers the named providers the keys panel promises", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    for (const id of ["anthropic", "openai", "openrouter", "google", "groq", "xai", "deepseek"]) {
      expect(ids).toContain(id);
    }
  });

  it("has unique ids", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset has the required fields", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.label).toBeTruthy();
      expect(p.defaultModel).toBeTruthy();
      expect(p.docsUrl).toMatch(/^https:\/\//);
      expect(["anthropic", "openai-compat", "google", "ollama"]).toContain(p.kind);
    }
  });

  it("remote openai-compat hosts carry an https base URL; local ones use localhost", () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.kind === "openai-compat" && p.id !== "openai" && !p.local) {
        expect(p.baseUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it("local runtimes are keyless and carry a base URL", () => {
    const locals = PROVIDER_PRESETS.filter((p) => p.local);
    expect(locals.map((p) => p.id).sort()).toEqual(["lmstudio", "ollama"]);
    for (const p of locals) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      expect(p.envVar).toBeUndefined(); // no API key
    }
  });

  it("resolves presets by id; custom/unknown are not presets", () => {
    expect(getPreset("groq")?.label).toBe("Groq");
    expect(getPreset("nope")).toBeUndefined();
    expect(getPreset(CUSTOM_PROVIDER_ID)).toBeUndefined();
  });
});
