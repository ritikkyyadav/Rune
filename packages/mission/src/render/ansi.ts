// ─── Gear · colour, spent where it is safe ───
// Two budgets that never meet, and they are emitted by different mechanisms on
// purpose.
//
// The **chrome** carries six semantic roles and every one of them is *state* —
// running, passed, failed, needs you. State has to survive NO_COLOR, a serial console
// and a colleague with deuteranopia, so it is carried by the glyph and the word, and
// colour is only an accelerant. Chrome is therefore mapped onto the terminal's **own
// sixteen colours**: the UI inherits whatever theme the user already chose, in light
// and dark alike. Truecolour is detected and then deliberately unused here — there is
// no information a sixth hue adds that the six roles do not already carry, and every
// extra hue collides with somebody's theme.
//
// **Syntax colour carries nothing.** A string is a string whether or not it is teal —
// you can see the quotes. It tells you something the text already told you, faster.
// That is the one place colour is pure speed and zero state, which is why it is safe
// to spend 24-bit there, and only there.

import { type Caps } from "./caps";
import { type CodeRole, type Role, type Row, layout } from "./row";

type RGB = [number, number, number];

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

// ─── chrome: the terminal's own sixteen ───

const CHROME_SGR: Record<string, string> = {
  dim: "2",
  accent: "36",
  ok: "32",
  warn: "33",
  danger: "31",
  strong: "1",
  reverse: "7",
};

// ─── code: the one place a hue may mean nothing ───

const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

export type CodePalette = Record<CodeRole, RGB>;

/** Violet for structure, teal for literal data, sand for numeric — none of which
 *  collides with the chrome's green, amber or clay. A green inside a code region is
 *  syntax; anywhere else it means something passed. */
export const CODE_DARK: CodePalette = {
  kw: hex("#A594CE"),
  str: hex("#7FB0A5"),
  num: hex("#C9A279"),
  cm: hex("#5D646C"),
  pu: hex("#79818A"),
  add: hex("#8FB77F"),
  del: hex("#C58B80"),
};

export const CODE_LIGHT: CodePalette = {
  kw: hex("#5B4A96"),
  str: hex("#2F6E62"),
  num: hex("#8A5A22"),
  cm: hex("#9AA2AA"),
  pu: hex("#7C848C"),
  add: hex("#3D6A34"),
  del: hex("#9B3D31"),
};

/** Nearest colour in the xterm 6×6×6 cube, for terminals that stop at 256. */
function to256([r, g, b]: RGB): number {
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

const codeSeq = (rgb: RGB, caps: Caps): string =>
  caps.colour === "truecolor"
    ? `${ESC}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
    : `${ESC}38;5;${to256(rgb)}m`;

export interface Screen {
  code: CodePalette;
  /**
   * The terminal's own background, from OSC 11. The row tint is a ~7% blend of *this*,
   * not of a colour we picked — a background is the fastest way to make a TUI look
   * broken on somebody else's theme. No answer means no tint, and nothing is lost:
   * the sign column was always the load-bearing part.
   */
  ground?: RGB;
}

const blend = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

function seqFor(role: Role | undefined, screen: Screen, caps: Caps): string {
  if (!role || caps.colour === "none") return "";
  const chrome = CHROME_SGR[role];
  if (chrome) return `${ESC}${chrome}m`;
  return codeSeq(screen.code[role as CodeRole], caps);
}

/**
 * One row, ready for stdout. Body text gets no SGR at all — the user's foreground
 * wins. No trailing whitespace, so the row survives a mouse drag.
 */
export function paintRow(row: Row, caps: Caps, screen: Screen): string {
  const spans = layout(row, caps);

  // The one background in the product, and it is optional and says so.
  const tint =
    caps.tint && caps.colour === "truecolor" && screen.ground && row.tint
      ? blend(screen.ground, screen.code[row.tint], 0.075)
      : undefined;
  const bg = tint ? `${ESC}48;2;${tint[0]};${tint[1]};${tint[2]}m` : "";

  let out = bg;
  for (const s of spans) {
    const seq = seqFor(s.c, screen, caps);
    out += seq ? seq + s.t + RESET + bg : s.t;
  }
  if (bg) out += RESET;
  // Trailing spaces before any closing SGR are noise in a copy-paste.
  return out.replace(/[ \t]+(?=(?:\x1b\[[0-9;]*m)*$)/, "");
}

export const paint = (rows: Array<Row | null>, caps: Caps, screen: Screen): string =>
  rows.map((r) => (r ? paintRow(r, caps, screen) : "")).join("\n");

/**
 * Ask the terminal what colour it actually is (OSC 11), so the row tint can be a
 * blend of *its* ground. Resolves to undefined on anything that does not answer
 * promptly — which is most of them, and is fine.
 */
export function queryGround(timeoutMs = 120): Promise<RGB | undefined> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const wasRaw = stdin.isRaw;

    const done = (value?: RGB) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      if (!wasRaw) stdin.setRawMode!(false);
      resolve(value);
    };

    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      // rgb:RRRR/GGGG/BBBB — sixteen bits per channel, of which we want the top eight.
      const m = /rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/i.exec(buf);
      if (m) {
        const scale = (v: string) => Math.round((parseInt(v, 16) / (16 ** v.length - 1)) * 255);
        done([scale(m[1]!), scale(m[2]!), scale(m[3]!)]);
      }
    };

    // A terminal that answers *after* the deadline would otherwise spill its reply
    // into the next thing rendered — the `rgb:…` string arrives on stdin and is
    // echoed. So the deadline stops us waiting, and a short drain swallows whatever
    // shows up late rather than letting it reach the screen.
    const timer = setTimeout(() => {
      const drain = () => {};
      stdin.on("data", drain);
      setTimeout(() => stdin.off("data", drain), 150).unref?.();
      done(undefined);
    }, timeoutMs);
    if (!wasRaw) stdin.setRawMode(true);
    stdin.on("data", onData);
    stdout.write("\x1b]11;?\x07");
  });
}

/** Which code palette to use, decided by the terminal's own ground when it will say. */
export function screenFor(ground?: RGB): Screen {
  if (!ground) return { code: CODE_DARK };
  const luma = (0.2126 * ground[0] + 0.7152 * ground[1] + 0.0722 * ground[2]) / 255;
  return { code: luma > 0.5 ? CODE_LIGHT : CODE_DARK, ground };
}
