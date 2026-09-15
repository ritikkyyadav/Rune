/**
 * The installed launcher's credentials follow `RUNE_HOME` (V8 finding 14).
 *
 * `scripts/install.sh` wrote `RUNE_ENV="$HOME/.rune/.env"` into the launcher and
 * sourced it with `set -a`, unconditionally, with no reference to `RUNE_HOME`.
 * The capture rigs' stated guarantee — "every provider key in the parent
 * environment is scrubbed from the child, by SHAPE" — was undone one line
 * later, because the launcher re-imported the keys from disk after the scrub
 * had run. Observed live: `/keys` on the installed binary under a scratch
 * `RUNE_HOME` showed two real provider keys marked as coming from `env`. Every
 * rig in that programme that drove the installed binary ran with live billable
 * credentials present. Nothing was spent — the profiles pinned a loopback
 * provider — but the isolation those rigs document did not exist.
 *
 * Promoted from `tests/verification/v8-ui-installed-launcher-env-leak.test.ts`,
 * and extended: the template's TEXT is asserted here, and the precedence it
 * encodes is executed in a real `bash` below, because a shell rule that is only
 * read is the kind this programme has found four of.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const INSTALL_SH = readFileSync(
  join(resolve(import.meta.dir, "..", "..", ".."), "scripts", "install.sh"),
  "utf8",
);

/** The launcher the installer writes: the body of its quoted heredoc. */
function launcherTemplate(): string {
  const start = INSTALL_SH.indexOf("<<'WRAPPER'");
  const end = INSTALL_SH.indexOf("\nWRAPPER\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return INSTALL_SH.slice(INSTALL_SH.indexOf("\n", start) + 1, end);
}

/** The launcher's env-file rules, run in a real shell, reporting their answer. */
function resolvedEnvFile(env: Record<string, string>, argv: string[] = []): string {
  const template = launcherTemplate();
  const from = template.indexOf('RUNE_ENV="');
  const to = template.indexOf("\nfi\n", from);
  const script = `${template.slice(from, to + 4)}\nprintf '%s' "\${RUNE_ENV:-}"\n`;
  const out = spawnSync("bash", ["-c", script, "probe", ...argv], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  expect(out.status).toBe(0);
  return out.stdout;
}

describe("the installed launcher's env file", () => {
  test("the template names RUNE_HOME, and sources at most one file", () => {
    const template = launcherTemplate();
    const assignment = template.split("\n").find((l) => l.trimStart().startsWith("RUNE_ENV="));
    expect(assignment).toBeDefined();
    expect(assignment).toContain("RUNE_HOME");
    // The precedence is documented where the rule is, not only in a report.
    expect(template).toContain("Precedence");
    // And it is guarded: the old line sourced whatever it found, always.
    expect(template).toContain('if [ -n "$RUNE_ENV" ] && [ -f "$RUNE_ENV" ]; then');
  });

  test("RUNE_HOME moves the env file off the founder's profile", () => {
    expect(resolvedEnvFile({ HOME: "/founder" })).toBe("/founder/.rune/.env");
    expect(resolvedEnvFile({ HOME: "/founder", RUNE_HOME: "/scratch/rig" })).toBe(
      "/scratch/rig/.env",
    );
    // The point of the finding: the founder's file is not reachable from a rig.
    expect(resolvedEnvFile({ HOME: "/founder", RUNE_HOME: "/scratch/rig" })).not.toContain(
      "/founder",
    );
  });

  test("a pristine run sources nothing at all", () => {
    expect(resolvedEnvFile({ HOME: "/founder" }, ["--pristine"])).toBe("");
    expect(resolvedEnvFile({ HOME: "/founder", RUNE_HOME: "/scratch" }, ["--pristine"])).toBe("");
    expect(resolvedEnvFile({ HOME: "/founder", RUNE_NO_ENV_FILE: "1" })).toBe("");
    // A flag that merely CONTAINS the word is not the flag.
    expect(resolvedEnvFile({ HOME: "/founder" }, ["--pristine-ish"])).toBe("/founder/.rune/.env");
  });
});
