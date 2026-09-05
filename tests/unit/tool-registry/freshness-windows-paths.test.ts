/**
 * The read-before-edit ledger, on Windows-shaped paths — from any OS.
 *
 * PR #4's `packaged-e2e (windows-latest)` was the first time anything had ever
 * executed the binary on Windows, and it failed at `edit_file` with "You must
 * read smoke.txt (read_file) before editing it" immediately after a `read_file`
 * of the same path. Two spellings of one file:
 *
 *   read_file echoed  \\?\C:\Users\runneradmin\AppData\Local\Temp\ws\smoke.txt
 *   edit_file looked up  C:\Users\RUNNER~1\AppData\Local\Temp\ws + "smoke.txt"
 *
 * — because `std::fs::canonicalize` on Windows returns a VERBATIM path and
 * `%TEMP%` hands out an 8.3 SHORT NAME. `path.win32.resolve` preserves both, so
 * the ledger held two entries for one file and the lookup missed.
 *
 * These run on every OS because the Windows branch was unreachable from the
 * machine the code is written on, which is the entire reason the defect lived
 * as long as it did. `platform` and `realpath` are injected; nothing here needs
 * a Windows kernel.
 */

import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";

import {
  ledgerKey,
  stripVerbatimPrefix,
} from "../../../packages/tool-registry/src/tools/freshness";

const WS = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\ws";
const SHORT_WS = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ws";

/**
 * A stand-in for `GetFinalPathNameByHandle`: expands the 8.3 short name and
 * drops the verbatim prefix, which is what the OS call does for a file that
 * exists. Anything it does not recognise it hands back, which is what a
 * runtime that cannot resolve the path does.
 */
const winRealpath = (p: string): string =>
  stripVerbatimPrefix(p).replace("\\RUNNER~1\\", "\\runneradmin\\");

/** A realpath that always fails — a file that does not exist yet. */
const failingRealpath = (): string => {
  throw new Error("ENOENT");
};

const key = (root: string, path: string, realpath = winRealpath): string =>
  ledgerKey(root, path, { platform: "win32", realpath });

describe("stripVerbatimPrefix", () => {
  test("unwraps a drive-rooted extended-length path", () => {
    expect(stripVerbatimPrefix("\\\\?\\C:\\Users\\me\\a.txt")).toBe("C:\\Users\\me\\a.txt");
  });

  test("unwraps the UNC form to its plain share path", () => {
    expect(stripVerbatimPrefix("\\\\?\\UNC\\server\\share\\a.txt")).toBe(
      "\\\\server\\share\\a.txt",
    );
  });

  test("leaves everything else alone", () => {
    expect(stripVerbatimPrefix("C:\\Users\\me\\a.txt")).toBe("C:\\Users\\me\\a.txt");
    expect(stripVerbatimPrefix("/usr/local/bin")).toBe("/usr/local/bin");
    expect(stripVerbatimPrefix("")).toBe("");
  });
});

describe("ledgerKey on Windows-shaped paths", () => {
  test("THE DEFECT: the executor's verbatim path and the workspace-relative one agree", () => {
    const echoed = `\\\\?\\${WS}\\smoke.txt`;
    expect(key(SHORT_WS, echoed)).toBe(key(SHORT_WS, "smoke.txt"));
  });

  test("a short-name workspace root and its long form agree", () => {
    expect(key(SHORT_WS, "smoke.txt")).toBe(key(WS, "smoke.txt"));
  });

  test("drive-letter case does not make a second entry", () => {
    expect(key(WS, "smoke.txt")).toBe(key(WS.replace("C:", "c:"), "smoke.txt"));
  });

  test("separators do not make a second entry", () => {
    expect(key(WS, "src/app.ts")).toBe(key(WS, "src\\app.ts"));
  });

  test("filename case does not make a second entry", () => {
    expect(key(WS, "src/App.ts")).toBe(key(WS, "src/app.ts"));
  });

  test("the key it settles on is plain, forward-slashed and folded", () => {
    expect(key(SHORT_WS, `\\\\?\\${WS}\\smoke.txt`)).toBe(
      "c:/users/runneradmin/appdata/local/temp/ws/smoke.txt",
    );
  });

  test("a file that does not exist yet still keys consistently", () => {
    // The first `write_file` of a path: realpath throws, and the resolved
    // string has to carry the same normalization or the write's own hash would
    // be filed under a key no later edit computes.
    expect(key(SHORT_WS, "new.ts", failingRealpath)).toBe(
      key(`\\\\?\\${SHORT_WS}`, "new.ts", failingRealpath),
    );
    expect(key(SHORT_WS, "new.ts", failingRealpath)).toBe(
      "c:/users/runner~1/appdata/local/temp/ws/new.ts",
    );
  });

  test("different files still get different keys", () => {
    expect(key(WS, "a.ts")).not.toBe(key(WS, "b.ts"));
    expect(key(WS, "src/a.ts")).not.toBe(key(WS, "test/a.ts"));
  });

  test("a UNC workspace works the same way", () => {
    const unc = "\\\\build01\\projects\\rune";
    expect(ledgerKey(unc, "src\\a.ts", { platform: "win32", realpath: stripVerbatimPrefix })).toBe(
      ledgerKey(`\\\\?\\UNC\\build01\\projects\\rune`, "src/a.ts", {
        platform: "win32",
        realpath: stripVerbatimPrefix,
      }),
    );
  });
});

describe("ledgerKey on POSIX is unchanged", () => {
  test("no case folding — two files that differ only in case stay distinct", () => {
    const k = (p: string) => ledgerKey("/ws", p, { platform: "linux", realpath: (x: string) => x });
    expect(k("src/App.ts")).not.toBe(k("src/app.ts"));
  });

  test("a backslash stays a filename character, not a separator", () => {
    // `a\b.ts` is one legal POSIX filename. Rewriting it to `a/b.ts` would key
    // two different files together, which is worse than the bug being fixed.
    const k = (p: string) => ledgerKey("/ws", p, { platform: "linux", realpath: (x: string) => x });
    expect(k("a\\b.ts")).toBe("/ws/a\\b.ts");
    expect(k("a\\b.ts")).not.toBe(k("a/b.ts"));
  });

  test("relative and absolute still agree, and symlinks still resolve", () => {
    const k = (p: string) => ledgerKey("/ws", p, { platform: "linux", realpath: (x) => x });
    expect(k("src/a.ts")).toBe(k("/ws/src/a.ts"));
    // The real resolver on this machine: /tmp is a symlink on macOS.
    const real = ledgerKey("/", realpathSync(process.cwd()), { realpath: realpathSync });
    expect(ledgerKey("/", process.cwd(), { realpath: realpathSync })).toBe(real);
  });
});
