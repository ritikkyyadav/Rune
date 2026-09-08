// --- Raw-mode key parser ---
// Pure: turns a decoded stdin chunk into a list of key events. Bracketed-paste is
// surfaced as paste-start/paste-end markers so the controller can accumulate a
// paste that spans multiple chunks. Everything here is unit-testable.

export type Key =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "tab" }
  | { type: "shift-tab" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "wheel-up" }
  | { type: "wheel-down" }
  | { type: "click"; x: number; y: number } // 1-based cell, SGR left press only
  | { type: "ctrl"; name: string } // e.g. "c", "d", "l", "t"
  | { type: "esc" }
  | { type: "paste-start" }
  | { type: "paste-end" };

/**
 * The wheel, seen through the terminal's alternate-scroll mode (DEC 1007): a
 * notch or a trackpad flick lands as several identical arrow keys in ONE read
 * -- three per notch on most terminals, one per line on a trackpad. A finger
 * on a key never does that: key repeat delivers one arrow per read. So a chunk
 * that is nothing but two or more arrows all pointing one way is the wheel,
 * and the count is how far it turned. Returns +n for n ups, -n for n downs,
 * 0 for anything else (a lone arrow included -- that one is the keyboard's).
 */
export function arrowRun(keys: readonly Key[]): number {
  if (keys.length < 2) return 0;
  const first = keys[0]!.type;
  if (first !== "up" && first !== "down") return 0;
  for (const k of keys) if (k.type !== first) return 0;
  return first === "up" ? keys.length : -keys.length;
}

// SS3 finals -> key: the application-mode twins of the CSI arrows.
const SS3_KEYS: Record<string, Key> = {
  A: { type: "up" },
  B: { type: "down" },
  C: { type: "right" },
  D: { type: "left" },
  H: { type: "home" },
  F: { type: "end" },
};

const CSI = "\x1b[";

// Recognised CSI escape sequences -> key (the part after ESC[).
const CSI_KEYS: Record<string, Key> = {
  A: { type: "up" },
  B: { type: "down" },
  C: { type: "right" },
  D: { type: "left" },
  H: { type: "home" },
  F: { type: "end" },
  Z: { type: "shift-tab" }, // back-tab -- drives the permission-mode cycle
  "1~": { type: "home" },
  "7~": { type: "home" },
  "4~": { type: "end" },
  "8~": { type: "end" },
  "3~": { type: "delete" },
  "5~": { type: "pageup" },
  "6~": { type: "pagedown" },
  "200~": { type: "paste-start" },
  "201~": { type: "paste-end" },
};

function ctrlName(code: number): string {
  // 1..26 -> a..z
  return String.fromCharCode(code + 96);
}

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    const code = data.charCodeAt(i);

    // -- ESC / CSI sequences --
    if (ch === "\x1b") {
      // -- OSC replies (ESC ] ... BEL | ESC ] ... ESC \) --
      // The startup color probe (OSC 10/11) waits 120ms; a slower terminal's
      // reply lands here in the key stream instead. Parsing it as Esc + typed
      // junk both cancels whatever the user was doing and types "11;rgb:..."
      // into the composer -- so the whole sequence is consumed silently. An
      // unterminated OSC at the end of the chunk is swallowed too: the tail
      // of a split reply is worse as fake keystrokes than as a dropped reply.
      if (data[i + 1] === "]") {
        const bel = data.indexOf("\x07", i + 2);
        const st = data.indexOf("\x1b\\", i + 2);
        if (bel !== -1 && (st === -1 || bel < st)) {
          i = bel + 1;
        } else if (st !== -1) {
          i = st + 2;
        } else {
          i = data.length;
        }
        continue;
      }
      if (data.startsWith(CSI, i)) {
        // Read the CSI body: optional digits/; then a final byte.
        let j = i + 2;
        let body = "";
        while (j < data.length) {
          const c = data[j]!;
          body += c;
          // Final byte is a letter or '~'.
          if (/[A-Za-z~]/.test(c)) break;
          j++;
        }
        // -- Mouse --
        // SGR form (ESC [ < b ; x ; y M|m) when ?1006h is honoured; legacy X10
        // (ESC [ M b x y) otherwise. The wheel is surfaced (buttons 64/65, plus
        // modifier-shifted variants), and a PLAIN left press is surfaced with
        // its cell -- it opens and closes folds in the transcript. Everything
        // else -- releases, drags, right/middle, modifier-clicks (the host's
        // own selection gestures) -- is consumed silently so the coordinate
        // bytes never leak into the input as stray characters.
        if (body.charCodeAt(0) === 0x3c /* '<' */) {
          const parts = body.slice(1, -1).split(";");
          const btn = parseInt(parts[0] ?? "", 10);
          if (Number.isFinite(btn) && (btn & 0x40) !== 0) {
            keys.push((btn & 1) === 0 ? { type: "wheel-up" } : { type: "wheel-down" });
          } else if (btn === 0 && body.endsWith("M")) {
            const x = parseInt(parts[1] ?? "", 10);
            const y = parseInt(parts[2] ?? "", 10);
            if (Number.isFinite(x) && Number.isFinite(y)) keys.push({ type: "click", x, y });
          }
          i = j + 1;
          continue;
        }
        if (body === "M") {
          const btn = (data.charCodeAt(j + 1) || 32) - 32;
          if ((btn & 0x40) !== 0) {
            keys.push((btn & 1) === 0 ? { type: "wheel-up" } : { type: "wheel-down" });
          }
          i = j + 4; // ESC [ M is followed by three coordinate bytes
          continue;
        }

        const key = CSI_KEYS[body];
        if (key) {
          keys.push(key);
          i = j + 1;
          continue;
        }
        // Unknown CSI -- skip it whole.
        i = j + 1;
        continue;
      }
      // -- SS3 (ESC O x): the application-cursor form of the arrows/Home/End --
      // Warp sends the wheel this way under alternate-scroll mode (ESC O A per
      // line), and any terminal does once DECCKM is on. Unparsed, the ESC read
      // as Escape and "OA" was typed into the composer on every scroll notch.
      // F1-F4 (P Q R S) share the prefix and are consumed silently.
      if (data[i + 1] === "O" && i + 2 < data.length) {
        const fin = data[i + 2]!;
        const key = SS3_KEYS[fin];
        if (key) keys.push(key);
        if (key || "PQRS".includes(fin)) {
          i += 3;
          continue;
        }
      }
      // Lone ESC (or ESC + non-CSI). If it's the last byte, it's Escape.
      if (i === data.length - 1) {
        keys.push({ type: "esc" });
        i++;
        continue;
      }
      // ESC followed by something we don't model -- treat as Escape, continue.
      keys.push({ type: "esc" });
      i++;
      continue;
    }

    // -- Control bytes --
    if (ch === "\r" || ch === "\n") {
      keys.push({ type: "enter" });
      i++;
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      keys.push({ type: "backspace" });
      i++;
      continue;
    }
    if (ch === "\t") {
      keys.push({ type: "tab" });
      i++;
      continue;
    }
    if (code >= 1 && code <= 26) {
      keys.push({ type: "ctrl", name: ctrlName(code) });
      i++;
      continue;
    }
    if (code === 0 || code === 27) {
      i++;
      continue;
    }

    // -- Printable (handle astral/code-point chars) --
    const cp = data.codePointAt(i)!;
    const chr = String.fromCodePoint(cp);
    keys.push({ type: "char", value: chr });
    i += chr.length;
  }
  return keys;
}
