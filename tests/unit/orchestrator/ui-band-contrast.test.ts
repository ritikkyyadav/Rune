// Ink on the diff bands must read: WCAG AA, 4.5:1, for every token. The audit
// of 2026-10-26 measured `null`/`false` at 2.79:1 and `const` at 2.96:1 on the
// light theme's blue added band, and green on the light band at 2.69:1 in the
// dark theme's /diff. The bands are the founder's colours; the inks change.
import { describe, expect, it } from "bun:test";
import { legibleAgainst, BAND_MIN_CONTRAST } from "../../../packages/orchestrator/src/bin/ui/theme";
import { contrastRatio } from "../../../packages/orchestrator/src/bin/ui/themes";

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;

describe("legibleAgainst", () => {
  const blueBand = hex("#1936d7");
  it("lifts the audit's failing colours on the blue band to AA", () => {
    for (const fg of ["#569cd6", "#c586c0", "#ce9178", "#4ec9b0"]) {
      const before = contrastRatio(hex(fg), blueBand);
      const after = legibleAgainst(hex(fg), blueBand);
      expect(contrastRatio(after, blueBand)).toBeGreaterThanOrEqual(BAND_MIN_CONTRAST);
      if (before >= BAND_MIN_CONTRAST) expect(after).toEqual(hex(fg));
    }
  });
  it("leaves a colour that already reads untouched", () => {
    expect(legibleAgainst([255, 255, 255], blueBand)).toEqual([255, 255, 255]);
    expect(legibleAgainst([0, 0, 0], hex("#d3d3d3"))).toEqual([0, 0, 0]);
  });
});

/** Every (ink, ground) pair drawn on a background, from raw SGR output. */
function inkOnGround(raw: string): Array<{ text: string; fg: Rgb; bg: Rgb }> {
  const out: Array<{ text: string; fg: Rgb; bg: Rgb }> = [];
  let fg: Rgb | null = null;
  let bg: Rgb | null = null;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  const flush = (text: string) => {
    if (fg && bg && text.trim()) out.push({ text, fg, bg });
  };
  for (const m of raw.matchAll(re)) {
    flush(raw.slice(last, m.index));
    last = m.index! + m[0].length;
    const p = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      if (p[i] === 0) fg = bg = null;
      else if (p[i] === 39) fg = null;
      else if (p[i] === 49) bg = null;
      else if ((p[i] === 38 || p[i] === 48) && p[i + 1] === 2) {
        const rgb = [p[i + 2]!, p[i + 3]!, p[i + 4]!] as Rgb;
        if (p[i] === 38) fg = rgb;
        else bg = rgb;
        i += 4;
      }
    }
  }
  flush(raw.slice(last));
  return out;
}

function inColour(theme: string, body: string): string {
  const ui = new URL("../../../packages/orchestrator/src/bin/ui", import.meta.url).href;
  const bin = new URL("../../../packages/orchestrator/src/bin", import.meta.url).href;
  const script = `
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    process.env.COLORTERM = "truecolor";
    process.env.TERM = "xterm-256color";
    delete process.env.NO_COLOR;
    const theme = await import("${ui}/theme.ts");
    theme.setTheme("${theme}");
    const { setTermWidthOverride } = await import("${ui}/render.ts");
    setTermWidthOverride(100);
    const { renderToolActivity } = await import("${ui}/activity.ts");
    const { renderUnifiedDiff } = await import("${bin}/diff-render.ts");
    ${body}
  `;
  const proc = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const out = proc.stdout.toString();
  if (!out.includes("\x1b[")) throw new Error(`no colour output: ${proc.stderr.toString()}`);
  return out;
}

const DIFF = [
  "@@ -1,3 +1,4 @@",
  " function parseArgs(argv) {",
  "-  const args = { command: null, json: false };",
  "+  const args = { command: null, json: false, version: false };",
  '+  const pkg = require("../package.json");',
].join("\n");

describe("ink on the diff bands, measured from what is drawn", () => {
  it("the light theme's blue added band: every token reads at AA", () => {
    const raw = inColour(
      "rune",
      `process.stdout.write(renderToolActivity({ toolName: "edit_file", args: { path: "src/cli.js" },
        result: JSON.stringify({ path: "src/cli.js", diff: ${JSON.stringify(DIFF)} }), success: true }));`,
    );
    const pairs = inkOnGround(raw);
    expect(pairs.length).toBeGreaterThan(3);
    const failing = pairs.filter((p) => contrastRatio(p.fg, p.bg) < BAND_MIN_CONTRAST);
    expect(failing.map((p) => `${p.text.trim()} ${contrastRatio(p.fg, p.bg).toFixed(2)}`)).toEqual(
      [],
    );
  });

  it("the dark theme's /diff: added and removed lines read at AA", () => {
    const raw = inColour(
      "rune-dark",
      `process.stdout.write(renderUnifiedDiff(${JSON.stringify(DIFF)}, "  ").text);`,
    );
    const pairs = inkOnGround(raw);
    expect(pairs.length).toBeGreaterThan(1);
    const failing = pairs.filter((p) => contrastRatio(p.fg, p.bg) < BAND_MIN_CONTRAST);
    expect(failing.map((p) => `${p.text.trim()} ${contrastRatio(p.fg, p.bg).toFixed(2)}`)).toEqual(
      [],
    );
  });
});
