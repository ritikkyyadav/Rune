// ─── TeamBus: the cross-instance coordination ledger ───
//
// Contract proved here: two Rune processes sharing one bus DB and one repo
// key SEE each other (presence), cannot hold overlapping path leases in the
// same working tree (claims), can mail each other with join-time cursor
// semantics (messages), and get soft warnings when both edit one area
// (writes). Dead peers are mechanically reaped by pid + heartbeat, different
// repositories never mix, and a failed/closed bus degrades to safe defaults
// instead of throwing into the session.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamBus, pathKeysOverlap, toPathKey } from "../../../packages/orchestrator/src/team/bus";

let dir: string;
let dbPath: string;
const REPO = "/repo/common";
const TREE_A = "/repo/main";
const TREE_B = "/repo/worktree-b";

const open = (overrides: Partial<Parameters<typeof TeamBus.open>[0]> = {}) =>
  TeamBus.open({
    dbPath,
    repoKey: REPO,
    workspace: TREE_A,
    ...overrides,
  });

const buses: TeamBus[] = [];
const track = (b: TeamBus | null): TeamBus => {
  expect(b).not.toBeNull();
  buses.push(b!);
  return b!;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-team-"));
  dbPath = join(dir, "team.db");
});

afterEach(() => {
  for (const b of buses.splice(0)) b.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("path keys — normalization and overlap", () => {
  test("workspace-relative keys, dir suffix preserved, outside → null", () => {
    expect(toPathKey("/w", "src/a.ts")).toBe("src/a.ts");
    expect(toPathKey("/w", "/w/src/a.ts")).toBe("src/a.ts");
    expect(toPathKey("/w", "src/auth/")).toBe("src/auth/");
    expect(toPathKey("/w", "../outside.ts")).toBeNull();
    expect(toPathKey("/w", "/elsewhere/x.ts")).toBeNull();
  });

  test("overlap: exact, dir-over-file, file-under-dir, disjoint", () => {
    expect(pathKeysOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathKeysOverlap("src/auth/", "src/auth/session.ts")).toBe(true);
    expect(pathKeysOverlap("src/auth/session.ts", "src/auth/")).toBe(true);
    expect(pathKeysOverlap("src/auth/", "src/auth/")).toBe(true);
    expect(pathKeysOverlap("src/auth", "src/auth/")).toBe(true);
    expect(pathKeysOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(pathKeysOverlap("src/auth/", "src/authz.ts")).toBe(false);
  });
});

describe("presence", () => {
  test("two instances on one repo see each other; sameTree is honest", () => {
    const a = track(open({ model: "m-a" }));
    const b = track(open({ workspace: TREE_B, branch: "rune/run-x" }));
    const fromA = a.peers();
    expect(fromA.map((p) => p.id)).toEqual([b.instanceId]);
    expect(fromA[0].sameTree).toBe(false);
    expect(fromA[0].branch).toBe("rune/run-x");
    const c = track(open({}));
    expect(c.peers().find((p) => p.id === a.instanceId)?.sameTree).toBe(true);
  });

  test("intent set via heartbeat is visible to peers", () => {
    const a = track(open());
    const b = track(open());
    b.setIntent("refactoring the auth flow");
    expect(a.peers().find((p) => p.id === b.instanceId)?.intent).toBe("refactoring the auth flow");
  });

  test("different repositories never mix", () => {
    const a = track(open());
    const other = track(open({ repoKey: "/some/other/repo" }));
    expect(a.peers()).toHaveLength(0);
    expect(other.peers()).toHaveLength(0);
  });

  test("a dead pid is not a peer, and a fresh open reaps its rows", () => {
    const a = track(open());
    // Forge a crashed instance: plausible-but-dead pid, fresh heartbeat.
    const raw = new Database(dbPath);
    raw
      .query(
        `INSERT INTO instances (id, repo_key, workspace, pid, started_at, last_beat)
         VALUES ('g-dead01', ?, ?, 999999, ?, ?)`,
      )
      .run(REPO, TREE_A, Date.now(), Date.now());
    raw
      .query(
        `INSERT INTO claims (id, repo_key, workspace, instance_id, paths, created_at, expires_at)
         VALUES ('c-dead01', ?, ?, 'g-dead01', '["src/"]', ?, ?)`,
      )
      .run(REPO, TREE_A, Date.now(), Date.now() + 3_600_000);
    expect(a.peers().map((p) => p.id)).not.toContain("g-dead01");
    // The dead ghost's claim must not block the living.
    expect(a.claim(["src/auth.ts"]).ok).toBe(true);
    // A fresh join sweeps the corpse out of the DB entirely.
    track(open());
    const left = raw.query(`SELECT id FROM instances`).all() as Array<{ id: string }>;
    expect(left.map((r) => r.id)).not.toContain("g-dead01");
    raw.close();
  });

  test("a stale heartbeat (live pid) also drops out of the live set", () => {
    const a = track(open({ staleMs: 50 }));
    const raw = new Database(dbPath);
    raw
      .query(
        `INSERT INTO instances (id, repo_key, workspace, pid, started_at, last_beat)
         VALUES ('g-stale1', ?, ?, ?, ?, ?)`,
      )
      .run(REPO, TREE_A, process.pid, Date.now() - 10_000, Date.now() - 10_000);
    raw.close();
    expect(a.peers().map((p) => p.id)).not.toContain("g-stale1");
  });

  test("leave() withdraws presence and claims", () => {
    const a = track(open());
    const b = track(open());
    expect(b.claim(["src/x.ts"]).ok).toBe(true);
    b.leave();
    expect(a.peers()).toHaveLength(0);
    expect(a.findConflictingClaim("src/x.ts")).toBeNull();
  });
});

describe("claims", () => {
  test("overlapping claim in the SAME tree conflicts, atomically", () => {
    const a = track(open());
    const b = track(open());
    expect(a.claim(["src/auth/"], { reason: "auth rework" }).ok).toBe(true);
    const res = b.claim(["src/auth/session.ts", "docs/notes.md"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.conflict.claim.instanceId).toBe(a.instanceId);
      expect(res.conflict.peer?.id).toBe(a.instanceId);
    }
    // All-or-nothing: the non-conflicting path was NOT leased either.
    expect(a.findConflictingClaim("docs/notes.md")).toBeNull();
  });

  test("same paths in a DIFFERENT working tree do not conflict", () => {
    const a = track(open());
    const b = track(open({ workspace: TREE_B }));
    expect(a.claim(["src/auth/"]).ok).toBe(true);
    expect(b.claim(["src/auth/"]).ok).toBe(true);
  });

  test("expired leases stop conflicting; release() frees immediately", async () => {
    const a = track(open());
    const b = track(open());
    const short = a.claim(["src/x.ts"], { ttlMs: 10 });
    expect(short.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    expect(b.claim(["src/x.ts"]).ok).toBe(true);
    b.releaseClaim();
    expect(a.findConflictingClaim("src/x.ts")).toBeNull();
  });

  test("own claims never conflict with self; liveClaims lists both sides", () => {
    const a = track(open());
    expect(a.claim(["src/a.ts"]).ok).toBe(true);
    expect(a.claim(["src/a.ts"]).ok).toBe(true); // self-overlap is allowed
    expect(a.findConflictingClaim("src/a.ts")).toBeNull(); // peers only
    const b = track(open());
    expect(b.claim(["src/b.ts"]).ok).toBe(true);
    const seen = a.liveClaims();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const mine = seen.filter((c) => c.instanceId === a.instanceId);
    expect(mine.some((c) => c.paths.includes("src/a.ts"))).toBe(true);
  });

  test("paths outside the workspace lease nothing and succeed", () => {
    const a = track(open());
    const res = a.claim(["/etc/passwd", "../outside.ts"]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.id).toBe("");
  });
});

describe("messages", () => {
  test("broadcast reaches every peer once; sender never hears itself", () => {
    const a = track(open());
    const b = track(open());
    const c = track(open());
    expect(a.send("auth interface changed — session.ts").ok).toBe(true);
    expect(a.drainInbox()).toHaveLength(0);
    const gotB = b.drainInbox();
    expect(gotB).toHaveLength(1);
    expect(gotB[0].fromId).toBe(a.instanceId);
    expect(gotB[0].body).toContain("session.ts");
    expect(c.drainInbox()).toHaveLength(1);
    // Cursor advanced: nothing on the second drain.
    expect(b.drainInbox()).toHaveLength(0);
  });

  test("direct mail reaches only its target; unknown target errors", () => {
    const a = track(open());
    const b = track(open());
    const c = track(open());
    expect(a.send("for b only", b.instanceId).ok).toBe(true);
    expect(c.drainInbox()).toHaveLength(0);
    expect(b.drainInbox()).toHaveLength(1);
    const bad = a.send("hello?", "g-nosuch");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("g-nosuch");
  });

  test("mail sent before an instance joined is not delivered to it", () => {
    const a = track(open());
    const b = track(open());
    expect(a.send("early broadcast").ok).toBe(true);
    expect(b.pendingMessageCount()).toBe(1);
    const late = track(open());
    expect(late.drainInbox()).toHaveLength(0);
  });

  test("sender intent rides along for framing", () => {
    const a = track(open());
    a.setIntent("building the dashboard");
    const b = track(open());
    a.send("dashboard API is at src/api/dash.ts");
    expect(b.drainInbox()[0].fromIntent).toBe("building the dashboard");
  });
});

describe("recent writes (soft conflict)", () => {
  test("a peer's fresh write on the same path is surfaced; own writes are not", () => {
    const a = track(open());
    const b = track(open());
    a.noteWrite("src/shared/types.ts");
    const hit = b.recentPeerWrite("src/shared/types.ts");
    expect(hit?.peer.id).toBe(a.instanceId);
    expect(a.recentPeerWrite("src/shared/types.ts")).toBeNull();
    expect(b.recentPeerWrite("src/other.ts")).toBeNull();
  });

  test("writes in a different working tree never warn", () => {
    const a = track(open());
    const b = track(open({ workspace: TREE_B }));
    a.noteWrite("src/shared/types.ts");
    expect(b.recentPeerWrite("src/shared/types.ts")).toBeNull();
  });
});

describe("degradation", () => {
  test("every method is safe after close()", () => {
    const a = track(open());
    a.close();
    expect(a.healthy).toBe(false);
    expect(a.peers()).toEqual([]);
    expect(a.liveClaims()).toEqual([]);
    expect(a.claim(["src/x.ts"]).ok).toBe(true); // degrades to no-lease success
    expect(a.releaseClaim()).toBe(0);
    expect(a.send("hi").ok).toBe(false);
    expect(a.drainInbox()).toEqual([]);
    expect(a.pendingMessageCount()).toBe(0);
    expect(a.recentPeerWrite("src/x.ts")).toBeNull();
    expect(() => a.noteWrite("src/x.ts")).not.toThrow();
    expect(() => a.heartbeat()).not.toThrow();
    expect(() => a.close()).not.toThrow();
  });

  test("open() on an unopenable path returns null, never throws", () => {
    const b = TeamBus.open({
      dbPath: join(dir, "no-such-dir", "deeper", "team.db"),
      repoKey: REPO,
      workspace: TREE_A,
    });
    expect(b).toBeNull();
  });
});
