/**
 * Pid-scoped crash sentinels: concurrent Gear instances must not consume each
 * other's LIVE markers as dirty exits (false positive observed live 2026-07-07
 * with two terminal tabs), while genuinely dead processes' markers still turn
 * into dirty-exit incidents.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armSentinel,
  isPidAlive,
  sentinelPathFor,
  sweepDirtyExits,
} from "../../../packages/telemetry/src/sentinel";

function meta(pid: number, sessionId = "s") {
  return {
    pid,
    version: "test",
    sessionId,
    startedAt: new Date().toISOString(),
    spoolPath: null,
  };
}

describe("sentinel sweep — pid liveness", () => {
  test("live instance markers are skipped; dead ones are consumed", () => {
    const dir = mkdtempSync(join(tmpdir(), "sent-"));
    const livePath = sentinelPathFor(dir, process.pid); // our own pid = alive
    const deadPath = sentinelPathFor(dir, 999_999_99);
    armSentinel(livePath, meta(process.pid, "live-session"));
    armSentinel(deadPath, meta(999_999_99, "dead-session"));

    const dirty = sweepDirtyExits(dir);

    expect(dirty.length).toBe(1);
    expect(dirty[0]!.meta.sessionId).toBe("dead-session");
    expect(existsSync(livePath)).toBe(true); // untouched — that Gear is running
    expect(existsSync(deadPath)).toBe(false); // consumed
  });

  test("legacy single-file sentinel is swept with the same liveness rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "sent-"));
    const legacy = join(dir, "blackbox.sentinel.json");
    armSentinel(legacy, meta(999_999_98, "legacy-dead"));
    const dirty = sweepDirtyExits(join(dir, "sentinels"), { legacyPath: legacy });
    expect(dirty.length).toBe(1);
    expect(dirty[0]!.meta.sessionId).toBe("legacy-dead");
    expect(existsSync(legacy)).toBe(false);
  });

  test("corrupt markers are removed without wedging the sweep", () => {
    const dir = mkdtempSync(join(tmpdir(), "sent-"));
    const bad = sentinelPathFor(dir, 424242);
    writeFileSync(bad, "{not json");
    const ok = sentinelPathFor(dir, 999_999_97);
    armSentinel(ok, meta(999_999_97, "real-dead"));

    const dirty = sweepDirtyExits(dir);
    expect(dirty.length).toBe(1);
    expect(existsSync(bad)).toBe(false);
  });

  test("missing dir and no legacy file → empty sweep", () => {
    expect(sweepDirtyExits(join(tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });

  test("isPidAlive: own pid alive, absurd pid dead", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(999_999_96)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});
