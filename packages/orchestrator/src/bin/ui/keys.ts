// ─── Raw-mode key parser ───
// Pure: turns a decoded stdin chunk into a list of key events. Bracketed-paste is
// surfaced as paste-start/paste-end markers so the controller can accumulate a
// paste that spans multiple chunks. Everything here is unit-testable.

export type Key =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "tab" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "ctrl"; name: string } // e.g. "c", "d", "l", "t"
  | { type: "esc" }
  | { type: "paste-start" }
  | { type: "paste-end" };

const CSI = "\x1b[";

// Recognised CSI escape sequences → key (the part after ESC[).
const CSI_KEYS: Record<string, Key> = {
  A: { type: "up" },
  B: { type: "down" },
  C: { type: "right" },
  D: { type: "left" },
  H: { type: "home" },
  F: { type: "end" },
  "1~": { type: "home" },
  "7~": { type: "home" },
  "4~": { type: "end" },
  "8~": { type: "end" },
  "3~": { type: "delete" },
  "200~": { type: "paste-start" },
  "201~": { type: "paste-end" },
};

function ctrlName(code: number): string {
  // 1..26 → a..z
  return String.fromCharCode(code + 96);
}

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    const code = data.charCodeAt(i);

    // ── ESC / CSI sequences ──
    if (ch === "\x1b") {
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
        const key = CSI_KEYS[body];
        if (key) {
          keys.push(key);
          i = j + 1;
          continue;
        }
        // Unknown CSI — skip it whole.
        i = j + 1;
        continue;
      }
      // Lone ESC (or ESC + non-CSI). If it's the last byte, it's Escape.
      if (i === data.length - 1) {
        keys.push({ type: "esc" });
        i++;
        continue;
      }
      // ESC followed by something we don't model — treat as Escape, continue.
      keys.push({ type: "esc" });
      i++;
      continue;
    }

    // ── Control bytes ──
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

    // ── Printable (handle astral/code-point chars) ──
    const cp = data.codePointAt(i)!;
    const chr = String.fromCodePoint(cp);
    keys.push({ type: "char", value: chr });
    i += chr.length;
  }
  return keys;
}
