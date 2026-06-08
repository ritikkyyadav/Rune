import { describe, it, expect } from "vitest";
import {
  renderComposer,
  renderPicker,
  composerRule,
  renderSlashPalette,
  renderKeysPanel,
  renderKeyEditor,
} from "../../../packages/orchestrator/src/bin/ui/composer";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

describe("ui/composer renderComposer", () => {
  it("renders a 4-line block with a uniform-width box and caret on the input row", () => {
    const r = renderComposer({ input: "hello", caret: 5, width: 80, status: "  status" });
    expect(r.lines).toHaveLength(4); // top, input, bottom, status
    const box = r.lines.slice(0, 3).map((l) => stripAnsi(l).length);
    expect(new Set(box).size).toBe(1); // top/mid/bottom equal width
    expect(r.caretRow).toBe(1);
    expect(r.caretCol).toBe(11); // 6 chrome cols + caret index 5
  });

  it("never produces a line at or beyond the terminal width (no auto-wrap)", () => {
    const r = renderComposer({ input: "x".repeat(500), caret: 500, width: 80, status: "  s" });
    for (const l of r.lines) expect(stripAnsi(l).length).toBeLessThan(80);
  });

  it("horizontally scrolls to keep a far caret visible", () => {
    const r = renderComposer({ input: "x".repeat(200), caret: 200, width: 60, status: "  s" });
    // caret column stays inside the box, not off-screen
    expect(r.caretCol).toBeLessThan(60);
    expect(r.caretCol).toBeGreaterThan(5);
  });

  it("shows a working indicator instead of the box when set", () => {
    const r = renderComposer({
      input: "",
      caret: 0,
      width: 80,
      status: "  s",
      working: "• Working (3s · esc to interrupt)",
    });
    expect(r.lines).toHaveLength(2);
    expect(stripAnsi(r.lines[0])).toContain("Working");
    expect(r.caretRow).toBe(0);
  });
});

describe("ui/composer composerRule", () => {
  it("is a chevron-aligned hairline of only ─ glyphs (frames the readline input)", () => {
    const r = stripAnsi(composerRule());
    expect(r.startsWith("  ")).toBe(true); // same 2-col indent as the `›` prompt
    expect(r.trim()).toMatch(/^─+$/); // nothing but box-drawing dashes
    expect(r.trim().length).toBeGreaterThan(10);
  });
});

describe("ui/composer renderSlashPalette", () => {
  const items = [
    { name: "/model", desc: "Switch model / provider" },
    { name: "/effort", desc: "Set reasoning effort" },
    { name: "/help", desc: "Show commands" },
  ];

  it("highlights the selected row and lists names + descriptions", () => {
    const plain = renderSlashPalette(items, 1, 100).map(stripAnsi);
    expect(plain.some((l) => l.includes("❯") && l.includes("/effort"))).toBe(true); // selected = index 1
    expect(plain.find((l) => l.includes("/model"))!.startsWith("    ")).toBe(true); // unselected = no marker
    expect(plain.join("\n")).toContain("Switch model / provider");
    expect(plain.at(-1)).toContain("tab complete"); // hint footer
  });

  it("returns nothing for an empty list", () => {
    expect(renderSlashPalette([], 0, 100)).toEqual([]);
  });

  it("windows a long list to at most 8 rows + a hint, keeping the selection in view", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: "/c" + i, desc: "d" + i }));
    const lines = renderSlashPalette(many, 20, 100);
    expect(lines.length).toBeLessThanOrEqual(9); // 8 rows + 1 hint
    expect(stripAnsi(lines.join("\n"))).toContain("/c20");
  });
});

describe("ui/composer renderKeysPanel", () => {
  const rows = [
    { id: "anthropic", label: "Anthropic", masked: "sk-a…1f2a", source: "saved" as const, disabled: false, active: true },
    { id: "groq", label: "Groq", masked: "", source: "none" as const, disabled: false, active: false },
    { id: "openai", label: "OpenAI", masked: "sk-o…9999", source: "saved" as const, disabled: true, active: false },
  ];

  it("marks the selection, shows status + masked keys, and never the raw secret", () => {
    const plain = renderKeysPanel(rows, 1, 100).lines.map(stripAnsi);
    expect(plain[0]).toContain("API keys");
    expect(plain.some((l) => l.includes("❯") && l.includes("Groq"))).toBe(true); // selected = index 1
    expect(plain.find((l) => l.includes("Anthropic"))!).toContain("sk-a…1f2a");
    expect(plain.find((l) => l.includes("Groq"))!).toContain("not set");
    expect(plain.find((l) => l.includes("OpenAI"))!).toContain("off"); // toggled off
    expect(plain.at(-1)).toContain("enter edit"); // hint footer
  });
});

describe("ui/composer renderKeyEditor", () => {
  it("masks an API key, leaving only the last 4 visible", () => {
    const r = renderKeyEditor({ title: "Paste API key — Groq", value: "gsk_supersecret", caret: 15, width: 80, masked: true });
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("Paste API key");
    expect(joined).not.toContain("supersecret");
    expect(joined).toContain("•");
    expect(joined).toContain("cret"); // last 4 shown
    expect(r.caretRow).toBeGreaterThan(0);
  });

  it("shows a plain value with subtitle when not masked (e.g. a base URL)", () => {
    const r = renderKeyEditor({
      title: "Custom endpoint — base URL",
      subtitle: "OpenAI-compatible /v1 base URL",
      value: "https://api.x.ai/v1",
      caret: 5,
      width: 80,
      masked: false,
    });
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("https://api.x.ai/v1");
    expect(joined).toContain("/v1 base URL");
  });
});

describe("ui/composer renderPicker", () => {
  it("marks the selected row and includes a hint footer", () => {
    const r = renderPicker(
      "Model",
      [{ label: "Gemini 2.5 Flash" }, { label: "Gemini 2.5 Pro" }],
      1,
      80,
    );
    expect(stripAnsi(r.lines[0])).toContain("Model");
    expect(stripAnsi(r.lines[2])).toContain("❯"); // selected = index 1 → line 2
    expect(stripAnsi(r.lines[1])).not.toContain("❯");
    expect(stripAnsi(r.lines.at(-1)!)).toContain("enter confirm");
    expect(r.caretRow).toBe(2);
  });
});
