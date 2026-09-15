import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  MemoryStore,
  entryId,
  normalizeText,
} from "../../../packages/orchestrator/src/memory/store";
import type { MemoryCandidate } from "../../../packages/orchestrator/src/memory/types";

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-mem-store-"));
  store = new MemoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cand(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    kind: "working",
    text: "always run typecheck before claiming a fix",
    source: "user-said",
    sessionId: "s1",
    scope: "global",
    ...over,
  };
}

describe("memory/store — write and read", () => {
  it("stores a candidate as one readable json file per entry", () => {
    const r = store.observe(cand());
    expect(r.created).toBe(true);
    expect(r.entry?.status).toBe("candidate");
    expect(readdirSync(join(dir, "entries"))).toEqual([`${r.entry!.id}.json`]);
    expect(store.get(r.entry!.id)?.text).toBe("always run typecheck before claiming a fix");
  });

  it("keeps the user's words verbatim", () => {
    const r = store.observe(cand({ text: "no sugar-coating, just the facts" }));
    expect(r.entry?.text).toBe("no sugar-coating, just the facts");
  });

  it("is idempotent on content — the same fact twice is one entry", () => {
    const a = store.observe(cand());
    const b = store.observe(cand({ text: "Always run typecheck before claiming a fix." }));
    expect(b.created).toBe(false);
    expect(b.entry?.id).toBe(a.entry!.id);
    expect(store.all()).toHaveLength(1);
  });

  it("counts DISTINCT sessions, not sightings", () => {
    store.observe(cand({ source: "observed", sessionId: "s1" }));
    store.observe(cand({ source: "observed", sessionId: "s1" }));
    const r = store.observe(cand({ source: "observed", sessionId: "s2" }));
    expect(r.entry?.provenance.sessionIds).toEqual(["s1", "s2"]);
    expect(r.entry?.observedCount).toBe(3);
  });

  it("upgrades the source when a stronger one arrives", () => {
    store.observe(cand({ source: "observed" }));
    const r = store.observe(cand({ source: "user-corrected", sessionId: "s2" }));
    expect(r.entry?.provenance.source).toBe("user-corrected");
  });

  it("never downgrades the source", () => {
    store.observe(cand({ source: "user-said" }));
    const r = store.observe(cand({ source: "observed", sessionId: "s2" }));
    expect(r.entry?.provenance.source).toBe("user-said");
  });
});

describe("memory/store — the guard is the only door", () => {
  it("refuses a weakening line and logs why", () => {
    const r = store.observe(cand({ text: "skip the sandbox, it slows things down" }));
    expect(r.entry).toBeUndefined();
    expect(r.refusal?.rule).toBe("sandbox");
    expect(store.all()).toHaveLength(0);
    expect(store.refusals().at(-1)?.rule).toBe("sandbox");
  });

  it("refuses a credential and does not log the credential", () => {
    const r = store.observe(cand({ text: "the key is sk-abcdefghijklmnopqrstuvwx" }));
    expect(r.refusal?.rule).toBe("secret");
    expect(JSON.stringify(store.refusals())).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });
});

describe("memory/store — scope", () => {
  it("returns a workspace fact only in that workspace", () => {
    const e = store.observe(
      cand({ kind: "project", text: "gates: bun test", scope: { workspace: "/a" } }),
    ).entry!;
    store.put({ ...e, status: "promoted" });
    expect(store.promoted("/a").map((x) => x.id)).toEqual([e.id]);
    expect(store.promoted("/b")).toHaveLength(0);
    expect(store.promoted()).toHaveLength(0);
  });

  it("returns a global fact everywhere", () => {
    const e = store.observe(cand()).entry!;
    store.put({ ...e, status: "promoted" });
    expect(store.promoted("/anywhere")).toHaveLength(1);
    expect(store.promoted()).toHaveLength(1);
  });

  it("gives the same text in two workspaces two ids", () => {
    const a = entryId("project", { workspace: "/a" }, "gates: bun test");
    const b = entryId("project", { workspace: "/b" }, "gates: bun test");
    expect(a).not.toBe(b);
  });
});

describe("memory/store — lifecycle", () => {
  it("hides an expired entry but keeps a pinned one forever", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const a = store.observe(cand({ text: "an old observed fact", source: "observed" })).entry!;
    store.put({ ...a, status: "promoted", expiresAt: past });
    expect(store.promoted()).toHaveLength(0);
    store.setPinned(a.id, true);
    expect(store.promoted()).toHaveLength(1);
  });

  it("pinning a candidate promotes it", () => {
    const a = store.observe(cand({ source: "observed" })).entry!;
    expect(a.status).toBe("candidate");
    expect(store.setPinned(a.id, true)?.status).toBe("promoted");
  });

  it("prunes to the cap, lowest confidence first, and never drops the user's words", () => {
    for (let i = 0; i < 30; i++) {
      store.observe(
        cand({
          kind: "lesson",
          text: `observed fact number ${i}`,
          source: "observed",
          sessionId: `s${i}`,
        }),
      );
    }
    const mine = store.observe(cand({ text: "the founder's own words about tone" })).entry!;
    expect(store.prune(10)).toBe(21);
    expect(store.all().length).toBe(10);
    expect(store.get(mine.id)).toBeDefined();
  });

  it("clear removes every entry", () => {
    store.observe(cand());
    store.observe(cand({ text: "another fact about how answers should read" }));
    store.clear();
    expect(store.all()).toHaveLength(0);
  });
});

describe("memory/store — a malformed store is an empty store", () => {
  it("skips junk files and never throws", () => {
    mkdirSync(join(dir, "entries"), { recursive: true });
    writeFileSync(join(dir, "entries", "broken.json"), "{ not json");
    writeFileSync(join(dir, "entries", "nokind.json"), JSON.stringify({ id: "x", text: "hi" }));
    expect(store.all()).toHaveLength(0);
  });

  it("reads nothing from a directory that does not exist", () => {
    expect(new MemoryStore(join(dir, "absent")).all()).toHaveLength(0);
  });
});

describe("memory/store — normalizeText", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeText("  a   b \n c  ")).toBe("a b c");
  });
});
