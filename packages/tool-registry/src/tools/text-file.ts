// ─── The file contract every TypeScript write tool keeps ───
//
// The twin of crates/rune-tools/src/text_file.rs, for the tools that edit in
// TypeScript: multi_edit and apply_patch. Measured on 2026-10-14
// (docs/evidence/rune-reliability-probes-20261014): the file tools left the
// files they rewrote without their permission bits, wrote U+FFFD over every
// byte that was not UTF-8, mixed CRLF and LF in one file, and applied a
// mis-indented Python edit while reporting success. Claude Code's Edit and
// Write, given the same inputs, refused or kept the file intact. The rules:
//
//  - text is strict UTF-8, and a UTF-8 byte-order mark is kept when the file
//    has one; any other encoding is refused, never converted;
//  - a file's line-ending convention is detected, so an edit can keep it;
//  - matching is exact: the only conversion is line endings, and every
//    candidate is still a byte-exact match against the file;
//  - a miss says what nearly matched and why, instead of guessing;
//  - a write keeps the permission bits of the file it replaces, and every
//    write is atomic: temp file in the same directory, fsync, rename.
//
// tests/helpers/file-contract.ts is the one table both implementations pass.

import { randomBytes } from "crypto";
import { open, rename, unlink } from "fs/promises";

export type Eol = "lf" | "crlf";

export interface TextFile {
  /** The text, without the byte-order mark. */
  text: string;
  bom: boolean;
  eol: Eol;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function hasBom(raw: Uint8Array): boolean {
  return raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
}

/**
 * Offset of the first byte that does not begin a valid UTF-8 sequence, or -1.
 * The same rule as Rust's `Utf8Error::valid_up_to`: overlong forms,
 * surrogates and code points past U+10FFFF are invalid, as is a sequence cut
 * short by the end of the input.
 */
export function firstInvalidUtf8(b: Uint8Array): number {
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) {
      i += 1;
      continue;
    }
    let need: number;
    let cp: number;
    let min: number;
    if (c >= 0xc2 && c <= 0xdf) {
      need = 1;
      cp = c & 0x1f;
      min = 0x80;
    } else if (c >= 0xe0 && c <= 0xef) {
      need = 2;
      cp = c & 0x0f;
      min = 0x800;
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3;
      cp = c & 0x07;
      min = 0x10000;
    } else {
      return i;
    }
    // Cut short by the end of the input.
    if (i + need >= b.length) return i;
    for (let k = 1; k <= need; k++) {
      const cc = b[i + k];
      if ((cc & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += need + 1;
  }
  return -1;
}

/** Where a byte sequence stops being UTF-8. */
export interface NotUtf8 {
  /** Offset of the first byte that does not decode, from the start of the file. */
  offset: number;
  /** 1-based line of that byte. */
  line: number;
  /** The file opens with a UTF-16 byte-order mark. */
  utf16: boolean;
}

/** `null` when `raw` is UTF-8, with or without a UTF-8 byte-order mark. */
export function utf8Problem(raw: Uint8Array): NotUtf8 | null {
  const bom = hasBom(raw);
  const body = bom ? raw.subarray(3) : raw;
  const at = firstInvalidUtf8(body);
  if (at < 0) return null;
  let line = 1;
  for (let k = 0; k < at; k++) if (body[k] === 0x0a) line++;
  return {
    offset: at + (bom ? 3 : 0),
    line,
    utf16: (raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff),
  };
}

function cause(path: string, p: NotUtf8): string {
  return p.utf16
    ? `${path} is UTF-16 text (it opens with a UTF-16 byte-order mark), not UTF-8`
    : `${path} is not valid UTF-8 (the first undecodable byte is at offset ${p.offset}, ` +
        `line ${p.line}): it may use a legacy encoding such as Windows-1252, Shift-JIS or GBK, ` +
        "or be binary";
}

/** The refusal a writer returns, worded as the Rust tools word it. */
export function notUtf8Refusal(path: string, p: NotUtf8, tool: string): string {
  return (
    `${cause(path, p)}. ${tool} writes UTF-8 and never converts a file's encoding, so nothing ` +
    "was written. Make this change with a shell command that keeps the file's encoding, or ask " +
    "the user whether to convert the file to UTF-8."
  );
}

/** Decode a file for editing, or throw the refusal. `tool` names the caller in it. */
export function decodeText(raw: Uint8Array, path: string, tool: string): TextFile {
  const problem = utf8Problem(raw);
  if (problem) throw new Error(notUtf8Refusal(path, problem, tool));
  const bom = hasBom(raw);
  // Valid UTF-8 by now, so this conversion is lossless.
  const text = Buffer.from(bom ? raw.subarray(3) : raw).toString("utf8");
  return { text, bom, eol: detectEol(text) };
}

/** The convention most of the line breaks use; LF on a tie or with none at all. */
export function detectEol(text: string): Eol {
  let lf = 0;
  let crlf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    lf++;
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
  }
  return crlf > lf - crlf ? "crlf" : "lf";
}

/** `s` with every line break written in `eol`. */
export function toEol(s: string, eol: Eol): string {
  const lf = s.replace(/\r\n/g, "\n");
  return eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
}

/** The bytes to write for `text`, with the byte-order mark the file had. */
export function encodeText(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, "utf8");
  return bom ? Buffer.concat([BOM, body]) : body;
}

// ── Matching ──

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    count++;
  }
  return count;
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  if (i === -1) return haystack;
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

export type MatchStrategy = "exact" | "line-endings";

export interface ExactReplace {
  content: string;
  replacements: number;
  strategy: MatchStrategy;
}

/**
 * Find `oldText` in `content` byte for byte and replace it, or throw.
 *
 * `oldText` is tried as given, then with its line breaks in the file's
 * convention, then in the other one; the replacement takes the line endings of
 * the text it replaces, so a CRLF file stays CRLF and a mixed file keeps its
 * mix outside the edit. `where` names the file in a miss ("the file",
 * "src/a.ts").
 */
export function replaceExact(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  where: string,
): ExactReplace {
  if (oldText === "") throw new Error("old_text is empty: give the exact text to replace.");
  const eol = detectEol(content);
  const other: Eol = eol === "lf" ? "crlf" : "lf";
  const candidates: Array<[string, MatchStrategy]> = [[oldText, "exact"]];
  for (const convention of [eol, other]) {
    const converted = toEol(oldText, convention);
    if (!candidates.some(([c]) => c === converted)) candidates.push([converted, "line-endings"]);
  }

  for (const [needle, strategy] of candidates) {
    const count = countOccurrences(content, needle);
    if (count === 0) continue;
    if (count > 1 && !replaceAll) {
      throw new Error(
        `old_text matches ${count} times in ${where}. ` +
          "Add surrounding context to make it unique, or set replace_all.",
      );
    }
    const region: Eol = needle.includes("\r\n") ? "crlf" : needle.includes("\n") ? "lf" : eol;
    const replacement = toEol(newText, region);
    return {
      content: replaceAll
        ? content.split(needle).join(replacement)
        : replaceOnce(content, needle, replacement),
      replacements: replaceAll ? count : 1,
      strategy,
    };
  }
  throw new Error(missMessage(content, oldText, where));
}

const stripCr = (l: string): string => (l.endsWith("\r") ? l.slice(0, -1) : l);
const trimTrailing = (s: string): string => s.replace(/[ \t]+$/, "");
const trimBoth = (s: string): string => s.trim();

function findWindow(lines: string[], wanted: string[], norm: (s: string) => string): number {
  if (wanted.length === 0 || wanted.length > lines.length) return -1;
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < wanted.length; j++) {
      if (norm(lines[i + j]) !== norm(wanted[j])) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function describeIndent(line: string): string {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
  const tabs = [...lead].filter((c) => c === "\t").length;
  const spaces = lead.length - tabs;
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (tabs === 0 && spaces === 0) return "no indentation";
  if (tabs === 0) return plural(spaces, "space");
  if (spaces === 0) return plural(tabs, "tab");
  return `${plural(tabs, "tab")} and ${plural(spaces, "space")}`;
}

/**
 * Why `oldText` was not found, in terms the caller can act on: which lines
 * nearly matched and what differs. The Rust `miss_message` words it the same.
 */
export function missMessage(content: string, oldText: string, where: string): string {
  const lines = content.split("\n").map(stripCr);
  const wanted = oldText.split("\n").map(stripCr);
  if (wanted.length > 1 && wanted[wanted.length - 1] === "") wanted.pop();

  const ws = findWindow(lines, wanted, trimTrailing);
  if (ws >= 0) {
    return (
      `old_text not found in ${where}. Lines ${ws + 1}–${ws + wanted.length} match it once ` +
      "trailing whitespace is ignored: copy them exactly as read_file shows them, trailing " +
      "spaces and tabs included."
    );
  }
  const ind = findWindow(lines, wanted, trimBoth);
  if (ind >= 0) {
    for (let k = 0; k < wanted.length; k++) {
      const inFile = describeIndent(lines[ind + k]);
      const inOld = describeIndent(wanted[k]);
      if (inFile !== inOld) {
        return (
          `old_text not found in ${where}. Lines ${ind + 1}–${ind + wanted.length} match it ` +
          `once indentation is ignored: line ${ind + k + 1} is indented with ${inFile} in the ` +
          `file and ${inOld} in old_text. Send old_text and new_text with the file's own ` +
          "indentation; edits are never re-indented."
        );
      }
    }
  }
  const first = wanted.map((l) => l.trim()).find((l) => l !== "");
  if (first !== undefined) {
    const at = lines
      .map((l, i) => (l.trim() === first ? i + 1 : 0))
      .filter((n) => n > 0)
      .slice(0, 5);
    if (at.length > 0) {
      return (
        `old_text not found in ${where}. Its first line appears at line ${at.join(", ")}, but ` +
        "what follows differs: re-read that region and copy it exactly."
      );
    }
  }
  return (
    `old_text not found in ${where}. The file may have changed, or the text differs from what ` +
    "it holds: re-read the region you are editing and copy it exactly."
  );
}

// ── Writing ──

/**
 * Write `bytes` to `abs` atomically, keeping the permission bits of the file
 * it replaces. `mode` is the replaced file's `stat().mode`; leave it out for a
 * new file, which is then created with 0o666 under the process umask like any
 * other new file. A rename installs a new inode, and the old one's mode goes
 * with it unless it is copied across, which is how a `755` script came back
 * `644` from multi_edit and `600` from edit_file.
 */
export async function writeAtomic(abs: string, bytes: Uint8Array, mode?: number): Promise<void> {
  const tmp = `${abs}.rune-tmp-${randomBytes(6).toString("hex")}`;
  const fh = await open(tmp, "wx", 0o666);
  let ok = false;
  try {
    await fh.writeFile(bytes);
    await fh.sync();
    if (mode !== undefined && process.platform !== "win32") await fh.chmod(mode & 0o7777);
    ok = true;
  } finally {
    await fh.close();
    if (!ok) await unlink(tmp).catch(() => undefined);
  }
  try {
    await rename(tmp, abs);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** The note a write returns when the replaced file had other hard links. */
export function hardLinkNote(path: string, nlink: number): string | undefined {
  if (nlink <= 1) return undefined;
  return (
    `${path} had ${nlink} hard links: this write gave this path new content and left the ` +
    `other ${nlink - 1} link(s) with the old content.`
  );
}
