import { describe, it, expect } from "bun:test";
import { formatNotice, formatEvent } from "../../../packages/orchestrator/src/bin/ui/events";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

describe("ui/events formatNotice", () => {
  it("collapses a provider-fallback notice into a compact `from → to · reason` line", () => {
    const msg =
      "ollama-turbo/glm-4.7 unavailable — rate limited. Switching to openrouter/qwen/qwen3-coder:free…";
    const out = stripAnsi(formatNotice(msg));
    expect(out).toContain("ollama-turbo/glm-4.7");
    expect(out).toContain("openrouter/qwen/qwen3-coder:free");
    expect(out).toContain("→"); // the switch is shown as an arrow, not a sentence
    expect(out).toContain("rate limited");
    expect(out).not.toContain("Switching to"); // the verbose phrasing is gone
    expect(out).not.toContain("unavailable");
  });

  it("keeps the reason optional", () => {
    const out = stripAnsi(
      formatNotice("openai/gpt-4o unavailable. Switching to google/gemini-2.5-flash…"),
    );
    expect(out).toContain("openai/gpt-4o");
    expect(out).toContain("→");
    expect(out).toContain("google/gemini-2.5-flash");
  });

  it("falls back to a plain bullet for non-fallback notices", () => {
    const out = stripAnsi(formatNotice("Context is getting long — consider /compress."));
    expect(out.trim().startsWith("•")).toBe(true);
    expect(out).toContain("/compress");
  });

  it("is what formatEvent emits for notice + context_warning events", () => {
    const ev = { type: "notice", message: "a unavailable — busy. Switching to b/m…" };
    expect(formatEvent(ev)).toBe(formatNotice(ev.message));
  });
});
