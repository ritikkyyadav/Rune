// ─── System Memory store ("dreaming") ───
// Rune's evergreen profile of the user and the codebases they work in — a small,
// narrative GUIDE (not a list of rules) that gets injected into the system prompt
// so even tiny models get useful, personalised context cheaply. Two sidecars in
// ~/.rune/, same lenient pattern as model-store.ts / secrets.ts (a missing or
// malformed file is treated as empty and never throws):
//
//   • system-memory.md   — the human-readable guide (the text actually injected)
//   • system-memory.json — scheduling / bookkeeping metadata
//
// The guide is deliberately size-capped (see clampToBudget) so it stays
// butter-smooth for small context windows. It is refreshed either by the user
// (`/memory update`) or, in `auto` mode, by the agent itself when it judges a
// refresh worthwhile. There is no clock: see MemoryMode below.

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { basename, dirname, join } from "path";
import { getRuneHome } from "./paths.js";

// ─── Types ───

/**
 * The one user-facing memory control. Three values, and only three — the
 * founder withdrew the daily/weekly/3d cadence on 2026-09-15:
 *
 *   off     nothing is read, injected, extracted, refreshed or written
 *   auto    Rune manages its own memory: it learns at run end (zero spend) and
 *           may decide, at most once a session, to refresh the profile itself
 *   manual  the person holds the switch: `/memory update` is the only thing
 *           that extracts or refreshes; what was already learned is still read
 *
 * No value of this setting schedules anything on a clock.
 */
export type MemoryMode = "off" | "auto" | "manual";

/** The three, in the order every surface presents them. */
export const MEMORY_MODES: readonly MemoryMode[] = ["off", "auto", "manual"];

/** One line each, for `/config`, the first-run wizard and `/memory`. */
export const MEMORY_MODE_DESCRIPTIONS: Record<MemoryMode, string> = {
  off: "nothing is remembered, read or written",
  auto: "Rune decides when to update its memory",
  manual: "only `/memory update` changes it",
};

/** Who asked for a profile refresh. Recorded in the sidecar, shown by `/memory`. */
export type MemoryRefreshOrigin = "user" | "agent";

/**
 * LEGACY. How the withdrawn cadence was scheduled. Kept because a config file
 * written before 2026-09-15 still carries `schedule`, and the loader has to be
 * able to read it in order to migrate it (see resolveMemoryMode).
 */
export type MemoryScheduleKind = "manual" | "interval";

export interface ParsedSchedule {
  kind: MemoryScheduleKind;
  /** For kind === "interval": the period in days (1 = daily, 7 = weekly). */
  days?: number;
}

/**
 * A refreshed profile the floor turned away, kept in the meta sidecar so the
 * product can say what happened rather than leaving the user to notice that
 * their profile got smaller.
 */
export interface SystemMemoryRefusal {
  /** ISO timestamp of the refusal. */
  at: string;
  /** Why it was refused, in the words shown to the user. */
  reason: string;
  /** Bytes of the completion that was thrown away. */
  discardedBytes: number;
  /** Bytes of the profile that was kept. */
  previousBytes: number;
  /** Set once the refusal has been shown in the transcript. */
  notified?: boolean;
}

/**
 * The one-line note left behind when a withdrawn cadence was migrated to a
 * mode. Recorded once, shown once, and still readable afterwards — the user
 * chose `daily` at some point and deserves to be told it no longer exists.
 */
export interface MemoryModeMigration {
  at: string;
  /** What the config or sidecar actually said, e.g. "daily" or "enabled = false". */
  from: string;
  /** The mode it became. */
  mode: MemoryMode;
  /** The sentence shown to the user. */
  note: string;
  /** Set once it has been shown. */
  notified?: boolean;
}

/** The last profile refresh that actually landed — and who asked for it. */
export interface MemoryRefreshRecord {
  at: string;
  origin: MemoryRefreshOrigin;
  tokensBefore: number;
  tokensAfter: number;
}

export interface SystemMemoryMeta {
  /** ISO timestamp the content last changed (refresh, manual add/edit). */
  updatedAt?: string;
  /** ISO timestamp the profile distillation last ran. */
  lastReflectedAt?: string;
  /** Mode set live via `/memory off|auto|manual` — overrides the config default. */
  mode?: MemoryMode;
  /** The cadence→mode migration, recorded once (see MemoryModeMigration). */
  modeMigration?: MemoryModeMigration;
  /** The last refresh that landed, with its origin. */
  lastRefresh?: MemoryRefreshRecord;
  /** LEGACY cadence set via the withdrawn `/memory <cadence>`. Read to migrate; never written. */
  schedule?: string;
  /** Approx token size of the content at last save (for display). */
  tokens?: number;
  /** Per-session high-water seq already folded into memory (avoids re-reading). */
  foldedSeqBySession?: Record<string, number>;
  /** The most recent refresh the shrink floor refused (see saveRefreshedSystemMemory). */
  lastRefusal?: SystemMemoryRefusal;
  /**
   * The size the shrink floor is measured against — the profile's high-water
   * mark, not merely the file a refresh replaces. A deliberate write by the
   * PERSON resets it; a machine refresh may raise it and never lower it. See
   * profileShrinkReason: without this the floor is per-step, and seven refreshes
   * that are each individually legal take a 2.5 KB profile to 23 bytes.
   */
  profileFloorBytes?: number;
  /**
   * HMACs over the fields a hand-written sidecar must not be able to assert.
   * Computed with the per-home key (getMemoryKeyPath) on every save; a field
   * whose MAC does not verify is dropped on load, exactly as a forged entry
   * file is. Never trusted from the file itself — the key is not in it.
   */
  integrity?: SystemMemoryIntegrity;
}

/** The authenticated fields of the meta sidecar, one MAC each. */
export interface SystemMemoryIntegrity {
  v: number;
  mode?: string;
  modeMigration?: string;
  profileFloor?: string;
}

export interface SystemMemory {
  content: string;
  meta: SystemMemoryMeta;
}

// ─── Paths ───

/**
 * Resolve the memory file path. Honors `RUNE_SYSTEM_MEMORY_PATH` (tests / advanced
 * setups); otherwise `~/.rune/system-memory.md`. Computed per-call so the env
 * override always takes effect.
 */
export function getSystemMemoryPath(): string {
  const override = process.env.RUNE_SYSTEM_MEMORY_PATH;
  if (override) return override;
  return join(getRuneHome(), "system-memory.md");
}

/** The meta sidecar sits next to the md so the env override relocates both. */
export function getSystemMemoryMetaPath(): string {
  const md = getSystemMemoryPath();
  return md.replace(/\.md$/i, "") + ".json";
}

/**
 * The structured store behind the guide — `~/.rune/memory/`, one JSON file per
 * entry under `entries/`. The guide above is what a model reads; this is what
 * the guide is rendered FROM, and what carries provenance.
 *
 * Resolved here, beside the other two paths, so that a test pointing
 * `RUNE_SYSTEM_MEMORY_PATH` at a scratch file relocates the whole of memory
 * rather than half of it — a store that stayed in the real `~/.rune` while the
 * guide moved would be the one way a test suite could write on the founder's
 * own memory. When the override is set the store sits beside it.
 */
export function getMemoryStoreDir(): string {
  const override = process.env.RUNE_MEMORY_DIR;
  if (override) return override;
  const md = process.env.RUNE_SYSTEM_MEMORY_PATH;
  if (md) return join(dirname(md), "memory");
  return join(getRuneHome(), "memory");
}

/** Where the individual entry files live. */
export function getMemoryEntriesDir(): string {
  return join(getMemoryStoreDir(), "entries");
}

// ─── The per-home memory secret ───
//
// V8 critical 1. The read path re-derived the entry id and called that proof
// that a file "was not written by the store" — but an id is an UNKEYED hash of
// content a forger chooses, so the forger computes it too. The id proves the
// text and nothing about where the text came from: one `cat >` with an ordinary
// sentence bought `user-corrected`, `pinned` and `promoted` in every future
// session, with an empty refusal log.
//
// What the store actually needs is a secret only the store has. It is one file,
// 32 random bytes, mode 0600, created on the first WRITE and never on a read —
// and deliberately NOT in config.toml: a config file is copied between machines,
// pasted into issues and read by every tool in the repo, and a key that travels
// with the data it authenticates is not a key.
//
// Nothing here ever throws: a home whose key cannot be written is a home where
// memory does not verify, which means memory is empty. Memory is an amenity.

/**
 * The per-home HMAC key. Never in config, never in a backup, never logged.
 * `storeDir` lets a caller that already knows its own store directory (the
 * MemoryStore can be constructed with an explicit one) key against that rather
 * than against the ambient home.
 */
export function getMemoryKeyPath(storeDir?: string): string {
  return join(storeDir ?? getMemoryStoreDir(), ".key");
}

const KEY_RE = /^[0-9a-f]{64}$/;

/**
 * The secret, as hex. `create` mints one (0600) when there is none — passed
 * only by write paths, so a READ of a store that has never been written to
 * verifies nothing rather than quietly minting a key that would make the next
 * forgery verifiable.
 */
export function loadMemorySecret(create = false, storeDir?: string): string | null {
  const p = getMemoryKeyPath(storeDir);
  try {
    if (existsSync(p)) {
      const hex = readFileSync(p, "utf-8").trim();
      if (KEY_RE.test(hex)) return hex;
      // A key file that is not a key is not overwritten: it is someone else's
      // file, or a half-written one, and clobbering it would throw away every
      // entry it authenticated.
      return null;
    }
    if (!create) return null;
    const hex = randomBytes(32).toString("hex");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, hex + "\n", { mode: 0o600 });
    // Explicit, because `mode` is masked by umask on some systems.
    chmodSync(p, 0o600);
    return hex;
  } catch {
    return null;
  }
}

/** HMAC-SHA256 over a canonical payload, or undefined when there is no key. */
export function memoryMac(payload: string, create = false, storeDir?: string): string | undefined {
  const secret = loadMemorySecret(create, storeDir);
  if (!secret) return undefined;
  return createHmac("sha256", Buffer.from(secret, "hex")).update(payload).digest("hex");
}

/** Constant-time check. False for a missing key, a missing MAC, or a wrong one. */
export function verifyMemoryMac(payload: string, mac: unknown, storeDir?: string): boolean {
  if (typeof mac !== "string" || !KEY_RE.test(mac)) return false;
  const want = memoryMac(payload, false, storeDir);
  if (!want) return false;
  const a = Buffer.from(want, "hex");
  const b = Buffer.from(mac, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The canonical bytes each authenticated meta field is signed over. */
function modePayload(mode: MemoryMode): string {
  return JSON.stringify(["system-memory.mode", mode]);
}

function migrationPayload(m: MemoryModeMigration): string {
  return JSON.stringify([
    "system-memory.modeMigration",
    m.at,
    m.from,
    m.mode,
    m.note,
    m.notified === true,
  ]);
}

function floorPayload(bytes: number): string {
  return JSON.stringify(["system-memory.profileFloorBytes", bytes]);
}

// ─── Load / Save ───

/** Read the memory content + meta. Missing/malformed → empty (never throws). */
export function loadSystemMemory(): SystemMemory {
  let content = "";
  try {
    const p = getSystemMemoryPath();
    if (existsSync(p)) content = readFileSync(p, "utf-8");
  } catch {
    content = "";
  }
  return {
    content: content.trim() ? content.replace(/\s+$/, "") : "",
    meta: loadSystemMemoryMeta(),
  };
}

/** Read just the meta sidecar. Missing/malformed → empty (never throws). */
export function loadSystemMemoryMeta(): SystemMemoryMeta {
  try {
    const mp = getSystemMemoryMetaPath();
    if (!existsSync(mp)) return {};
    const raw = JSON.parse(readFileSync(mp, "utf-8")) as Record<string, unknown>;
    return sanitizeMeta(raw);
  } catch {
    return {};
  }
}

function sanitizeMeta(raw: Record<string, unknown>): SystemMemoryMeta {
  const m: SystemMemoryMeta = {};
  if (typeof raw.updatedAt === "string") m.updatedAt = raw.updatedAt;
  if (typeof raw.lastReflectedAt === "string") m.lastReflectedAt = raw.lastReflectedAt;
  if (typeof raw.schedule === "string") m.schedule = raw.schedule;
  if (typeof raw.tokens === "number") m.tokens = raw.tokens;
  // The three authenticated fields. `mode` is a CONTROL — it decides whether
  // Rune reads, writes and injects memory at all — so a hand-written sidecar
  // may not assert it. A field whose MAC does not verify is simply not there,
  // and the resolution falls through to the env, the config and the default.
  const integrity = (raw.integrity ?? {}) as Record<string, unknown>;
  {
    const mode = parseMemoryMode(raw.mode);
    if (mode && verifyMemoryMac(modePayload(mode), integrity.mode)) m.mode = mode;
  }
  if (raw.modeMigration && typeof raw.modeMigration === "object") {
    const g = raw.modeMigration as Record<string, unknown>;
    const mode = parseMemoryMode(g.mode);
    if (
      typeof g.at === "string" &&
      typeof g.from === "string" &&
      typeof g.note === "string" &&
      mode
    ) {
      const migration: MemoryModeMigration = {
        at: g.at,
        from: g.from,
        mode,
        note: g.note,
        ...(g.notified === true ? { notified: true } : {}),
      };
      if (verifyMemoryMac(migrationPayload(migration), integrity.modeMigration)) {
        m.modeMigration = migration;
      }
    }
  }
  if (
    typeof raw.profileFloorBytes === "number" &&
    Number.isFinite(raw.profileFloorBytes) &&
    raw.profileFloorBytes >= 0 &&
    verifyMemoryMac(floorPayload(raw.profileFloorBytes), integrity.profileFloor)
  ) {
    m.profileFloorBytes = raw.profileFloorBytes;
  }
  if (raw.lastRefresh && typeof raw.lastRefresh === "object") {
    const g = raw.lastRefresh as Record<string, unknown>;
    if (typeof g.at === "string" && (g.origin === "user" || g.origin === "agent")) {
      m.lastRefresh = {
        at: g.at,
        origin: g.origin,
        tokensBefore: typeof g.tokensBefore === "number" ? g.tokensBefore : 0,
        tokensAfter: typeof g.tokensAfter === "number" ? g.tokensAfter : 0,
      };
    }
  }
  if (raw.lastRefusal && typeof raw.lastRefusal === "object") {
    const r = raw.lastRefusal as Record<string, unknown>;
    if (typeof r.at === "string" && typeof r.reason === "string") {
      m.lastRefusal = {
        at: r.at,
        reason: r.reason,
        discardedBytes: typeof r.discardedBytes === "number" ? r.discardedBytes : 0,
        previousBytes: typeof r.previousBytes === "number" ? r.previousBytes : 0,
        ...(r.notified === true ? { notified: true } : {}),
      };
    }
  }
  if (raw.foldedSeqBySession && typeof raw.foldedSeqBySession === "object") {
    const folded: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.foldedSeqBySession as Record<string, unknown>)) {
      if (typeof v === "number") folded[k] = v;
    }
    if (Object.keys(folded).length) m.foldedSeqBySession = folded;
  }
  return m;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Backups and the shrink floor ───
//
// The profile is the one file in Rune that a single model completion could
// REPLACE wholesale. On 2026-09-15 a daily dream returned 76 tokens and the
// founder's 3,976-byte evergreen profile became 326 bytes ending mid-word.
// There was no diff, no backup and no floor. Two rules close that:
//
//   1. Every write keeps the file it is about to replace, newest five.
//   2. A REFRESHED profile (the dream, which is a machine replacing the whole
//      file unasked) has to be plausibly the same profile: not less than half
//      of what it replaces, and not a stub where a real profile stood.
//
// A person shortening their own profile by hand is not covered by rule 2 —
// they meant it, and rule 1 keeps the old copy for them anyway.

/** How many `.bak-*` copies of the profile are kept. */
export const MAX_SYSTEM_MEMORY_BACKUPS = 5;
/** A refresh may not fall below this fraction of the profile it replaces. */
export const PROFILE_SHRINK_FLOOR_RATIO = 0.5;
/** Below this many bytes a refresh is a stub, when the profile it replaces was substantial. */
export const PROFILE_MIN_BYTES = 400;
/** A previous profile at least this large is "substantial" for PROFILE_MIN_BYTES. */
export const PROFILE_SUBSTANTIAL_BYTES = 800;

export interface SystemMemoryBackup {
  path: string;
  /** The timestamp encoded in the filename (filesystem-safe ISO 8601). */
  stamp: string;
  bytes: number;
}

/** Filenames carry a colon-free ISO 8601 stamp so they sort lexicographically everywhere. */
function backupStamp(now: Date): string {
  return now.toISOString().replace(/:/g, "-");
}

const BAK_SUFFIX = ".bak-";

/** Every kept copy of the profile, newest first. Never throws. */
export function listSystemMemoryBackups(): SystemMemoryBackup[] {
  try {
    const p = getSystemMemoryPath();
    const dir = dirname(p);
    const prefix = basename(p) + BAK_SUFFIX;
    if (!existsSync(dir)) return [];
    const out: SystemMemoryBackup[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const full = join(dir, name);
      let bytes = 0;
      try {
        bytes = Buffer.byteLength(readFileSync(full, "utf-8"));
      } catch {
        continue;
      }
      out.push({ path: full, stamp: name.slice(prefix.length), bytes });
    }
    // The stamp is fixed-width ISO, so a string sort IS a time sort.
    return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  } catch {
    return [];
  }
}

/** Drop all but the newest `keep` backups. Returns the paths removed. Never throws. */
export function pruneSystemMemoryBackups(keep = MAX_SYSTEM_MEMORY_BACKUPS): string[] {
  const removed: string[] = [];
  for (const b of listSystemMemoryBackups().slice(Math.max(0, keep))) {
    try {
      unlinkSync(b.path);
      removed.push(b.path);
    } catch {
      // ignore — a backup we cannot remove is not worth failing a save over
    }
  }
  return removed;
}

/**
 * Copy the profile as it stands to `system-memory.md.bak-<stamp>` and prune to
 * the newest MAX_SYSTEM_MEMORY_BACKUPS. Returns the backup path, or undefined
 * when there was nothing to keep (no file, or an empty one). Never throws.
 */
export function backupSystemMemory(now: Date = new Date()): string | undefined {
  try {
    const p = getSystemMemoryPath();
    if (!existsSync(p)) return undefined;
    const current = readFileSync(p, "utf-8");
    if (!current.trim()) return undefined;
    let dest = p + BAK_SUFFIX + backupStamp(now);
    // Two saves inside the same millisecond must not silently become one.
    if (existsSync(dest)) {
      let n = 2;
      while (existsSync(`${dest}.${n}`) && n < 100) n++;
      dest = `${dest}.${n}`;
    }
    ensureDir(dest);
    writeFileSync(dest, current);
    pruneSystemMemoryBackups();
    return dest;
  } catch {
    return undefined;
  }
}

/**
 * The floor, as a sentence or nothing. `previous` is the profile on disk,
 * `next` the refreshed one. Bytes, not tokens: the failure this guards was
 * measured in bytes and a byte is a thing the user can check.
 */
export function profileShrinkReason(
  previous: string,
  next: string,
  /**
   * The profile's HIGH-WATER mark in bytes, when the caller knows it. V8
   * finding 10: a floor that compares each refresh only to the file it replaces
   * is a floor per STEP, and seven refreshes at 51% — each one individually
   * legal — took 2,539 bytes to 23 and rotated the real profile out of a
   * five-deep backup ring on the way. Measured against the high-water mark the
   * second of those seven is refused and the first backup is still the original.
   */
  previousHigh?: number,
): string | undefined {
  const prevBytes = Buffer.byteLength(previous.trim());
  const nextBytes = Buffer.byteLength(next.trim());
  const high = Math.max(prevBytes, previousHigh ?? 0);
  if (high === 0) return undefined;
  if (nextBytes === 0) return `the refresh was empty and the profile on disk is ${prevBytes} bytes`;
  const against = high > prevBytes ? `${high} bytes at its largest` : `${prevBytes} bytes`;
  // The absolute floor is asked first because it is the more specific thing to
  // say about the shape that actually happened — a stub where a real profile
  // stood. (For any previous over 800 bytes the half-rule below would also
  // refuse it; this one names the reason a reader recognises.)
  if (high > PROFILE_SUBSTANTIAL_BYTES && nextBytes < PROFILE_MIN_BYTES) {
    return `the refresh is ${nextBytes} bytes, under the ${PROFILE_MIN_BYTES}-byte floor for a profile that was ${against}`;
  }
  if (nextBytes < high * PROFILE_SHRINK_FLOOR_RATIO) {
    return `the refresh is ${nextBytes} bytes against ${against} — less than half the profile it replaces`;
  }
  return undefined;
}

/**
 * The size the floor is measured against. The recorded high-water wins once
 * anything has written it; a home that predates the record falls back to the
 * largest copy still in the backup ring, which is the only other place the
 * profile's real size survives.
 */
export function profileFloorBaseline(meta: SystemMemoryMeta): number {
  if (typeof meta.profileFloorBytes === "number") return meta.profileFloorBytes;
  return Math.max(0, ...listSystemMemoryBackups().map((b) => b.bytes));
}

/**
 * Persist the memory content (md) and merge a meta patch (json). Never throws —
 * a write failure must not crash the CLI (the in-memory state already applied).
 * Keeps the file it replaces (see backupSystemMemory).
 * Returns the merged meta that was written.
 */
export function saveSystemMemory(
  content: string,
  metaPatch?: Partial<SystemMemoryMeta>,
): SystemMemoryMeta {
  const text = content.trim();
  try {
    const p = getSystemMemoryPath();
    backupSystemMemory();
    ensureDir(p);
    writeFileSync(p, text ? text + "\n" : "");
  } catch {
    // ignore — persistence failed but the caller's in-memory state still applied
  }
  // A write through THIS door is a person writing their own profile, so it
  // RESETS the high-water mark: someone who shortens their profile by hand
  // meant it, and a floor that remembered the long version forever would refuse
  // every honest refresh afterwards. The refresh path passes its own value.
  return saveSystemMemoryMeta({
    profileFloorBytes: Buffer.byteLength(text),
    ...(metaPatch ?? {}),
  });
}

/**
 * The dream's save path: the same write, with the floor in front of it.
 *
 * On a refusal nothing on disk changes except the meta sidecar, which records
 * what was thrown away so `/memory` and the transcript can say so. `refusedMeta`
 * is what the caller still wants recorded when the save does not happen —
 * typically `lastReflectedAt` alone, so a rotting model does not re-run the
 * same dream on every launch while the activity it read stays unfolded.
 */
export function saveRefreshedSystemMemory(
  content: string,
  metaPatch: Partial<SystemMemoryMeta>,
  refusedMeta?: Partial<SystemMemoryMeta>,
): { saved: boolean; refusal?: SystemMemoryRefusal; meta: SystemMemoryMeta } {
  const { content: previous, meta: before } = loadSystemMemory();
  const high = profileFloorBaseline(before);
  const reason = profileShrinkReason(previous, content, high);
  if (reason) {
    const refusal: SystemMemoryRefusal = {
      at: new Date().toISOString(),
      reason,
      discardedBytes: Buffer.byteLength(content.trim()),
      previousBytes: Buffer.byteLength(previous.trim()),
    };
    // Nothing on disk moves but the meta: no write, so no backup is taken and
    // no kept copy is rotated out of the ring by a refresh that was refused.
    const meta = saveSystemMemoryMeta({ ...(refusedMeta ?? {}), lastRefusal: refusal });
    return { saved: false, refusal, meta };
  }
  // A machine refresh may RAISE the high-water mark and never lower it.
  return {
    saved: true,
    meta: saveSystemMemory(content, {
      ...metaPatch,
      profileFloorBytes: Math.max(high, Buffer.byteLength(content.trim())),
    }),
  };
}

/**
 * Put a kept copy back. `from` names a specific backup (full path, basename or
 * stamp); without it the newest one wins.
 *
 * A restore deliberately does NOT take a backup of what it replaces. If it did,
 * the profile the user is undoing would become the newest backup and a second
 * `restore` would hand it straight back — an undo that alternates is not an
 * undo. The backup being restored from stays on disk, so restoring twice is the
 * same as restoring once, and every other kept copy is still there to pick by
 * name.
 */
export function restoreSystemMemory(from?: string): {
  restored: boolean;
  from?: string;
  bytes?: number;
  reason?: string;
} {
  const backups = listSystemMemoryBackups();
  let chosen: SystemMemoryBackup | undefined;
  if (from) {
    chosen =
      backups.find((b) => b.path === from) ??
      backups.find((b) => basename(b.path) === from) ??
      backups.find((b) => b.stamp === from);
    if (!chosen) return { restored: false, reason: `no backup named ${from}` };
  } else {
    chosen = backups[0];
    if (!chosen) return { restored: false, reason: "no backup to restore" };
  }
  let text: string;
  try {
    text = readFileSync(chosen.path, "utf-8");
  } catch {
    return { restored: false, reason: `could not read ${chosen.path}` };
  }
  const body = text.trim();
  try {
    const p = getSystemMemoryPath();
    ensureDir(p);
    writeFileSync(p, body ? body + "\n" : "");
  } catch {
    return { restored: false, reason: `could not write ${getSystemMemoryPath()}` };
  }
  // The damage is undone, so the refusal that recorded it is no longer news.
  const merged = { ...loadSystemMemoryMeta() };
  delete merged.lastRefusal;
  merged.updatedAt = new Date().toISOString();
  merged.tokens = estimateMemoryTokens(body);
  // A restore is the person choosing this profile: it is the high-water mark now.
  merged.profileFloorBytes = Buffer.byteLength(body);
  // Explicitly undefined rather than absent: the save MERGES over what is on
  // disk, so a key that is merely missing from the patch is a key that stays.
  saveSystemMemoryMeta({ ...merged, lastRefusal: undefined });
  return { restored: true, from: chosen.path, bytes: Buffer.byteLength(body) };
}

/**
 * Merge a patch into the meta sidecar (leaves the md untouched). Never throws.
 *
 * Every save re-signs the authenticated fields, which is also what mints the
 * per-home key: memory that has never been written has no key, and a store with
 * no key verifies nothing rather than verifying anything.
 */
export function saveSystemMemoryMeta(patch: Partial<SystemMemoryMeta>): SystemMemoryMeta {
  const merged: SystemMemoryMeta = { ...loadSystemMemoryMeta(), ...patch };
  // `undefined` in a patch means "clear this" — JSON.stringify drops it, and
  // the MAC below must not be written for a field that is no longer there.
  for (const k of Object.keys(merged) as Array<keyof SystemMemoryMeta>) {
    if (merged[k] === undefined) delete merged[k];
  }
  const integrity: SystemMemoryIntegrity = { v: 1 };
  if (merged.mode) integrity.mode = memoryMac(modePayload(merged.mode), true);
  if (merged.modeMigration) {
    integrity.modeMigration = memoryMac(migrationPayload(merged.modeMigration), true);
  }
  if (merged.profileFloorBytes !== undefined) {
    integrity.profileFloor = memoryMac(floorPayload(merged.profileFloorBytes), true);
  }
  merged.integrity = integrity;
  try {
    const mp = getSystemMemoryMetaPath();
    ensureDir(mp);
    writeFileSync(mp, JSON.stringify(merged, null, 2) + "\n");
  } catch {
    // ignore
  }
  return merged;
}

/**
 * Wipe the memory content. Keeps the user's chosen MODE but resets the refresh
 * bookkeeping so the next update rebuilds from scratch. Clearing the profile is
 * not a request to start being remembered again, or to stop.
 */
export function clearSystemMemory(): void {
  const { mode, schedule } = loadSystemMemoryMeta();
  try {
    const p = getSystemMemoryPath();
    // A wipe is a write like any other: the copy is what makes `/memory clear`
    // a decision the user can take back.
    backupSystemMemory();
    ensureDir(p);
    writeFileSync(p, "");
  } catch {
    // ignore
  }
  try {
    const mp = getSystemMemoryMetaPath();
    ensureDir(mp);
    // Empty first, then re-sign what is kept: a hand-written mode is not a mode
    // (see sanitizeMeta), so the mode has to be written back through the door
    // that signs it rather than copied across as bytes.
    writeFileSync(mp, "{}\n");
    const kept: SystemMemoryMeta = { profileFloorBytes: 0 };
    if (mode) kept.mode = mode;
    if (schedule) kept.schedule = schedule;
    saveSystemMemoryMeta(kept);
  } catch {
    // ignore
  }
}

// ─── Modes ───

/**
 * Parse a mode. Strict on purpose: only the three words (and the handful of
 * spellings a person actually types for them) are a mode. A withdrawn cadence
 * is NOT silently read as a mode here — resolveMemoryMode migrates it, loudly.
 */
export function parseMemoryMode(v: unknown): MemoryMode | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s === "off" || s === "none" || s === "disabled" || s === "no") return "off";
  if (s === "auto" || s === "automatic" || s === "on" || s === "yes") return "auto";
  if (s === "manual" || s === "user") return "manual";
  return undefined;
}

/** The mode plus its one-line description, for a surface that shows both. */
export function describeMemoryMode(mode: MemoryMode): string {
  return MEMORY_MODE_DESCRIPTIONS[mode];
}

/** What a legacy setting is called when the migration note names it. */
function legacyLabel(schedule: string | undefined, enabled: boolean | undefined): string {
  if (enabled === false) return "enabled = false";
  return (schedule ?? "").trim() || "manual";
}

export interface ResolvedMemoryMode {
  mode: MemoryMode;
  /** Set when a withdrawn cadence or `enabled` flag produced this mode. */
  migration?: { from: string; note: string };
}

/**
 * The one resolution every surface uses. The precedence, and V8 finding 8:
 *
 *   RUNE_MEMORY_MODE  →  [memory] mode / enabled  →  the live sidecar  →
 *   the migration off the withdrawn controls  →  the default
 *
 * The sidecar used to sit at the TOP of that list, which meant that once
 * `~/.rune/system-memory.json` carried a mode — as the founder's did —
 * `RUNE_MEMORY_MODE=off`, `[memory] mode = "off"` and `[memory] enabled =
 * false` were all inert, and the only way to turn memory off was to be inside a
 * running session and type `/memory off`. A control surface with no switch
 * outside the thing it controls is not a switch. The env var is read here
 * rather than left to the config loader so that it works for every embedder,
 * including one that assembles its own config object.
 *
 * `/memory <mode>` still takes effect immediately and still persists, because
 * Engine.setMemoryMode now writes BOTH the live sidecar and `[memory] mode` —
 * so the two agree unless somebody edits the config by hand, and a hand edit is
 * the deliberate act that ought to win.
 *
 * The migration, in full:
 *   enabled = false            → off
 *   schedule = daily|weekly|Nd → auto  ("cadence withdrawn; memory is now auto")
 *   schedule = manual|off      → manual
 *   nothing at all             → the caller's default (auto for the CLI)
 *
 * `enabled = false` is asked before the sidecar because a user who switched
 * memory off in their config meant the off.
 */
export function resolveMemoryMode(
  cfg: { mode?: string; enabled?: boolean; schedule?: string } | undefined,
  meta: SystemMemoryMeta | undefined,
  fallback: MemoryMode = "auto",
): ResolvedMemoryMode {
  const env = parseMemoryMode(process.env.RUNE_MEMORY_MODE);
  if (env) return { mode: env };
  const explicit = parseMemoryMode(cfg?.mode);
  if (explicit) return { mode: explicit };
  if (cfg?.enabled === false) {
    return {
      mode: "off",
      migration: {
        from: "enabled = false",
        note: "[memory] enabled is withdrawn; memory is now off (/memory auto turns it on)",
      },
    };
  }
  // A mode chosen live via `/memory`, below the two settings a person can reach
  // without a session and above everything legacy.
  const live = meta?.mode;
  if (live) {
    // V8 finding 31: a sidecar carrying BOTH a live mode and a withdrawn
    // cadence used to short-circuit here and never mention the cadence. They
    // chose `daily`; they are entitled to be told it no longer exists.
    const leftover = (meta?.schedule ?? "").trim();
    if (leftover) {
      return {
        mode: live,
        migration: {
          from: leftover,
          note: `cadence withdrawn; memory is now ${live} (it was ${describeSchedule(leftover)})`,
        },
      };
    }
    return { mode: live };
  }
  // The live cadence in the sidecar is as much a user choice as the config one.
  const schedule = (meta?.schedule ?? cfg?.schedule ?? "").trim();
  if (schedule) {
    const parsed = parseSchedule(schedule);
    if (parsed.kind === "interval") {
      return {
        mode: "auto",
        migration: {
          from: legacyLabel(schedule, cfg?.enabled),
          note: `cadence withdrawn; memory is now auto (it was ${describeSchedule(schedule)})`,
        },
      };
    }
    return {
      mode: "manual",
      migration: {
        from: legacyLabel(schedule, cfg?.enabled),
        note: "cadence withdrawn; memory is now manual (/memory update is the only thing that changes it)",
      },
    };
  }
  return { mode: fallback };
}

/** The three-mode refusal every surface prints when handed a withdrawn cadence. */
export const MEMORY_CADENCE_REFUSAL =
  "memory has three modes — off, auto, manual. Cadences (daily, weekly, 3d) are withdrawn: " +
  "auto lets Rune decide when to update, manual waits for /memory update.";

/** True for the words the withdrawn cadence surface used to accept. */
export function isWithdrawnCadence(s: string): boolean {
  const v = s.trim().toLowerCase();
  if (!v) return false;
  if (v === "daily" || v === "day" || v === "everyday" || v === "weekly" || v === "week") {
    return true;
  }
  return /^\d+\s*(?:d\b|days?\b)/.test(v) || /^every\s+\d+/.test(v);
}

// ─── Scheduling (LEGACY — read to migrate, never written) ───

/**
 * Parse a cadence string into a normalised schedule. Accepts:
 *   manual | off | none           → manual (no automatic dream)
 *   daily | weekly                → interval 1 / 7 days
 *   "3d" | "3 days" | "every 3 days" → interval N days
 * Unknown input is treated as `manual` (the safe, no-spend default).
 */
export function parseSchedule(s: string | undefined | null): ParsedSchedule {
  const v = (s ?? "").trim().toLowerCase();
  if (!v || v === "manual" || v === "off" || v === "none" || v === "never" || v === "disabled") {
    return { kind: "manual" };
  }
  if (v === "daily" || v === "day" || v === "everyday") return { kind: "interval", days: 1 };
  if (v === "weekly" || v === "week") return { kind: "interval", days: 7 };
  const m = v.match(/(\d+)\s*(?:d\b|day)/) ?? v.match(/every\s+(\d+)\s*days?/);
  if (m) {
    const days = parseInt(m[1], 10);
    if (Number.isFinite(days) && days > 0) return { kind: "interval", days };
  }
  return { kind: "manual" };
}

/** Human label for a cadence, e.g. "daily", "every 3 days", "weekly", "manual". */
export function describeSchedule(s: string | undefined): string {
  const parsed = parseSchedule(s);
  if (parsed.kind !== "interval" || !parsed.days) return "manual";
  if (parsed.days === 1) return "daily";
  if (parsed.days === 7) return "weekly";
  return `every ${parsed.days} days`;
}

/**
 * Whether the automatic dream is due: only for interval schedules, and only once
 * the interval has elapsed since the last reflection (or never reflected before).
 */
export function isReflectionDue(
  meta: SystemMemoryMeta,
  schedule: string | undefined,
  now: number = Date.now(),
): boolean {
  const parsed = parseSchedule(schedule);
  if (parsed.kind !== "interval" || !parsed.days) return false;
  if (!meta.lastReflectedAt) return true;
  const last = Date.parse(meta.lastReflectedAt);
  if (Number.isNaN(last)) return true;
  return now - last >= parsed.days * 24 * 60 * 60 * 1000;
}

/** Active cadence: a value set live via `/memory` wins over the config default. */
export function effectiveSchedule(
  meta: SystemMemoryMeta,
  configSchedule: string | undefined,
): string {
  if (meta.schedule && meta.schedule.trim()) return meta.schedule;
  if (configSchedule && configSchedule.trim()) return configSchedule;
  return "manual";
}

// ─── Size budget ───

/** Rough token estimate for display/budgeting (~4 chars/token). */
export function estimateMemoryTokens(content: string): number {
  return Math.ceil(content.trim().length / 4);
}

/**
 * Hard backstop so the memory never bloats a small context window. The
 * distillation prompt also asks the model to stay brief; this just *guarantees*
 * it. Trims on a paragraph/line boundary when possible and marks the cut.
 */
export function clampToBudget(content: string, maxTokens: number): string {
  const text = content.trim();
  if (!text) return "";
  const maxChars = Math.max(400, Math.floor(maxTokens * 4));
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastPara = slice.lastIndexOf("\n\n");
  const lastNl = slice.lastIndexOf("\n");
  const cut =
    lastPara > maxChars * 0.5 ? lastPara : lastNl > maxChars * 0.6 ? lastNl : slice.length;
  return slice.slice(0, cut).trimEnd() + "\n\n_(memory trimmed to fit budget)_";
}
