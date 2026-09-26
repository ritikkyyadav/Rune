import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
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
  memoryKeyLocation,
  describeMemoryKey,
  getMemoryKeyPath,
  loadMemorySecret,
  forgetMemorySecretCache,
  setMemoryKeyRunner,
  memoryMac,
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

  // ─── V8 finding 10: the floor was per STEP ───
  //
  // The named attack — grow by one byte, then shrink 60% — was correctly
  // refused and the good copy survived. But the floor compared each refresh
  // only to the one it replaced, and PROFILE_MIN_BYTES was gated behind
  // `prevBytes > 800`, so under 800 bytes there was no absolute floor at all.
  // Seven refreshes at 51% — each one individually legal — took 2,539 bytes to
  // 23, and MAX_SYSTEM_MEMORY_BACKUPS (5) rotated the real profile out of the
  // ring at step five: the largest copy `/memory restore` could still reach was
  // 662 bytes. In `auto` that is seven sessions.
  it("seven refreshes that are each legal cannot erode the profile", () => {
    const good =
      "# About the founder\n" +
      "The founder ships solo on no budget and wants unsugared facts. ".repeat(40);
    saveSystemMemory(good);
    const originalBytes = Buffer.byteLength(loadSystemMemory().content.trim());
    expect(originalBytes).toBeGreaterThan(2000);

    let cur = loadSystemMemory().content;
    for (let i = 0; i < 7; i++) {
      saveRefreshedSystemMemory(cur.slice(0, Math.ceil(cur.length * 0.51)), {});
      cur = loadSystemMemory().content;
    }

    const now = Buffer.byteLength(cur.trim());
    const recoverable = Math.max(0, ...listSystemMemoryBackups().map((b) => b.bytes));
    // The profile is measured against its high-water mark, not against the file
    // each refresh happens to replace…
    expect(now).toBeGreaterThan(originalBytes / 2);
    // …and whatever happened, `/memory restore` still reaches the real one.
    expect(recoverable).toBeGreaterThanOrEqual(originalBytes);
  });

  it("a refusal writes nothing, so it can never rotate a kept copy out", () => {
    saveSystemMemory(LONG_PROFILE, {});
    saveSystemMemory(LONG_PROFILE + "\n- one more", {});
    const before = listSystemMemoryBackups().map((b) => `${b.stamp}:${b.bytes}`);
    for (let i = 0; i < 8; i++) expect(saveRefreshedSystemMemory("tiny", {}).saved).toBe(false);
    expect(listSystemMemoryBackups().map((b) => `${b.stamp}:${b.bytes}`)).toEqual(before);
  });

  it("a person shortening their profile by hand resets the high-water mark", () => {
    // The floor may not outlive the profile it was measured from: someone who
    // rewrites their own profile short meant it, and every honest refresh
    // afterwards has to be allowed.
    saveSystemMemory("x".repeat(3000), {});
    saveSystemMemory("y".repeat(600), {});
    expect(saveRefreshedSystemMemory("z".repeat(420), {}).saved).toBe(true);
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

// ─── The sidecar's mode is a control, so it is signed ───
//
// V8 critical 1's other half. `system-memory.json` sits in an ordinary
// directory outside the workspace, and `mode` decides whether Rune reads,
// writes and injects memory at all — so a `cat >` that set `"mode": "auto"`
// turned memory back on for every future session. The three authenticated
// fields carry an HMAC made with `~/.rune/memory/.key`, which is written 0600
// on the first save and named in no config file.

describe("shared/system-memory — the meta sidecar is authenticated", () => {
  it("a hand-written mode is not a mode", () => {
    writeFileSync(getSystemMemoryMetaPath(), JSON.stringify({ mode: "auto" }) + "\n");
    expect(loadSystemMemoryMeta().mode).toBeUndefined();
    // …so the resolution falls through to the config and the default, which is
    // exactly what makes `[memory] mode` and RUNE_MEMORY_MODE reachable.
    expect(resolveMemoryMode({ mode: "off" }, loadSystemMemoryMeta()).mode).toBe("off");
  });

  it("a mode written through the door survives the round trip", () => {
    saveSystemMemoryMeta({ mode: "manual" });
    expect(loadSystemMemoryMeta().mode).toBe("manual");
    // And it does not travel: the same bytes under another home do not verify.
    const bytes = readFileSync(getSystemMemoryMetaPath(), "utf-8");
    const other = mkdtempSync(join(tmpdir(), "rune-sysmem-other-"));
    const prev = process.env.RUNE_SYSTEM_MEMORY_PATH;
    try {
      process.env.RUNE_SYSTEM_MEMORY_PATH = join(other, "system-memory.md");
      writeFileSync(getSystemMemoryMetaPath(), bytes);
      expect(loadSystemMemoryMeta().mode).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.RUNE_SYSTEM_MEMORY_PATH;
      else process.env.RUNE_SYSTEM_MEMORY_PATH = prev;
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("a forged shrink floor cannot lower the floor", () => {
    saveSystemMemory("x".repeat(3000), {});
    const meta = JSON.parse(readFileSync(getSystemMemoryMetaPath(), "utf-8")) as Record<
      string,
      unknown
    >;
    meta.profileFloorBytes = 10;
    writeFileSync(getSystemMemoryMetaPath(), JSON.stringify(meta));
    expect(loadSystemMemoryMeta().profileFloorBytes).toBeUndefined();
    expect(saveRefreshedSystemMemory("y".repeat(200), {}).saved).toBe(false);
  });
});

// ─── V9 critical 2: where the key lives ───
//
// The whole force of the entry MAC is that the secret is out of the run's
// reach, and for one release it was a 0600 file a sandboxed `bash` could read:
// the verifier `cat`ted the founder's real key through the real native binary
// and signed a `user-corrected` / `pinned` / `promoted` forgery with it. The
// key is now an item in the OS credential store; the file is a migration
// source and a last resort.
//
// Every test here runs against an INJECTED runner, so the assertions are about
// the real code path and nothing ever reaches the founder's keychain. The
// backend in force is asserted in each one, because "it used the file store"
// is exactly the thing a test like this can silently start doing.
describe("shared/system-memory — the memory key is not a file a run can read", () => {
  let dir: string;
  let calls: Array<{ cmd: string; args: readonly string[]; input?: string }>;
  let vault: Map<string, string>;
  let prevBackend: string | undefined;

  const fakeStore = (opts?: { refuseWrite?: boolean }): void => {
    setMemoryKeyRunner((cmd, args, input) => {
      calls.push({ cmd, args, ...(input === undefined ? {} : { input }) });
      if (cmd === "security" && args[0] === "help") return { status: 0, stdout: "" };
      if (cmd === "security" && args[0] === "find-generic-password") {
        const account = args[args.indexOf("-a") + 1]!;
        const held = vault.get(account);
        return held ? { status: 0, stdout: held + "\n" } : { status: 44, stdout: "" };
      }
      if (cmd === "security" && args[0] === "add-generic-password") {
        if (opts?.refuseWrite) return { status: 45, stdout: "" };
        vault.set(args[args.indexOf("-a") + 1]!, args[args.indexOf("-w") + 1]!);
        return { status: 0, stdout: "" };
      }
      if (cmd === "secret-tool" && args[0] === "lookup") {
        const held = vault.get(args[args.indexOf("account") + 1]!);
        return held ? { status: 0, stdout: held } : { status: 1, stdout: "" };
      }
      if (cmd === "secret-tool" && args[0] === "store") {
        if (opts?.refuseWrite) return { status: 1, stdout: "" };
        vault.set(args[args.indexOf("account") + 1]!, input ?? "");
        return { status: 0, stdout: "" };
      }
      return { status: 127, stdout: "" };
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-key-"));
    calls = [];
    vault = new Map();
    prevBackend = process.env.RUNE_MEMORY_KEY_BACKEND;
  });
  afterEach(() => {
    setMemoryKeyRunner(null);
    forgetMemorySecretCache();
    if (prevBackend === undefined) delete process.env.RUNE_MEMORY_KEY_BACKEND;
    else process.env.RUNE_MEMORY_KEY_BACKEND = prevBackend;
    rmSync(dir, { recursive: true, force: true });
  });

  it("a scratch home under the temp directory never touches the OS credential store", () => {
    const where = memoryKeyLocation(dir);
    expect(where.backend).toBe("file");
    expect(where.secure).toBe(false);
    expect(where.account).toBe(getMemoryKeyPath(dir));
  });

  it("the key is minted into the keychain and never written to disk", () => {
    process.env.RUNE_MEMORY_KEY_BACKEND = "keychain";
    fakeStore();
    expect(memoryKeyLocation(dir).backend).toBe("keychain");
    const hex = loadMemorySecret(true, dir);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    // The thing the verifier read is not there to read.
    expect(existsSync(getMemoryKeyPath(dir))).toBe(false);
    expect([...vault.values()]).toEqual([hex!]);
    const write = calls.find((c) => c.args[0] === "add-generic-password")!;
    expect(write.cmd).toBe("security");
    // An empty trusted-application list: no other binary is pre-authorised.
    expect(write.args).toContain("-T");
    // …and the secret is an argv element of `security`, never a file.
    expect(loadMemorySecret(false, dir)).toBe(hex);
  });

  it("a read never mints, on either backend", () => {
    process.env.RUNE_MEMORY_KEY_BACKEND = "keychain";
    fakeStore();
    expect(loadMemorySecret(false, dir)).toBeNull();
    expect(vault.size).toBe(0);
    expect(existsSync(getMemoryKeyPath(dir))).toBe(false);
    delete process.env.RUNE_MEMORY_KEY_BACKEND;
    expect(memoryKeyLocation(dir).backend).toBe("file");
    expect(loadMemorySecret(false, dir)).toBeNull();
    expect(existsSync(getMemoryKeyPath(dir))).toBe(false);
  });

  it("a home that already has a .key imports it once and the file is gone", () => {
    // The founder's own home, as the verifier found it: a 65-byte 0600 file.
    const existing = "a".repeat(64);
    mkdirSync(dir, { recursive: true });
    writeFileSync(getMemoryKeyPath(dir), existing + "\n", { mode: 0o600 });
    process.env.RUNE_MEMORY_KEY_BACKEND = "keychain";
    fakeStore();
    // A READ migrates it — moving a key that already exists mints nothing.
    expect(loadMemorySecret(false, dir)).toBe(existing);
    expect(existsSync(getMemoryKeyPath(dir))).toBe(false);
    expect([...vault.values()]).toEqual([existing]);
    // The same secret, so everything signed before the move still verifies.
    forgetMemorySecretCache();
    expect(loadMemorySecret(false, dir)).toBe(existing);
    expect(memoryKeyLocation(dir).legacyFile).toBeUndefined();
  });

  it("a keychain that refuses the write leaves a 0600 file rather than unsigned memory", () => {
    process.env.RUNE_MEMORY_KEY_BACKEND = "keychain";
    fakeStore({ refuseWrite: true });
    const hex = loadMemorySecret(true, dir);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    const path = getMemoryKeyPath(dir);
    expect(existsSync(path)).toBe(true);
    // Windows has no POSIX mode bits to read back; the profile ACL is the guard there.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    // …and it is named as a key still on disk, so `rune memory` can say so.
    expect(memoryKeyLocation(dir).legacyFile).toBe(path);
    expect(memoryKeyLocation(dir).where).toContain("legacy");
  });

  it("says where the key is, in one line, on every backend", () => {
    expect(describeMemoryKey(dir)).toContain(getMemoryKeyPath(dir));
    process.env.RUNE_MEMORY_KEY_BACKEND = "keychain";
    fakeStore();
    expect(describeMemoryKey(dir)).toContain("Keychain");
    process.env.RUNE_MEMORY_KEY_BACKEND = "secret-service";
    expect(describeMemoryKey(dir)).toContain("Secret Service");
  });

  it("two homes hold two keys, so an entry cannot be carried between them", () => {
    process.env.RUNE_MEMORY_KEY_BACKEND = "keychain";
    fakeStore();
    const other = mkdtempSync(join(tmpdir(), "rune-key-b-"));
    try {
      const a = loadMemorySecret(true, dir);
      const b = loadMemorySecret(true, other);
      expect(a).not.toBe(b);
      expect(vault.size).toBe(2);
      expect(memoryMac("payload", false, dir)).not.toBe(memoryMac("payload", false, other));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
