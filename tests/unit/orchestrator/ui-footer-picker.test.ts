/**
 * The footer window follows the SELECTION.
 *
 * `single` is the default at every width, and in `single` every picker takes
 * the footer path — `keysInBand()` and `bandModal()` both gate on
 * `regionsNow().collapsed`, which `single` reports at 160 columns. `footerBlock`
 * kept the LAST `max` rows of an overlong block behind a "N more lines above"
 * marker, and a picker puts the row you are standing on at the head.
 *
 * Measured on a real pty at 120×40 before this changed (frames in
 * .codex/audit-20260910/handoff/m0/fix-d-frames/): `/keys` opened on
 * `... 3 more lines above (ctrl+r to expand)` followed by "Google Gemini" —
 * the panel title, Anthropic, OpenAI and OpenRouter all above the window, and
 * no selection marker anywhere on the screen. It first appeared on the third
 * press of down, when the selection walked into the window the window never
 * moved. The same terminal told to draw `split` showed `› o Anthropic` in the
 * first frame.
 *
 * `footerBlock`'s own comment — "Cropping the rendered tail can otherwise
 * remove the selected first row" — named the hazard and guarded the wrong end.
 */

import { describe, test, expect, afterAll } from "bun:test";

import { FRAME_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-frame";

const strip = (s: string) =>
  s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

const ROWS = 40;
const HEADER_ROWS = 3;
/** rowsCount() - headerRows - 1, the footer's own budget. */
const MAX = ROWS - HEADER_ROWS - 1;

const original = process.stdout.rows;
afterAll(() => {
  Object.defineProperty(process.stdout, "rows", { value: original, configurable: true });
});
Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });

const PROVIDERS = [
  "Anthropic",
  "OpenAI",
  "OpenRouter",
  "Google Gemini",
  "Groq",
  "xAI Grok",
  "DeepSeek",
  "ChatGPT (Codex)",
  "Ollama Turbo (cloud)",
  "AWS Bedrock",
  "Google Vertex AI",
  "Azure OpenAI",
  "AI21 Labs",
  "Alibaba Qwen",
  "Baseten",
  "Cerebras",
  "Chutes",
  "Cohere",
  "DeepInfra",
  "Fireworks AI",
  "GitHub Models",
  "Hugging Face",
  "Hyperbolic",
  "Inception (Mercury)",
  "MiniMax",
  "Mistral AI",
  "Moonshot (Kimi)",
  "Nebius AI Studio",
  "Novita AI",
  "NVIDIA NIM",
  "SambaNova",
  "Scaleway",
  "SiliconFlow",
  "Together AI",
  "Vercel AI Gateway",
  "Z.ai (GLM)",
  "Ollama (local)",
];

/** The `/keys` roster as the footer path receives it: a title, a row per
 *  provider with the selected one marked, and the key bar last. */
function roster(selected: number) {
  return {
    lines: [
      "  API keys   bring your own",
      ...PROVIDERS.map((p, i) => `  ${i === selected ? "›" : " "} o ${p.padEnd(22)} not set`),
      "  up/down move | enter manage keys | space on/off | d clear | esc close",
    ],
    caretRow: 0,
    caretCol: 0,
  };
}

/** `footerBlock` over a block it cannot fit, with no Tui behind it. */
function footer(block: { lines: string[]; caretRow: number; caretCol: number }) {
  const self = { bound: (l: string) => l, composerBlock: (_max: number) => block };
  const out = (
    FRAME_METHODS.footerBlock as (
      this: unknown,
      headerRows: number,
    ) => { lines: string[]; caretRow: number; caretCol: number }
  ).call(self, HEADER_ROWS);
  return { ...out, painted: out.lines.map(strip) };
}

describe("the footer picker keeps the selected row on screen", () => {
  test("the premise: the roster really is taller than the footer", () => {
    expect(roster(0).lines.length).toBeGreaterThan(MAX);
  });

  test("the selection is drawn at every position in the roster", () => {
    for (let selected = 0; selected < PROVIDERS.length; selected++) {
      const { painted } = footer(roster(selected));
      const marked = painted.filter((line) => line.includes("›"));
      expect(marked).toHaveLength(1);
      expect(marked[0]).toContain(PROVIDERS[selected]!);
    }
  });

  test("the first row opens with its title and its selection, as split always did", () => {
    const { painted } = footer(roster(0));
    expect(painted[0]).toContain("API keys");
    expect(painted[1]).toContain("› o Anthropic");
    // The cut is at the other end now, and it says so.
    expect(painted[painted.length - 1]).toMatch(/more lines? below/);
  });

  test("the last row keeps the key bar and marks what is above", () => {
    const { painted } = footer(roster(PROVIDERS.length - 1));
    expect(painted[0]).toMatch(/more lines? above/);
    expect(painted[painted.length - 1]).toContain("up/down move");
    expect(painted.some((line) => line.includes("› o Ollama (local)"))).toBe(true);
  });

  test("a selection in the middle is marked on both sides", () => {
    const { painted } = footer(roster(Math.floor(PROVIDERS.length / 2)));
    expect(painted[0]).toMatch(/more lines? above/);
    expect(painted[painted.length - 1]).toMatch(/more lines? below/);
  });

  test("the footer never exceeds its budget, wherever the selection is", () => {
    for (let selected = 0; selected < PROVIDERS.length; selected++)
      expect(footer(roster(selected)).lines.length).toBeLessThanOrEqual(MAX);
  });

  test("with no selection the caret is the anchor, so a long composer still shows its end", () => {
    // A composer overflowing its own field has no marker; the row being typed
    // on is the one that has to stay visible.
    const lines = Array.from({ length: MAX + 10 }, (_, i) => `  line ${i}`);
    const { painted, caretRow } = footer({ lines, caretRow: lines.length - 1, caretCol: 2 });
    expect(painted[0]).toMatch(/more lines? above/);
    expect(painted[painted.length - 1]).toContain(`line ${lines.length - 1}`);
    expect(caretRow).toBe(painted.length - 1);
  });

  test("a block that fits is passed through untouched", () => {
    const lines = ["  one", "  two", "  › three"];
    const { painted } = footer({ lines, caretRow: 0, caretCol: 0 });
    expect(painted).toEqual(lines);
  });
});
