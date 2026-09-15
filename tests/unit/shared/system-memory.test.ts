import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  loadSystemMemory,
  loadSystemMemoryMeta,
  saveSystemMemory,
  saveSystemMemoryMeta,
  clearSystemMemory,
  parseSchedule,
  describeSchedule,
  isReflectionDue,
  effectiveSchedule,
  estimateMemoryTokens,
  clampToBudget,
  getSystemMemoryPath,
  getSystemMemoryMetaPath,
  MAX_SYSTEM_MEMORY_BACKUPS,
  backupSystemMemory,
  listSystemMemoryBackups,
  profileShrinkReason,
  restoreSystemMemory,
  saveRefreshedSystemMemory,
  resolveMemoryMode,
  parseMemoryMode,
  describeMemoryMode,
  MEMORY_MODES,
} from "../../../packages/shared/src/system-memory";

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-sysmem-"));
  prev = process.env.RUNE_SYSTEM_MEMORY_PATH;
  process.env.RUNE_SYSTEM_MEMORY_PATH = join(dir, "system-memory.md");
});

afterEach(() => {
  if (prev === undefined) delete process.env.RUNE_SYSTEM_MEMORY_PATH;
  else process.env.RUNE_SYSTEM_MEMORY_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("shared/system-memory — paths", () => {
  it("honors RUNE_SYSTEM_MEMORY_PATH and co-locates the meta json", () => {
    expect(getSystemMemoryPath()).toBe(join(dir, "system-memory.md"));
    expect(getSystemMemoryMetaPath()).toBe(join(dir, "system-memory.json"));
  });
});

describe("shared/system-memory — load/save", () => {
  it("returns empty content + meta when nothing is saved (never throws)", () => {
    const m = loadSystemMemory();
    expect(m.content).toBe("");
    expect(m.meta).toEqual({});
  });

  it("round-trips content and merges meta patches without clobbering", () => {
    saveSystemMemory("# About me\n- likes terse answers", {
      updatedAt: "2026-06-21T00:00:00Z",
      tokens: 8,
    });
    const m = loadSystemMemory();
    expect(m.content).toContain("likes terse answers");
    expect(m.meta.updatedAt).toBe("2026-06-21T00:00:00Z");
    expect(m.meta.tokens).toBe(8);

    saveSystemMemoryMeta({ lastReflectedAt: "2026-06-21T01:00:00Z" });
    const meta = loadSystemMemoryMeta();
    expect(meta.updatedAt).toBe("2026-06-21T00:00:00Z"); // preserved
    expect(meta.lastReflectedAt).toBe("2026-06-21T01:00:00Z"); // merged
  });

  it("treats a malformed meta json as empty (never throws)", () => {
    writeFileSync(getSystemMemoryMetaPath(), "{ not json");
    expect(loadSystemMemoryMeta()).toEqual({});
  });

  it("clear() wipes content but keeps the chosen cadence", () => {
    saveSystemMemory("stuff", { tokens: 2 });
    saveSystemMemoryMeta({ schedule: "weekly" });
    clearSystemMemory();
    const m = loadSystemMemory();
    expect(m.content).toBe("");
    expect(m.meta.schedule).toBe("weekly");
    expect(m.meta.tokens).toBeUndefined();
  });
});

describe("shared/system-memory — schedule parsing", () => {
  it("parses the cadence vocabulary", () => {
    expect(parseSchedule("manual")).toEqual({ kind: "manual" });
    expect(parseSchedule("off")).toEqual({ kind: "manual" });
    expect(parseSchedule(undefined)).toEqual({ kind: "manual" });
    expect(parseSchedule("daily")).toEqual({ kind: "interval", days: 1 });
    expect(parseSchedule("weekly")).toEqual({ kind: "interval", days: 7 });
    expect(parseSchedule("3d")).toEqual({ kind: "interval", days: 3 });
    expect(parseSchedule("every 5 days")).toEqual({ kind: "interval", days: 5 });
    expect(parseSchedule("nonsense")).toEqual({ kind: "manual" });
  });

  it("labels cadences for display", () => {
    expect(describeSchedule("manual")).toBe("manual");
    expect(describeSchedule("daily")).toBe("daily");
    expect(describeSchedule("weekly")).toBe("weekly");
    expect(describeSchedule("3d")).toBe("every 3 days");
  });

  it("effectiveSchedule prefers the meta override over the config default", () => {
    expect(effectiveSchedule({}, "weekly")).toBe("weekly");
    expect(effectiveSchedule({ schedule: "daily" }, "weekly")).toBe("daily");
    expect(effectiveSchedule({}, undefined)).toBe("manual");
  });
});

describe("shared/system-memory — isReflectionDue", () => {
  const now = Date.parse("2026-06-21T12:00:00Z");

  it("manual cadence never fires", () => {
    expect(isReflectionDue({ lastReflectedAt: "2020-01-01T00:00:00Z" }, "manual", now)).toBe(false);
  });

  it("an interval fires when it has never reflected", () => {
    expect(isReflectionDue({}, "daily", now)).toBe(true);
  });

  it("an interval respects the elapsed window", () => {
    const dayAgo = new Date(now - 25 * 3600 * 1000).toISOString();
    const hourAgo = new Date(now - 1 * 3600 * 1000).toISOString();
    expect(isReflectionDue({ lastReflectedAt: dayAgo }, "daily", now)).toBe(true);
    expect(isReflectionDue({ lastReflectedAt: hourAgo }, "daily", now)).toBe(false);
    expect(isReflectionDue({ lastReflectedAt: dayAgo }, "weekly", now)).toBe(false);
  });
});

describe("shared/system-memory — size budget", () => {
  it("estimates tokens (~4 chars/token)", () => {
    expect(estimateMemoryTokens("")).toBe(0);
    expect(estimateMemoryTokens("abcd")).toBe(1);
  });

  it("clamps over-budget content and marks the cut", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} with some words here`).join("\n");
    const clamped = clampToBudget(long, 50);
    expect(clamped.length).toBeLessThan(long.length);
    expect(clamped).toContain("memory trimmed to fit budget");
  });

  it("leaves within-budget content untouched", () => {
    const small = "# About me\n- terse";
    expect(clampToBudget(small, 1500)).toBe(small);
  });
});

// ─── The profile floor and the kept copies ───
//
// 2026-09-15: a daily dream returned 76 tokens and a 3,976-byte evergreen
// profile became 326 bytes ending mid-word. No diff, no backup, no floor.
// These are the three rules that close it, each asserted on the real files.

describe("shared/system-memory — a write keeps the file it replaces", () => {
  it("copies the current profile to a .bak- before overwriting it", () => {
    saveSystemMemory("# About me\n- the real, long, evergreen profile", {});
    expect(listSystemMemoryBackups()).toHaveLength(0); // nothing to keep the first time

    saveSystemMemory("# About me\n- the second profile", {});
    const kept = listSystemMemoryBackups();
    expect(kept).toHaveLength(1);
    expect(readFileSync(kept[0].path, "utf-8")).toContain("the real, long, evergreen profile");
    expect(loadSystemMemory().content).toContain("the second profile");
  });

  it("keeps the newest five and drops the sixth-oldest", () => {
    for (let i = 0; i < 8; i++) {
      saveSystemMemory(`# profile ${i}\n- body`, {});
    }
    const kept = listSystemMemoryBackups();
    expect(kept).toHaveLength(MAX_SYSTEM_MEMORY_BACKUPS);
    // Newest first, and the newest kept copy is the profile written just before
    // the last one (profile 6), not an arbitrary survivor.
    expect(readFileSync(kept[0].path, "utf-8")).toContain("profile 6");
    const bodies = kept.map((b) => readFileSync(b.path, "utf-8"));
    expect(bodies.some((b) => b.includes("profile 0"))).toBe(false);
  });

  it("clearing the profile keeps a copy too", () => {
    saveSystemMemory("# About me\n- a profile worth not losing", {});
    clearSystemMemory();
    expect(loadSystemMemory().content).toBe("");
    const kept = listSystemMemoryBackups();
    expect(kept).toHaveLength(1);
    expect(readFileSync(kept[0].path, "utf-8")).toContain("worth not losing");
  });

  it("keeps nothing when there is nothing there yet", () => {
    expect(backupSystemMemory()).toBeUndefined();
    saveSystemMemory("", {});
    expect(backupSystemMemory()).toBeUndefined();
    expect(listSystemMemoryBackups()).toHaveLength(0);
  });
});

/** A profile of roughly the founder's real size. */
const LONG_PROFILE = Array.from(
  { length: 60 },
  (_, i) => `- a real sentence about how the user works, number ${i}`,
).join("\n");

describe("shared/system-memory — the shrink floor", () => {
  it("refuses the 2026-09-15 shape: a truncated completion over a real profile", () => {
    saveSystemMemory(LONG_PROFILE, { updatedAt: "2026-09-01T00:00:00Z" });
    const truncated = 'Uses "well" as a';
    const res = saveRefreshedSystemMemory(truncated, { updatedAt: "2026-09-15T12:26:08Z" });

    expect(res.saved).toBe(false);
    expect(res.refusal?.reason).toMatch(/under the 400-byte floor/);
    expect(res.refusal?.discardedBytes).toBe(Buffer.byteLength(truncated));
    expect(res.refusal?.previousBytes).toBe(Buffer.byteLength(LONG_PROFILE));
    // The profile on disk is EXACTLY what it was.
    expect(loadSystemMemory().content).toBe(LONG_PROFILE);
    expect(loadSystemMemory().meta.updatedAt).toBe("2026-09-01T00:00:00Z");
    // And the refusal is on the record.
    expect(loadSystemMemoryMeta().lastRefusal?.reason).toMatch(/under the 400-byte floor/);
  });

  it("refuses a halving that is not a stub either", () => {
    // 900 bytes out of 3,000: well clear of the absolute floor, and still not
    // the same profile.
    saveSystemMemory("x".repeat(3000), {});
    const res = saveRefreshedSystemMemory("y".repeat(900), {});
    expect(res.saved).toBe(false);
    expect(res.refusal?.reason).toMatch(/less than half/);
    expect(loadSystemMemory().content).toBe("x".repeat(3000));
  });

  it("refuses a sub-400-byte stub where a substantial profile stood", () => {
    const previous = "x".repeat(900);
    const stub = "y".repeat(390);
    saveSystemMemory(previous, {});
    const res = saveRefreshedSystemMemory(stub, {});
    expect(res.saved).toBe(false);
    expect(res.refusal?.reason).toMatch(/under the 400-byte floor/);
    expect(loadSystemMemory().content).toBe(previous);
  });

  it("refuses an empty refresh over a profile that exists", () => {
    saveSystemMemory(LONG_PROFILE, {});
    const res = saveRefreshedSystemMemory("   ", {});
    expect(res.saved).toBe(false);
    expect(res.refusal?.reason).toMatch(/empty/);
    expect(loadSystemMemory().content).toBe(LONG_PROFILE);
  });

  it("saves a normal refresh — a rewrite of similar size goes through", () => {
    saveSystemMemory(LONG_PROFILE, {});
    const refreshed = LONG_PROFILE.replace("number 0", "number zero") + "\n- and one new thing";
    const res = saveRefreshedSystemMemory(refreshed, {
      updatedAt: "2026-09-15T12:26:08Z",
      tokens: 100,
    });
    expect(res.saved).toBe(true);
    expect(res.refusal).toBeUndefined();
    expect(loadSystemMemory().content).toContain("and one new thing");
    expect(loadSystemMemory().meta.updatedAt).toBe("2026-09-15T12:26:08Z");
    expect(loadSystemMemoryMeta().lastRefusal).toBeUndefined();
  });

  it("saves a deliberately shorter refresh when there was no profile to lose", () => {
    const res = saveRefreshedSystemMemory("- the very first thing learned", {});
    expect(res.saved).toBe(true);
    expect(loadSystemMemory().content).toContain("very first thing");
  });

  it("a person shortening their own profile by hand is not the dream", () => {
    saveSystemMemory(LONG_PROFILE, {});
    saveSystemMemory("- actually, just this", {});
    expect(loadSystemMemory().content).toBe("- actually, just this");
    // …and the long one is still there to take back.
    expect(readFileSync(listSystemMemoryBackups()[0].path, "utf-8")).toContain("number 59");
  });

  it("records what the refusal was for without folding the activity away", () => {
    saveSystemMemory(LONG_PROFILE, { foldedSeqBySession: { s1: 4 } });
    saveRefreshedSystemMemory(
      "tiny",
      { foldedSeqBySession: { s1: 99 } },
      { lastReflectedAt: "2026-09-15T12:26:08Z" },
    );
    const meta = loadSystemMemoryMeta();
    expect(meta.lastReflectedAt).toBe("2026-09-15T12:26:08Z");
    expect(meta.foldedSeqBySession).toEqual({ s1: 4 }); // the digest is NOT consumed
  });
});

describe("shared/system-memory — restore", () => {
  it("puts the newest kept copy back", () => {
    saveSystemMemory(LONG_PROFILE, {});
    saveSystemMemory("the stub that replaced it", {});
    expect(loadSystemMemory().content).toBe("the stub that replaced it");

    const r = restoreSystemMemory();
    expect(r.restored).toBe(true);
    expect(r.bytes).toBe(Buffer.byteLength(LONG_PROFILE));
    expect(loadSystemMemory().content).toBe(LONG_PROFILE);
  });

  it("restores a named copy — by stamp, basename or full path", () => {
    saveSystemMemory("# oldest", {});
    saveSystemMemory("# middle", {});
    saveSystemMemory("# newest", {});
    const kept = listSystemMemoryBackups(); // [middle, oldest]
    const oldest = kept[kept.length - 1];

    expect(restoreSystemMemory(oldest.stamp).restored).toBe(true);
    expect(loadSystemMemory().content).toBe("# oldest");

    saveSystemMemory("# junk", {});
    expect(restoreSystemMemory(oldest.path).restored).toBe(true);
    expect(loadSystemMemory().content).toBe("# oldest");
  });

  it("restoring twice is the same as restoring once (an undo may not alternate)", () => {
    saveSystemMemory(LONG_PROFILE, {});
    saveSystemMemory("the stub", {});
    restoreSystemMemory();
    restoreSystemMemory();
    expect(loadSystemMemory().content).toBe(LONG_PROFILE);
  });

  it("clears the refusal notice, because the damage is undone", () => {
    saveSystemMemory(LONG_PROFILE, {});
    saveSystemMemory("the stub that replaced it", {});
    saveSystemMemoryMeta({
      lastRefusal: { at: "2026-09-15T12:26:08Z", reason: "x", discardedBytes: 1, previousBytes: 2 },
    });
    restoreSystemMemory();
    expect(loadSystemMemoryMeta().lastRefusal).toBeUndefined();
  });

  it("says so rather than throwing when there is nothing to restore", () => {
    expect(restoreSystemMemory()).toMatchObject({
      restored: false,
      reason: "no backup to restore",
    });
    saveSystemMemory("# a", {});
    saveSystemMemory("# b", {});
    expect(restoreSystemMemory("2019-01-01T00-00-00.000Z")).toMatchObject({ restored: false });
    expect(loadSystemMemory().content).toBe("# b");
  });
});

describe("shared/system-memory — profileShrinkReason in isolation", () => {
  it("is silent on the shapes that must keep working", () => {
    expect(profileShrinkReason("", "anything at all")).toBeUndefined();
    expect(profileShrinkReason("x".repeat(1000), "x".repeat(1000))).toBeUndefined();
    expect(profileShrinkReason("x".repeat(1000), "x".repeat(501))).toBeUndefined();
    // A small previous profile may halve without tripping the byte floor.
    expect(profileShrinkReason("x".repeat(700), "x".repeat(360))).toBeUndefined();
  });

  it("speaks on the shapes that cost the founder their profile", () => {
    expect(profileShrinkReason("x".repeat(3976), "x".repeat(326))).toMatch(/400-byte floor/);
    expect(profileShrinkReason("x".repeat(1000), "x".repeat(499))).toMatch(/less than half/);
    expect(profileShrinkReason("x".repeat(900), "x".repeat(399))).toMatch(/400-byte floor/);
  });
});

// ─── The mode, in the sidecar ───

describe("shared/system-memory — the three modes", () => {
  it("round-trips a mode and a migration note through the sidecar", () => {
    saveSystemMemoryMeta({
      mode: "manual",
      modeMigration: {
        at: "2026-09-15T00:00:00Z",
        from: "daily",
        mode: "auto",
        note: "cadence withdrawn",
      },
    });
    const meta = loadSystemMemoryMeta();
    expect(meta.mode).toBe("manual");
    expect(meta.modeMigration?.from).toBe("daily");
    expect(meta.modeMigration?.notified).toBeUndefined();
  });

  it("drops a mode it does not recognise rather than inventing one", () => {
    writeFileSync(getSystemMemoryMetaPath(), JSON.stringify({ mode: "daily" }));
    expect(loadSystemMemoryMeta().mode).toBeUndefined();
    // …and the resolution falls through to the migration, which knows what
    // `daily` used to mean.
    expect(resolveMemoryMode({ schedule: "daily" }, loadSystemMemoryMeta()).mode).toBe("auto");
  });

  it("records who refreshed the profile", () => {
    saveSystemMemory("# a profile that is long enough to survive the floor", {
      lastRefresh: {
        at: "2026-09-15T00:00:00Z",
        origin: "agent",
        tokensBefore: 0,
        tokensAfter: 12,
      },
    });
    expect(loadSystemMemoryMeta().lastRefresh?.origin).toBe("agent");
    writeFileSync(
      getSystemMemoryMetaPath(),
      JSON.stringify({ lastRefresh: { at: "x", origin: "the cat" } }),
    );
    expect(loadSystemMemoryMeta().lastRefresh).toBeUndefined();
  });

  it("clearing the profile keeps the mode — a wipe is not a setting change", () => {
    saveSystemMemoryMeta({ mode: "manual" });
    saveSystemMemory("# something to wipe", {});
    clearSystemMemory();
    expect(loadSystemMemory().content).toBe("");
    expect(loadSystemMemoryMeta().mode).toBe("manual");
  });

  it("every mode has a description, and there are three of them", () => {
    expect(MEMORY_MODES).toEqual(["off", "auto", "manual"]);
    for (const m of MEMORY_MODES) expect(describeMemoryMode(m).length).toBeGreaterThan(0);
    expect(parseMemoryMode("weekly")).toBeUndefined();
  });
});
