// Promotion: what earns a place in the next session's prompt.
// Safety exit test #8 (two sessions promote, one does not) lives here, with
// supersession and decay beside it.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { MemoryStore } from "../../../packages/orchestrator/src/memory/store";
import {
  promoteAll,
  readyToPromote,
  sameTopic,
} from "../../../packages/orchestrator/src/memory/promote";
import type { MemoryCandidate } from "../../../packages/orchestrator/src/memory/types";

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-mem-promote-"));
  store = new MemoryStore(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cand(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    kind: "project",
    text: "a check that passes here: `bun test`",
    source: "observed",
    sessionId: "s1",
    scope: { workspace: "/repo" },
    ...over,
  };
}

describe("memory/promote — the per-source bar", () => {
  it("promotes the user's own words immediately", () => {
    store.observe(
      cand({ kind: "person", text: "I want short answers", source: "user-said", scope: "global" }),
    );
    const r = promoteAll(store);
    expect(r.promoted).toHaveLength(1);
    expect(store.promoted("/repo")).toHaveLength(1);
  });

  it("promotes a correction immediately", () => {
    store.observe(
      cand({
        kind: "working",
        text: "no, run typecheck first",
        source: "user-corrected",
        scope: "global",
      }),
    );
    expect(promoteAll(store).promoted).toHaveLength(1);
  });

  it("holds an observation seen in ONE session in quarantine", () => {
    store.observe(cand({ sessionId: "s1" }));
    const r = promoteAll(store);
    expect(r.promoted).toHaveLength(0);
    expect(r.waiting).toHaveLength(1);
    expect(store.promoted("/repo")).toHaveLength(0);
  });

  it("promotes the same observation once a SECOND session sees it", () => {
    store.observe(cand({ sessionId: "s1" }));
    promoteAll(store);
    store.observe(cand({ sessionId: "s2" }));
    expect(promoteAll(store).promoted).toHaveLength(1);
    expect(store.promoted("/repo")).toHaveLength(1);
  });

  it("does not count the same session twice", () => {
    store.observe(cand({ sessionId: "s1" }));
    store.observe(cand({ sessionId: "s1" }));
    store.observe(cand({ sessionId: "s1" }));
    expect(promoteAll(store).promoted).toHaveLength(0);
  });

  it("promotes a verified outcome only WITH its evidence", () => {
    const withEvidence = store.observe(
      cand({
        kind: "lesson",
        text: "bun test needs </dev/null",
        source: "verified-outcome",
        evidence: "verdict=met",
      }),
    ).entry!;
    const without = store.observe(
      cand({
        kind: "lesson",
        text: "some other claim about the runner",
        source: "verified-outcome",
      }),
    ).entry!;
    expect(readyToPromote(withEvidence)).toBe(true);
    expect(readyToPromote(without)).toBe(false);
  });

  it("never promotes distilled prose on its own", () => {
    const e = store.observe(
      cand({ source: "distilled", text: "you generally prefer terse replies" }),
    ).entry!;
    expect(readyToPromote(e)).toBe(false);
    expect(promoteAll(store).promoted).toHaveLength(0);
  });
});

describe("memory/promote — supersession", () => {
  it("a newer correction supersedes the older entry on the same topic, and keeps it", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    store.observe(
      cand({
        kind: "working",
        scope: "global",
        source: "user-said",
        text: "always run the linter first",
      }),
      t0,
    );
    promoteAll(store, t0);
    store.observe(
      cand({
        kind: "working",
        scope: "global",
        source: "user-corrected",
        sessionId: "s2",
        text: "no, always run the typecheck first, not the linter",
      }),
      new Date("2026-02-01T00:00:00Z"),
    );
    const r = promoteAll(store, new Date("2026-02-01T00:00:00Z"));
    expect(r.superseded).toHaveLength(1);
    const all = store.all();
    const old = all.find((e) => e.text.includes("linter first"))!;
    expect(old.status).toBe("superseded");
    expect(old.supersededBy).toBeDefined();
    // Kept, not deleted — what changed the user's mind is worth keeping.
    expect(store.get(old.id)).toBeDefined();
    // And it is out of the injected set.
    expect(store.promoted().map((e) => e.text)).not.toContain(old.text);
  });

  it("agreement does not supersede — a second `user-said` on the same topic stands beside it", () => {
    store.observe(
      cand({
        kind: "person",
        scope: "global",
        source: "user-said",
        text: "keep answers short and direct",
      }),
    );
    promoteAll(store, new Date("2026-01-01T00:00:00Z"));
    store.observe(
      cand({
        kind: "person",
        scope: "global",
        source: "user-said",
        sessionId: "s2",
        text: "keep answers short and plain",
      }),
    );
    expect(promoteAll(store, new Date("2026-02-01T00:00:00Z")).superseded).toHaveLength(0);
  });

  it("a correction about something else leaves the old entry alone", () => {
    store.observe(
      cand({
        kind: "working",
        scope: "global",
        source: "user-said",
        text: "always run the typecheck first",
      }),
    );
    promoteAll(store, new Date("2026-01-01T00:00:00Z"));
    store.observe(
      cand({
        kind: "working",
        scope: "global",
        source: "user-corrected",
        sessionId: "s2",
        text: "no, commit with explicit paths",
      }),
    );
    expect(promoteAll(store, new Date("2026-02-01T00:00:00Z")).superseded).toHaveLength(0);
  });

  it("topic matching sees a reversal and not two unrelated facts", () => {
    expect(sameTopic("always run the typecheck first", "no, run the typecheck first")).toBe(true);
    expect(sameTopic("always run the typecheck first", "commit with explicit paths")).toBe(false);
  });
});

describe("memory/promote — decay", () => {
  it("expires an observation that stopped being observed", () => {
    const old = new Date("2026-01-01T00:00:00Z");
    store.observe(cand({ sessionId: "s1" }), old);
    store.observe(cand({ sessionId: "s2" }), old);
    promoteAll(store, old);
    expect(store.promoted("/repo", old)).toHaveLength(1);
    // 61 days later, never seen again.
    const later = new Date("2026-03-03T00:00:00Z");
    expect(promoteAll(store, later).expired).toHaveLength(1);
    expect(store.promoted("/repo", later)).toHaveLength(0);
  });

  it("re-observation resets the clock", () => {
    const old = new Date("2026-01-01T00:00:00Z");
    store.observe(cand({ sessionId: "s1" }), old);
    store.observe(cand({ sessionId: "s2" }), old);
    promoteAll(store, old);
    const mid = new Date("2026-02-15T00:00:00Z");
    store.observe(cand({ sessionId: "s3" }), mid);
    promoteAll(store, mid);
    const later = new Date("2026-03-03T00:00:00Z");
    expect(promoteAll(store, later).expired).toHaveLength(0);
    expect(store.promoted("/repo", later)).toHaveLength(1);
  });

  it("the user's own words never expire", () => {
    const old = new Date("2020-01-01T00:00:00Z");
    store.observe(
      cand({ kind: "person", scope: "global", source: "user-said", text: "I want short answers" }),
      old,
    );
    promoteAll(store, old);
    expect(promoteAll(store, new Date("2030-01-01T00:00:00Z")).expired).toHaveLength(0);
    expect(store.promoted()).toHaveLength(1);
  });

  it("a pinned entry never expires", () => {
    const old = new Date("2026-01-01T00:00:00Z");
    store.observe(cand({ sessionId: "s1" }), old);
    store.observe(cand({ sessionId: "s2" }), old);
    promoteAll(store, old);
    store.setPinned(store.all()[0]!.id, true);
    expect(promoteAll(store, new Date("2030-01-01T00:00:00Z")).expired).toHaveLength(0);
  });
});

describe("memory/promote — idempotence", () => {
  it("a second pass with nothing new changes nothing on disk", () => {
    store.observe(
      cand({ kind: "person", scope: "global", source: "user-said", text: "I want short answers" }),
    );
    const now = new Date("2026-05-05T12:00:00Z");
    promoteAll(store, now);
    const before = JSON.stringify(store.all());
    promoteAll(store, now);
    expect(JSON.stringify(store.all())).toBe(before);
  });
});
