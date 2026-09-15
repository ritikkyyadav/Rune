// ─── Every test run gets its own profile ───
//
// Preloaded by `bunfig.toml`'s `[test] preload`, so this runs BEFORE any module
// in any test file is evaluated — which is the whole point. `RUNE_HOME` is read
// at module load in several places, and by the native `rune-tools` binary at
// process start, so setting it inside a `beforeEach` is already too late.
//
// Why it exists: for the life of this programme every sandboxed `bash` from
// every rig, pty capture, SIGKILL harness and corpus run appended to the
// founder's own `~/.rune/audit.jsonl` — 2.9 MB of it — because `RUNE_HOME`
// could not relocate the crate's log (lane D, finding 18). The crate honours it
// now; the suites did not set it, and — see below — the ones that DID set it
// were not being obeyed either.
//
// A test that wants a specific home still wins: an inherited `RUNE_HOME` (or
// the pre-rename `GEAR_HOME`) is left exactly as it is, so a rig that builds
// its own profile and re-execs a child keeps working.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── The half of this that is not obvious ──
//
// Under Bun, a child spawned WITHOUT an explicit `env` inherits the environment
// this process was STARTED with, not the current contents of `process.env`.
// Measured here, both ways:
//
//   process.env.X = "v"; Bun.spawn(["sh","-c","echo $X"])            → ""
//   process.env.X = "v"; spawnSync("sh",["-c","echo $X"])            → ""
//   process.env.X = "v"; Bun.spawn([...], { env: {...process.env} }) → "v"
//
// So `process.env.RUNE_HOME = scratch` — which this file does, and which a
// dozen rigs in tests/integration already did before it — relocates the home
// for everything IN this process and for nothing it spawns. That is why those
// rigs still appended to the founder's log while asserting they had their own
// profile: the assertion was about a variable the child never saw.
//
// A preload cannot change the environment this process was started with. What
// it can do is make the default explicit: when a spawn is given no `env`, hand
// it the `process.env` of the moment. That is what Bun documents the default to
// be, it changes nothing for a caller that passes its own `env`, and it makes
// every existing `process.env.RUNE_HOME = …` rig mean what it says.
function inheritCurrentEnv(): void {
  const bun = globalThis as unknown as {
    Bun?: { spawn?: Function; spawnSync?: Function };
  };
  // `Bun.spawn(cmd, options)` and the single-object form `Bun.spawn({cmd, env})`.
  for (const name of ["spawn", "spawnSync"] as const) {
    const original = bun.Bun?.[name];
    if (typeof original !== "function") continue;
    bun.Bun![name] = function (this: unknown, ...args: unknown[]) {
      if (args.length === 1 && args[0] && !Array.isArray(args[0])) {
        const only = args[0] as Record<string, unknown>;
        if (only.env === undefined) only.env = { ...process.env };
      } else if (args.length >= 1) {
        const options = args[1] as Record<string, unknown> | undefined;
        if (options === undefined) args[1] = { env: { ...process.env } };
        else if (options.env === undefined) options.env = { ...process.env };
      }
      return (original as Function).apply(this, args);
    };
  }

  // node:child_process — `spawn(cmd, args?, options?)`, so the options are at
  // index 1 or 2 depending on whether the argv array was given.
  const cp = require("node:child_process") as Record<string, Function>;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
    const original = cp[name];
    if (typeof original !== "function") continue;
    cp[name] = function (this: unknown, ...args: unknown[]) {
      const index = Array.isArray(args[1]) ? 2 : 1;
      const options = args[index] as Record<string, unknown> | undefined;
      if (options === undefined) args[index] = { env: { ...process.env } };
      else if (
        typeof options === "object" &&
        !Array.isArray(options) &&
        typeof options !== "function" &&
        options.env === undefined
      )
        options.env = { ...process.env };
      return (original as Function).apply(this, args);
    };
  }
}

const inherited = process.env.RUNE_HOME || process.env.GEAR_HOME;
if (!inherited) {
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "rune-test-home-"));
  process.env.RUNE_HOME = home;

  // Take the directory with us. `exit` covers a normal finish and an explicit
  // `process.exit`; a SIGKILLed runner leaves one temp directory behind, which
  // is the operating system's business and not worth a handler that could
  // itself fail a suite.
  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // A profile we cannot remove is not worth failing a test run over.
    }
  });
}

// Unconditional: a rig that sets its OWN scratch home mid-file needs this just
// as much as the default one above does, and it is what makes those rigs'
// existing assertions true.
inheritCurrentEnv();
