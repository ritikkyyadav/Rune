/**
 * The win32 path matcher, exercised where it is not compiled in.
 *
 * On Windows the bash tool runs through Git Bash, whose `rm` deletes
 * `"C:\Users\<name>\Documents"` exactly as written, and there is no OS sandbox
 * underneath to catch what the containment layer misses. The POSIX matcher
 * cannot see that spelling, so on the v1.2.0 CI run (36229814062, ts-windows)
 * three containment tests failed on Windows: a recursive delete of the home's
 * Documents, and writes into `.rune/config.toml` and `.rune/memory/entries`,
 * all named with a drive path — none of them caught.
 *
 * Downstream of extraction the checks use the native `path` module, whose
 * win32 build normalizes `C:\x/y`; extraction is the only half that was blind.
 * These tests pin what extraction must return, on any machine.
 */

import { describe, expect, test } from "bun:test";

import { pathCandidateRe } from "../../../packages/orchestrator/src/auto-containment";

function candidates(command: string, platform: NodeJS.Platform = "win32"): string[] {
  return [...command.matchAll(pathCandidateRe(platform))]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
}

const windowsShaped = (p: string) => /^[A-Za-z]:/.test(p) || p.startsWith("\\\\");

describe("the win32 matcher reads Windows absolute paths", () => {
  test("a drive path with either separator, quoted or bare", () => {
    expect(candidates(`rm -rf "C:\\Users\\runneradmin\\Documents"`)).toContain(
      "C:\\Users\\runneradmin\\Documents",
    );
    expect(candidates("rm -rf C:/Users/runneradmin/Documents")).toContain(
      "C:/Users/runneradmin/Documents",
    );
  });

  test("the three spellings the Windows CI run failed on", () => {
    expect(candidates(`rm -rf "C:\\Users\\runneradmin/Documents"`)).toContain(
      "C:\\Users\\runneradmin/Documents",
    );
    expect(
      candidates(`cp forged.json "C:\\Users\\runneradmin/.rune/memory/entries/abc123456789.json"`),
    ).toContain("C:\\Users\\runneradmin/.rune/memory/entries/abc123456789.json");
    expect(
      candidates(`perl -e 'open(F, ">", "C:\\Users\\runneradmin/.rune/config.toml")'`),
    ).toContain("C:\\Users\\runneradmin/.rune/config.toml");
  });

  test("a lower-case drive, and a bare drive root", () => {
    expect(candidates("rm -rf d:\\build")).toContain("d:\\build");
    expect(candidates("rm -rf 'C:\\'")).toContain("C:\\");
  });

  test("a UNC path", () => {
    expect(candidates("rm -rf '\\\\server\\share\\dir'")).toContain("\\\\server\\share\\dir");
  });

  test("a candidate stops where the shell would split it", () => {
    expect(candidates("rm -rf C:\\tmp\\x && echo done")).toContain("C:\\tmp\\x");
    expect(candidates("type C:\\a\\b.txt|more")).toContain("C:\\a\\b.txt");
    expect(candidates("rm -rf C:\\tmp\\x;ls")).toContain("C:\\tmp\\x");
  });

  test("nothing Windows-shaped comes out of a URL, a time, or a key:value", () => {
    for (const command of [
      "curl https://example.com/a",
      "echo 12:30",
      "git log --format=%H:%s",
      "echo a:b",
      "docker run -v data:/data img",
    ]) {
      expect({ command, windows: candidates(command).filter(windowsShaped) }).toEqual({
        command,
        windows: [],
      });
    }
  });
});

describe("POSIX is untouched", () => {
  test("the matcher adds nothing where C:\\x is a relative filename", () => {
    expect(pathCandidateRe("darwin").source).toBe(pathCandidateRe("linux").source);
    expect(candidates(`rm -rf "C:\\Users\\x\\Documents"`, "darwin").filter(windowsShaped)).toEqual(
      [],
    );
  });
});
