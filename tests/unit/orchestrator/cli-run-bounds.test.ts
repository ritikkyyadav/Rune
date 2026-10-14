/**
 * `--max-turns` and `--max-budget-usd` (R3.3 of
 * docs/program/rune-reliability-plan-20261014.md): the person's own bounds on
 * a run. A bad value is a usage error, exit 2, before anything runs — the
 * scratch home below has no provider key, so a run that got past the check
 * would end on the provider instead (exit 5), which is how a check on the
 * wrong path shows.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../../packages/orchestrator/src/bin/rune-cli.ts");
const home = mkdtempSync(join(tmpdir(), "rune-bounds-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function rune(...args: string[]): Promise<{ code: number; err: string; out: string }> {
  const p = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...process.env,
      HOME: home,
      RUNE_HOME: join(home, ".rune"),
      NO_COLOR: "1",
      RUNE_ASCII: "1",
      TERM: "dumb",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, err, out };
}

describe("rune -P with a bad bound", () => {
  test("--max-turns that is not a count exits 2, naming the flag", async () => {
    const r = await rune("-P", "say hi", "--max-turns", "abc");
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      '--max-turns takes a whole number of turns, or 0 for no ceiling (got "abc")',
    );
    expect(r.out).toBe("");
  });

  test("--max-budget-usd of zero exits 2, naming the flag", async () => {
    const r = await rune("-P", "say hi", "--max-budget-usd", "0");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--max-budget-usd takes an amount in dollars above zero");
  });
});

describe("rune --help", () => {
  test("lists both bounds", async () => {
    const r = await rune("--help");
    expect(r.out).toContain("--max-turns <n>");
    expect(r.out).toContain("--max-budget-usd <usd>");
  });
});
