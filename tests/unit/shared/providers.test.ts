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
      expect(["anthropic", "openai-compat", "google"]).toContain(p.kind);
    }
  });

  it("openai-compat hosts other than native OpenAI carry a base URL", () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.kind === "openai-compat" && p.id !== "openai") {
        expect(p.baseUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it("resolves presets by id; custom/unknown are not presets", () => {
    expect(getPreset("groq")?.label).toBe("Groq");
    expect(getPreset("nope")).toBeUndefined();
    expect(getPreset(CUSTOM_PROVIDER_ID)).toBeUndefined();
  });
});
