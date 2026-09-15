/**
 * The sandbox audit log follows `RUNE_HOME`.
 *
 * Every rig, capture script and verification pass in this program sets
 * `RUNE_HOME` to a scratch profile and then reports that the founder's
 * `~/.rune` was not touched. The native side ignored the variable —
 * `SandboxConfig::default()` built the log path from `dirs::home_dir()` — so
 * every sandboxed `bash` call ever made by a test run appended to the
 * founder's real `~/.rune/audit.jsonl`, a 2.9 MB file whose tail is the
 * accumulated receipts of every corpus run, pty capture and SIGKILL rig.
 *
 * The check everyone performed was `rune.db`'s cost rows, which is not a
 * fingerprint of `~/.rune`. This test is the fingerprint: the scratch home
 * gets the receipt, and the real one is byte-identical afterwards.
 *
 * End to end through the real binary, because the defect lived in the binary.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * The same order the CI jobs use: an explicit override, then whatever a local
 * `cargo build` produced, then the installed binary.
 */
function findBinary(): string | null {
  const candidates = [
    process.env.RUNE_TOOLS_BIN,
    process.env.RUNE_TOOLS_BINARY,
    join(import.meta.dir, "..", "..", "..", "target", "debug", "rune-tools"),
    join(import.meta.dir, "..", "..", "..", "target", "release", "rune-tools"),
    join(homedir(), ".rune", "bin", "rune-tools"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return candidates.find((p) => existsSync(p)) ?? null;
}

const BINARY = findBinary();
const REAL_AUDIT = join(homedir(), ".rune", "audit.jsonl");

/** sha256 of the real audit log, or null when the founder has no profile. */
function realAuditDigest(): string | null {
  if (!existsSync(REAL_AUDIT)) return null;
  return createHash("sha256").update(readFileSync(REAL_AUDIT)).digest("hex");
}

let workspace = "";
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "rune-audit-home-ws-"));
});

/** One `bash` call through the binary, under the given home. */
async function runBash(home: string, command: string): Promise<void> {
  const proc = Bun.spawn([BINARY!, "--workspace", workspace, "--sandbox", "bash"], {
    stdin: new TextEncoder().encode(JSON.stringify({ command })),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RUNE_HOME: home, GEAR_HOME: "" },
  });
  await proc.exited;
}

describe.skipIf(BINARY === null)("the sandbox audit log honours RUNE_HOME", () => {
  test("a scratch home gets the receipt, and the real profile does not move", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "rune-audit-home-"));
    const before = realAuditDigest();
    const beforeSize = existsSync(REAL_AUDIT) ? statSync(REAL_AUDIT).size : 0;

    await runBash(scratch, "echo the-audit-log-follows-rune-home");

    const log = join(scratch, "audit.jsonl");
    expect(existsSync(log)).toBe(true);

    // A real hash-chained entry, not an empty file: one line, the tool named,
    // the chain rooted.
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.tool_name).toBe("bash");
    expect(entry.prev_hash).toBe("genesis");
    expect(typeof entry.entry_hash).toBe("string");
    // Hashes only — the command itself never reaches the log.
    expect(lines[0]).not.toContain("the-audit-log-follows-rune-home");

    // The founder's own log is byte-identical. This is the assertion the whole
    // program has been claiming without checking.
    expect(realAuditDigest()).toBe(before);
    expect(existsSync(REAL_AUDIT) ? statSync(REAL_AUDIT).size : 0).toBe(beforeSize);
  });

  test("GEAR_HOME, the previous name, still relocates it", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "rune-audit-gear-home-"));
    const before = realAuditDigest();

    const proc = Bun.spawn([BINARY!, "--workspace", workspace, "--sandbox", "bash"], {
      stdin: new TextEncoder().encode(JSON.stringify({ command: "echo gear-home" })),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, RUNE_HOME: "", GEAR_HOME: scratch },
    });
    await proc.exited;

    expect(existsSync(join(scratch, "audit.jsonl"))).toBe(true);
    expect(realAuditDigest()).toBe(before);
  });
});
