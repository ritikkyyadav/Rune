/**
 * The suite must not leave engines running (P10.0).
 *
 * `rune serve`, `rune web` and `rune acp` each spawn one `engine-host` process
 * per session. Until the reaper landed, every run of the serve, ACP and action
 * tests left its hosts alive: 183 idle engines were counted on the developer's
 * machine one day and 120 more the next, and they made unrelated tests time out
 * at sixty seconds by starving the box.
 *
 * This file is the assertion that it stopped. It runs LAST (hence the name —
 * bun walks the directory in order) and looks for any `engine-host` process
 * whose command line names THIS checkout. Hosts from another worktree, or the
 * developer's own running `rune`, are none of its business and are not counted.
 *
 * It is deliberately an assertion and not a cleanup: a test that quietly killed
 * the leak it found would keep the suite green and the leak shipped.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(join(import.meta.dir, "..", ".."));
const HOST_SCRIPT = join(REPO_ROOT, "packages", "orchestrator", "src", "bin", "engine-host.ts");

/**
 * Every `engine-host` process spawned from this checkout, as `pid\tcommand`.
 *
 * `ps` and not a registry file: the registry is written by the supervisor, and
 * a supervisor that forgot a host is exactly the failure being looked for.
 */
export function leakedHosts(psOutput: string, hostScript: string): string[] {
  const out: string[] = [];
  for (const line of psOutput.split("\n")) {
    if (!line.includes("engine-host")) continue;
    // The host is `bun <repo>/…/engine-host.ts --socket …`. A packaged install
    // spells it `rune engine-host`, which no test starts, so the script path is
    // the honest discriminator and keeps other checkouts out of the count.
    if (!line.includes(hostScript)) continue;
    if (line.includes("zz-no-leaked-hosts")) continue; // never count the grep itself
    out.push(line.trim());
  }
  return out;
}

function psLines(): string | null {
  // Windows has no `ps`; the integration suite does not run there (ci.yml), and
  // a hard failure on a machine without it would be a false alarm rather than a
  // finding.
  const p = Bun.spawnSync(["ps", "-eo", "pid,ppid,command"], { stdout: "pipe", stderr: "pipe" });
  if (!p.success) return null;
  return p.stdout.toString();
}

describe("no engine-host survives the integration suite", () => {
  test("the pure filter counts only this checkout's hosts", () => {
    const sample = [
      "  501     1 bun /Users/x/Alan/packages/orchestrator/src/bin/engine-host.ts --socket /a.sock",
      "  502     1 bun /Users/x/OtherRepo/packages/orchestrator/src/bin/engine-host.ts --socket /b.sock",
      "  503     1 /usr/bin/rune chat",
    ].join("\n");
    const mine = "/Users/x/Alan/packages/orchestrator/src/bin/engine-host.ts";
    expect(leakedHosts(sample, mine)).toHaveLength(1);
    expect(leakedHosts(sample, mine)[0]).toContain("501");
  });

  // 30s, comfortably longer than the retry loop below, so a real leak reports
  // the pids rather than a bare "timed out" that names nothing.
  test("nothing from this worktree is still running", async () => {
    // A host that was just SIGTERMed drains its round-trips before it exits,
    // so give the last test's teardown a moment before calling it a leak.
    let leaked: string[] = [];
    for (let i = 0; i < 24; i++) {
      const ps = psLines();
      if (ps === null) return; // no `ps` on this machine — nothing to assert
      leaked = leakedHosts(ps, HOST_SCRIPT);
      if (leaked.length === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(
      leaked,
      `engine-host processes survived the suite:\n${leaked.join("\n")}\n` +
        "Every test that starts a serve/acp/host must tear it down in afterEach/afterAll.",
    ).toEqual([]);
  }, 30_000);
});
