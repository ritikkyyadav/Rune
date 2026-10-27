// --- Composer text editing ---
// Pure: where the caret lands and what a deletion removes, measured in
// user-perceived characters (grapheme clusters) rather than UTF-16 code units.
//
// The composer used to step one code unit at a time, so a single Backspace
// after an emoji removed half of its surrogate pair and left a broken
// character (U+FFFD on screen) -- which was then sent to the model with the
// rest of the message. Every caret move and deletion goes through here so
// that cannot happen, and so the word keys (Option+arrows, Option+Backspace,
// ctrl+w) mean what they mean in a shell.

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Letters, digits, combining marks and `_`: what readline's word moves skip. */
const WORD = /[\p{L}\p{N}\p{M}_]/u;
/** Anything that is not whitespace: what `ctrl+w` (unix-word-rubout) deletes. */
const NON_SPACE = /\S/u;

export interface Edit {
  text: string;
  caret: number;
}

/** Every grapheme boundary in `text`, ascending, from 0 to text.length. */
export function boundaries(text: string): number[] {
  const out = [0];
  for (const part of graphemes.segment(text)) out.push(part.index + part.segment.length);
  return out;
}

/** The boundary before `caret` (0 at the start). */
export function prevBoundary(text: string, caret: number, marks = boundaries(text)): number {
  let prev = 0;
  for (const b of marks) {
    if (b >= caret) break;
    prev = b;
  }
  return prev;
}

/** The boundary after `caret` (text.length at the end). */
export function nextBoundary(text: string, caret: number, marks = boundaries(text)): number {
  for (const b of marks) if (b > caret) return b;
  return text.length;
}

function moveLeft(text: string, caret: number, isWord: RegExp): number {
  const marks = boundaries(text);
  let i = Math.min(caret, text.length);
  // First the gap (spaces, punctuation), then the word itself.
  while (i > 0) {
    const p = prevBoundary(text, i, marks);
    if (isWord.test(text.slice(p, i))) break;
    i = p;
  }
  while (i > 0) {
    const p = prevBoundary(text, i, marks);
    if (!isWord.test(text.slice(p, i))) break;
    i = p;
  }
  return i;
}

function moveRight(text: string, caret: number, isWord: RegExp): number {
  const marks = boundaries(text);
  let i = Math.max(0, caret);
  while (i < text.length) {
    const n = nextBoundary(text, i, marks);
    if (isWord.test(text.slice(i, n))) break;
    i = n;
  }
  while (i < text.length) {
    const n = nextBoundary(text, i, marks);
    if (!isWord.test(text.slice(i, n))) break;
    i = n;
  }
  return i;
}

/** Option+left / `M-b`: to the start of this word, or the previous one. */
export function wordLeft(text: string, caret: number): number {
  return moveLeft(text, caret, WORD);
}

/** Option+right / `M-f`: to the end of this word, or the next one. */
export function wordRight(text: string, caret: number): number {
  return moveRight(text, caret, WORD);
}

function cut(text: string, from: number, to: number): Edit {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(text.length, Math.max(from, to));
  return { text: text.slice(0, a) + text.slice(b), caret: a };
}

/** Backspace: one character back, whole. */
export function deleteBack(text: string, caret: number): Edit {
  if (caret <= 0) return { text, caret: 0 };
  return cut(text, prevBoundary(text, caret), caret);
}

/** Delete: one character forward, whole. */
export function deleteForward(text: string, caret: number): Edit {
  if (caret >= text.length) return { text, caret: text.length };
  return cut(text, caret, nextBoundary(text, caret));
}

/** Option+Backspace / `M-DEL`: back to the start of the word. */
export function deleteWordBack(text: string, caret: number): Edit {
  return cut(text, wordLeft(text, caret), caret);
}

/** `M-d`, Option+Delete: forward to the end of the word. */
export function deleteWordForward(text: string, caret: number): Edit {
  return cut(text, caret, wordRight(text, caret));
}

/** `ctrl+w`: back to the previous whitespace, as in every shell. */
export function deleteSpaceWordBack(text: string, caret: number): Edit {
  return cut(text, moveLeft(text, caret, NON_SPACE), caret);
}
