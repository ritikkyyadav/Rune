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

// ── No suite runs with a real provider key ──
//
// Bun loads a `.env` from the working directory into every `bun test` and
// `bun run`, and the checkout carried one for months (audit, 2026-09-16:
// GOOGLE, OPENROUTER and BRAVE keys). `RUNE_NO_ENV_FILE` guards the launcher's
// `~/.rune/.env`, not Bun's own autoload, so every unit, integration and mock
// eval run had live keys in its environment — one misrouted call away from
// spend, one careless dump away from a log. The keys are stripped here, before
// any module reads them. The live comparison series is the one caller that
// wants them, and it says so with `RUNE_EVAL_REAL=1`.
function scrubProviderKeys(): void {
  if (process.env.RUNE_EVAL_REAL === "1") return;
  const secretName = /(_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET_KEY)$/;
  for (const name of Object.keys(process.env)) {
    if (secretName.test(name) && name !== "RUNE_TEST_FAKE_API_KEY") delete process.env[name];
  }
}
scrubProviderKeys();

// ── A test's clock ──
//
// Bun gives every test, and every hook, five seconds unless it is told
// otherwise. Five seconds is a long time on the machine a test is written on
// and not on a shared CI runner, where starting a toolchain or `npm` cold can
// take that by itself. On 2026-10-07 two CI runs in a row were lost to that
// clock and to nothing else: a `go build` the verifier had given five seconds
// of its own, and the hook that packs the SDK.
//
// `bun test --timeout`, which the Windows job already passes for this reason,
// does not reach hooks: a six-second `beforeAll` still dies at five under
// `--timeout 30000` (measured on Bun 1.3.14 and 1.4.2). A default set here
// does reach them, and a file or a test that sets its own still wins.
//
// Raised, not removed: a test that hangs still fails, thirty seconds later.
// `require`, and guarded, because the eval runner preloads this file too and
// is not a test run.
try {
  (require("bun:test") as { setDefaultTimeout(ms: number): void }).setDefaultTimeout(30_000);
} catch {
  // Not under `bun test`: there is no clock to set.
}
