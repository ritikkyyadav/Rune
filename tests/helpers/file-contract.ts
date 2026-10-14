// ─── The file contract, as one table both implementations must pass ───
//
// Rune edits files in two places: the Rust rune-tools binary (edit_file,
// write_file) and TypeScript (multi_edit, and apply_patch through the same
// matcher). Until 2026-10-14 they shared a design and its defects: a write left
// a 755 script at 600 (Rust) or 644 (TypeScript), a Latin-1 byte became
// U+FFFD, a CRLF file came back mixed, and an indentation-insensitive tier
// applied a Python edit that no longer parsed while reporting success
// (docs/evidence/rune-reliability-probes-20261014, probes P1–P6; Claude Code's
// Edit and Write refused or kept the file intact on the same inputs).
//
// Each case below is a file on disk and one edit. The Rust runner
// (tests/integration/file-contract.test.ts) sends it to `rune-tools edit-file`;
// the TypeScript runner (tests/unit/tool-registry/file-contract.test.ts) sends
// it to multi_edit. Both must leave exactly `after` (bytes and mode) or refuse
// with the file untouched, so the twins cannot drift apart again.

export type FileExpectation =
  | { applied: true; after: Buffer; mode?: number; strategy?: "exact" | "line-endings" }
  | { applied: false; error: RegExp };

export interface FileCase {
  name: string;
  before: Buffer;
  /** POSIX permission bits to give the file first; checked again afterwards. */
  mode?: number;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  expect: FileExpectation;
}

const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export const FILE_CASES: FileCase[] = [
  {
    name: "an exact edit applies",
    before: utf8("a = 1\nb = 2\n"),
    oldText: "a = 1",
    newText: "a = 2",
    expect: { applied: true, after: utf8("a = 2\nb = 2\n"), strategy: "exact" },
  },
  {
    name: "P1: an edit keeps an executable's mode",
    before: utf8("#!/bin/sh\necho hi\n"),
    mode: 0o755,
    oldText: "echo hi",
    newText: "echo bye",
    expect: { applied: true, after: utf8("#!/bin/sh\necho bye\n"), mode: 0o755 },
  },
  {
    name: "an edit keeps a read-only mode read-only",
    before: utf8("locked = true\n"),
    mode: 0o444,
    oldText: "true",
    newText: "false",
    expect: { applied: true, after: utf8("locked = false\n"), mode: 0o444 },
  },
  {
    name: "P4: a file that is not UTF-8 is refused byte for byte",
    before: Buffer.from("# caf\xe9 latin-1 comment\nx = 1\n", "latin1"),
    oldText: "x = 1",
    newText: "x = 2",
    expect: {
      applied: false,
      error: /is not valid UTF-8 \(the first undecodable byte is at offset 5, line 1\)/,
    },
  },
  {
    name: "a UTF-16 file is refused and named",
    before: Buffer.from([0xff, 0xfe, 0x78, 0x00, 0x0a, 0x00]),
    oldText: "x",
    newText: "y",
    expect: { applied: false, error: /is UTF-16 text/ },
  },
  {
    name: "P5: a CRLF file stays CRLF when old_text uses LF",
    before: utf8("a = 1\r\nb = 2\r\nc = 3\r\n"),
    oldText: "a = 1\nb = 2",
    newText: "a = 10\nb = 20",
    expect: {
      applied: true,
      after: utf8("a = 10\r\nb = 20\r\nc = 3\r\n"),
      strategy: "line-endings",
    },
  },
  {
    name: "a one-line match in a CRLF file writes its new lines as CRLF",
    before: utf8("a\r\nb\r\n"),
    oldText: "a",
    newText: "a\nx",
    expect: { applied: true, after: utf8("a\r\nx\r\nb\r\n"), strategy: "exact" },
  },
  {
    name: "a mixed file keeps its mix outside the edit",
    before: utf8("a\nb\r\nc\nd\n"),
    oldText: "b\nc",
    newText: "B\nC",
    expect: { applied: true, after: utf8("a\nB\r\nC\nd\n"), strategy: "line-endings" },
  },
  {
    name: "a UTF-8 byte-order mark is kept",
    before: Buffer.concat([BOM, utf8("int x = 1;\n")]),
    oldText: "x = 1",
    newText: "x = 2",
    expect: { applied: true, after: Buffer.concat([BOM, utf8("int x = 2;\n")]) },
  },
  {
    name: "P6: indentation drift is refused and described",
    before: utf8("def f():\n    if x:\n        return 1\n    return 0\n"),
    oldText: "if x:\n    return 1",
    newText: "if x:\n    log()\n    return 1",
    expect: {
      applied: false,
      error:
        /Lines 2–3 match it once indentation is ignored: line 2 is indented with 4 spaces in the file and no indentation in old_text/,
    },
  },
  {
    name: "trailing-whitespace drift is refused and located",
    before: utf8("fn main() {  \n    let x = 1;\t\n}\n"),
    oldText: "fn main() {\n    let x = 1;\n}",
    newText: "fn main() {\n    let x = 2;\n}",
    expect: {
      applied: false,
      error: /Lines 1–3 match it once trailing whitespace is ignored/,
    },
  },
  {
    name: "an ambiguous match is refused",
    before: utf8("x x x\n"),
    oldText: "x",
    newText: "y",
    expect: { applied: false, error: /matches 3 times/ },
  },
  {
    name: "replace_all replaces every occurrence",
    before: utf8("x x x\n"),
    oldText: "x",
    newText: "y",
    replaceAll: true,
    expect: { applied: true, after: utf8("y y y\n") },
  },
  {
    name: "a miss with a matching first line points at it",
    before: utf8("const a = 1;\nconst b = 2;\n"),
    oldText: "const a = 1;\nconst c = 3;",
    newText: "x",
    expect: { applied: false, error: /first line appears at line 1/ },
  },
  {
    name: "a miss with nothing near says to re-read",
    before: utf8("actual content\n"),
    oldText: "does not exist",
    newText: "x",
    expect: { applied: false, error: /not found .*re-read the region/ },
  },
];
