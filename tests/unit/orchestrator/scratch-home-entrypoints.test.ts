/**
 * Every entrypoint that runs a suite runs it under a scratch home.
 *
 * Promoted from `tests/verification/v8-home-subdir-preload.test.ts` (finding 26)
 * and `v8-home-eval-script-preload.test.ts` (finding 27).
 *
 * `77c2ff3` put `[test] preload = ["./tests/scratch-home.ts"]` in the repo
 * root's `bunfig.toml` and the record read "every suite runs under a scratch
 * home". Bun reads `bunfig.toml` from the CURRENT WORKING DIRECTORY and does
 * not walk up, so that held only for a `bun test` launched from the root.
 * `bun run test:packages` is `turbo test`, and turbo runs each package's script
 * with cwd = that package — seven scripts pointing back at the same
 * `tests/unit/*` files with `RUNE_HOME` unset, plus `tests/eval`'s own
 * `corpus:sanity`. Measured with cwd the only variable: root → a scratch home;
 * `packages/shared` → null; `tests/eval` → null.
 *
 * `82b614b` gave `eval`, `eval:auto-safety` and `corpus:offline` an explicit
 * `--preload`; `bench` and `bench:mock` — the same `package.json`, the same
 * entrypoint — were left out, and `bench:mock` measurably wrote 2 audit lines
 * per run into the home it found.
 *
 * The rule both commits chose, asserted for every script rather than for the
 * ones that were remembered: if it runs a suite or an eval entrypoint, it
 * carries the preload.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const PRELOAD = /--preload\s+\S*scratch-home\.ts/;

type Scripts = Record<string, string>;
const scriptsOf = (relative: string): Scripts =>
  (JSON.parse(readFileSync(join(ROOT, relative), "utf8")) as { scripts?: Scripts }).scripts ?? {};

describe("the scratch-home preload reaches every entrypoint", () => {
  test("every package's `test` script carries it — turbo runs them from their own directory", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(join(ROOT, "packages"))) {
      let scripts: Scripts;
      try {
        scripts = scriptsOf(join("packages", name, "package.json"));
      } catch {
        continue;
      }
      const command = scripts.test;
      if (!command || !command.startsWith("bun test ")) continue;
      if (!PRELOAD.test(command)) offenders.push(`${name}: ${command}`);
    }
    expect(offenders).toEqual([]);
  });

  test("no eval entrypoint runs without it — `bench` and `bench:mock` included", () => {
    const evalScripts = (scripts: Scripts) =>
      Object.entries(scripts).filter(
        ([, command]) =>
          /(^|[\s/])(tests\/eval|corpus)\//.test(command) || /runner\.ts/.test(command),
      );
    for (const file of ["package.json", "tests/eval/package.json"]) {
      const offenders = evalScripts(scriptsOf(file))
        .filter(([, command]) => !PRELOAD.test(command))
        .map(([name, command]) => `${file} ${name}: ${command}`);
      expect(offenders).toEqual([]);
    }
  });

  test("`corpus:sanity` runs from tests/eval, so it carries it too", () => {
    expect(scriptsOf("tests/eval/package.json")["corpus:sanity"]).toMatch(PRELOAD);
  });
});

describe("the preload actually takes effect from a package directory", () => {
  /**
   * Spawn `bun test` from `cwd` with no home override — the state CI and a
   * developer are in before the preload runs. The environment is built
   * explicitly because `tests/scratch-home.ts` (preloaded into THIS process)
   * hands an env-less spawn a copy of `process.env`, which already carries this
   * run's own `RUNE_HOME`.
   */
  function homeSeenBy(cwd: string, preload: string): string {
    const scratch = mkdtempSync(join(tmpdir(), "home-entrypoint-"));
    const probe = join(scratch, "probe.test.ts");
    writeFileSync(
      probe,
      [
        'import { test } from "bun:test";',
        'test("report the home", () => {',
        '  console.log("PROBE_RUNE_HOME=" + (process.env.RUNE_HOME ?? "<unset>"));',
        "});",
        "",
      ].join("\n"),
    );
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k === "RUNE_HOME" || k === "GEAR_HOME") continue;
        if (typeof v === "string") env[k] = v;
      }
      const out = spawnSync("bun", ["test", "--preload", preload, probe], {
        cwd,
        env,
        encoding: "utf8",
      });
      return /PROBE_RUNE_HOME=(.*)/.exec(`${out.stdout}${out.stderr}`)?.[1]?.trim() ?? "<no probe>";
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  test("a package suite and tests/eval both come up under a scratch home", () => {
    const fromPackage = homeSeenBy(join(ROOT, "packages", "shared"), "../../tests/scratch-home.ts");
    expect(fromPackage).not.toBe("<unset>");
    expect(fromPackage).toContain("rune-test-home-");
    const fromEval = homeSeenBy(join(ROOT, "tests", "eval"), "../scratch-home.ts");
    expect(fromEval).not.toBe("<unset>");
    expect(fromEval).toContain("rune-test-home-");
  }, 120_000);
});

describe("eval:auto-safety does not spend unless it is asked to (V8 finding 28)", () => {
  test("offline is the default and --live is the opt-in", () => {
    const source = readFileSync(join(ROOT, "tests", "eval", "auto-mode-safety.ts"), "utf8");
    // `offline` defaulted to false, so the bare script resolved keychain/OAuth
    // credentials, defaulted to `anthropic` and ran at 250 requests. The record
    // cited its numbers without recording `--offline`, so anyone re-running the
    // cited command verbatim on this machine spent money.
    expect(source).not.toContain('offline: flag("offline"),');
    expect(source).toContain('offline: !flag("live") || flag("offline")');
    // The live branch still exists, still guarded by a credential refusal.
    expect(source).toContain("if (!opts.offline)");
  });
});
