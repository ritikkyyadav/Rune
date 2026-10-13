/**
 * The environment a project's check is started with.
 *
 * A check is the project's, not the session's. The verifier used to hand a
 * check everything this process was started with, and for almost every
 * project that is harmless: nothing in a Go module reads `RUNE_DB_PATH`. It is
 * not harmless for a project that reads Rune's own variables — Rune's own
 * repository first of all, and anything that embeds the SDK or starts the CLI
 * in its tests — because those variables say where THIS session keeps its
 * database, its configuration and the person's saved sign-ins.
 *
 * Measured 2026-10-14, from the recorded serious-task runs (the fixture there
 * is Rune's repository at an earlier commit, and the comparison rig starts
 * Rune with `RUNE_HOME`, `RUNE_DB_PATH` and `RUNE_CONFIG_PATH` pointing at
 * the run's profile and the three credential paths pointing at the founder's
 * real files):
 *
 *   · the agent ran the project's whole unit suite in its own shell, which
 *     starts a command with a cleared environment: 5,002 tests, 52 s, green;
 *   · the end-of-turn check then ran the same suite on the same tree, with
 *     this process's environment: killed at 120 s, "nothing was measured".
 *     The profile's log holds two lines from it, 20 s apart, and then nothing;
 *   · the same tree, the same command, on the same machine outside any
 *     sandbox, with an empty Rune home and no state variables: 52.6 s, green.
 *
 * Six of nine recorded serious runs ended on that 120 s wait. It was read as
 * "a suite that cannot finish inside its limit"; the suite fits twice over.
 * What it could not do was finish while pointed at a live session.
 *
 * So a check is started with the session's environment LESS the session's own
 * state, and with an empty Rune home of its own:
 *
 *   · every variable that locates or unlocks this session's state is removed;
 *   · `RUNE_HOME` is an empty directory that goes when the session does, so a
 *     Rune started by a check finds no profile rather than the person's;
 *   · the credential and memory-key stores are the file ones, under that empty
 *     home — the OS keychain is not under any directory, and "tests never
 *     touch the real keychain" (credential-store.ts) should not depend on
 *     every project's tests remembering to say so.
 *
 * Nothing else is touched. `PATH`, the toolchain's own variables, a project's
 * `DATABASE_URL`, a provider key the person exported — a check sees those as
 * it always has. Whether a check should run with those at all, and outside the
 * sandbox the agent's own shell is held to, is a larger question than this
 * one and is not answered here.
 *
 * `parent-check.ts` already draws this line for the one check it replays
 * (`replayEnv`: "enough to run, and nothing that is a credential"). This is
 * the same line for the checks the verifier chooses, drawn as narrowly as it
 * can be without breaking a toolchain that needs its environment.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The variables that say where this session keeps its state, or unlock it.
 * Named one by one, not by prefix: a project of its own may well call
 * something `RUNE_…`, and that is the project's.
 *
 * `tests/unit/orchestrator/check-env.test.ts` reads the source for every
 * home-, path-, directory- and token-shaped variable Rune reads and fails if
 * one is in neither this list nor `NOT_SESSION_STATE` — a list like this one
 * is only as good as the day it was written, otherwise.
 */
export const SESSION_STATE_ENV: readonly string[] = [
  // The home, under each name it has had.
  "RUNE_HOME",
  "GEAR_HOME",
  "ALAN_HOME",
  // What is kept in it, each of which can also be pointed somewhere by name.
  "RUNE_DB_PATH",
  "RUNE_CONFIG_PATH",
  "RUNE_PREFS_PATH",
  "RUNE_MODEL_PATH",
  "RUNE_LOG_DIR",
  "RUNE_MEMORY_DIR",
  "RUNE_SYSTEM_MEMORY_PATH",
  // The person's saved sign-ins.
  "RUNE_CREDENTIALS_PATH",
  "RUNE_CREDENTIAL_INDEX_PATH",
  "RUNE_SECRETS_PATH",
  // The live session itself: its control socket, and the tokens that open it.
  "RUNE_SOCKET_PATH",
  "RUNE_SERVE_TOKEN",
  "RUNE_TELEMETRY_TOKEN",
];

/**
 * Variables of the same shape that are NOT the session's state, and why a
 * check keeps them.
 */
export const NOT_SESSION_STATE: Readonly<Record<string, string>> = {
  RUNE_SKILLS_DIR: "where the bundled skills are read from — part of the program, not of a session",
};

/** What a check's own Rune home is forced to, whatever the session chose. */
const CHECK_STORES: Readonly<Record<string, string>> = {
  RUNE_CREDENTIAL_BACKEND: "file",
  RUNE_MEMORY_KEY_BACKEND: "file",
};

const STATE_NAMES = new Set(SESSION_STATE_ENV);

/**
 * `base`, as a check should see it.
 *
 * `scratch` names a directory that belongs to this session's checks and is
 * removed with them; the check's Rune home is made inside it. It is asked for
 * only here, so a session that never runs a check never makes one.
 */
export function checkEnvironment(
  base: NodeJS.ProcessEnv,
  scratch: () => string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(base)) {
    // By upper-cased name: on Windows `Rune_Home` is the same variable, and a
    // copy of the environment no longer knows that.
    if (STATE_NAMES.has(name.toUpperCase())) continue;
    env[name] = value;
  }
  const home = join(scratch(), "rune-home");
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    // A home that could not be made is still not the person's: a Rune started
    // against a missing directory finds nothing, which is the point.
  }
  env.RUNE_HOME = home;
  for (const [name, value] of Object.entries(CHECK_STORES)) {
    for (const present of Object.keys(env)) {
      if (present !== name && present.toUpperCase() === name) delete env[present];
    }
    env[name] = value;
  }
  return env;
}
