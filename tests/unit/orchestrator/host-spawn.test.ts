/**
 * How a session host is spawned, decided once and tested both ways.
 *
 * This is the unit that would have caught P10.9a's second defect. Every gate
 * before it ran Rune from source with `bun`, where `join(import.meta.dir,
 * "engine-host.ts")` is a real file; from the compiled binary the same join
 * produces `/$bunfs/root/engine-host.ts`, every spawn died with "Module not
 * found", and the only trace was a line in `~/.rune/run/*.log`. So the
 * decision is a pure function of two inputs and both branches are asserted
 * here rather than discovered on a user's machine.
 */

import { describe, expect, test } from "bun:test";

import {
  currentContext,
  hostSpawnArgv,
  hostSpawnLabel,
  isBunfsPath,
  isCompiled,
} from "../../../packages/orchestrator/src/bin/host-spawn";

const SOURCE = {
  moduleDir: "/home/dev/Alan/packages/orchestrator/src/bin",
  execPath: "/home/dev/.bun/bin/bun",
};
const COMPILED = { moduleDir: "/$bunfs/root", execPath: "/usr/local/bin/rune" };
const COMPILED_WIN = { moduleDir: "B:\\~BUN\\root", execPath: "C:\\Users\\dev\\rune.exe" };

describe("isBunfsPath", () => {
  test("recognises the POSIX virtual root", () => {
    expect(isBunfsPath("/$bunfs/root")).toBe(true);
    expect(isBunfsPath("/$bunfs/root/engine-host.ts")).toBe(true);
  });

  test("recognises the Windows virtual drive, either case", () => {
    expect(isBunfsPath("B:\\~BUN\\root")).toBe(true);
    expect(isBunfsPath("b:\\~bun\\root\\bin")).toBe(true);
  });

  test("a real checkout is not virtual", () => {
    expect(isBunfsPath("/home/dev/Alan/packages/orchestrator/src/bin")).toBe(false);
    expect(isBunfsPath("C:\\Users\\dev\\Rune\\packages")).toBe(false);
    // Not a prefix match on a directory that merely contains the word.
    expect(isBunfsPath("/home/dev/bunfs/root")).toBe(false);
  });
});

describe("isCompiled", () => {
  test("source run", () => {
    expect(isCompiled(SOURCE)).toBe(false);
  });

  test("compiled binary, both platforms", () => {
    expect(isCompiled(COMPILED)).toBe(true);
    expect(isCompiled(COMPILED_WIN)).toBe(true);
  });

  test("the module's own location decides, not the executable's name", () => {
    // A `bun` renamed to `rune` on PATH is still a source run: the source is
    // on disk, so `bun engine-host.ts` is correct and re-entering the binary
    // would be wrong.
    expect(isCompiled({ moduleDir: SOURCE.moduleDir, execPath: "/usr/local/bin/rune" })).toBe(
      false,
    );
  });
});

describe("hostSpawnArgv", () => {
  test("from source: bun runs the script on disk", () => {
    expect(hostSpawnArgv(SOURCE, ["--socket", "/tmp/a.sock"])).toEqual([
      "bun",
      "/home/dev/Alan/packages/orchestrator/src/bin/engine-host.ts",
      "--socket",
      "/tmp/a.sock",
    ]);
  });

  test("compiled: the binary re-enters itself through the subcommand", () => {
    expect(hostSpawnArgv(COMPILED, ["--socket", "/tmp/a.sock"])).toEqual([
      "/usr/local/bin/rune",
      "engine-host",
      "--socket",
      "/tmp/a.sock",
    ]);
  });

  test("compiled: never a path inside the virtual filesystem", () => {
    const argv = hostSpawnArgv(COMPILED, ["--socket", "/tmp/a.sock"]);
    expect(argv.some((a) => a.includes("$bunfs"))).toBe(false);
    expect(argv.some((a) => a.endsWith("engine-host.ts"))).toBe(false);
  });

  test("the host's own arguments pass through untouched, in order, both ways", () => {
    const args = ["--socket", "/tmp/a.sock", "--parent-pid", "4242"];
    // engine-host.ts reads these by name off process.argv, so the extra
    // leading `engine-host` word in the compiled shape is invisible to it.
    expect(hostSpawnArgv(SOURCE, args).slice(-4)).toEqual(args);
    expect(hostSpawnArgv(COMPILED, args).slice(-4)).toEqual(args);
  });

  test("no arguments is still a valid spawn (stdio mode)", () => {
    expect(hostSpawnArgv(COMPILED, [])).toEqual(["/usr/local/bin/rune", "engine-host"]);
  });
});

describe("hostSpawnLabel", () => {
  test("names what the banner will show", () => {
    expect(hostSpawnLabel(COMPILED)).toBe("/usr/local/bin/rune engine-host");
    expect(hostSpawnLabel(SOURCE)).toContain("engine-host.ts");
  });
});

describe("currentContext", () => {
  test("takes the caller's directory and this process's executable", () => {
    const ctx = currentContext("/somewhere/bin");
    expect(ctx.moduleDir).toBe("/somewhere/bin");
    expect(ctx.execPath).toBe(process.execPath);
  });

  test("this test process is a source run, and says so", () => {
    expect(isCompiled(currentContext(import.meta.dir))).toBe(false);
  });
});
