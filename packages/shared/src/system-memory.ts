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

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
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
  {
    const mode = parseMemoryMode(raw.mode);
    if (mode) m.mode = mode;
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
      m.modeMigration = {
        at: g.at,
        from: g.from,
        mode,
        note: g.note,
        ...(g.notified === true ? { notified: true } : {}),
      };
    }
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
export function profileShrinkReason(previous: string, next: string): string | undefined {
  const prevBytes = Buffer.byteLength(previous.trim());
  const nextBytes = Buffer.byteLength(next.trim());
  if (prevBytes === 0) return undefined;
  if (nextBytes === 0) return `the refresh was empty and the profile on disk is ${prevBytes} bytes`;
  // The absolute floor is asked first because it is the more specific thing to
  // say about the shape that actually happened — a stub where a real profile
  // stood. (For any previous over 800 bytes the half-rule below would also
  // refuse it; this one names the reason a reader recognises.)
  if (prevBytes > PROFILE_SUBSTANTIAL_BYTES && nextBytes < PROFILE_MIN_BYTES) {
    return `the refresh is ${nextBytes} bytes, under the ${PROFILE_MIN_BYTES}-byte floor for a profile that was ${prevBytes} bytes`;
  }
  if (nextBytes < prevBytes * PROFILE_SHRINK_FLOOR_RATIO) {
    return `the refresh is ${nextBytes} bytes against ${prevBytes} on disk — less than half the profile it replaces`;
  }
  return undefined;
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
  return saveSystemMemoryMeta(metaPatch ?? {});
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
  const { content: previous } = loadSystemMemory();
  const reason = profileShrinkReason(previous, content);
  if (reason) {
    const refusal: SystemMemoryRefusal = {
      at: new Date().toISOString(),
      reason,
      discardedBytes: Buffer.byteLength(content.trim()),
      previousBytes: Buffer.byteLength(previous.trim()),
    };
    const meta = saveSystemMemoryMeta({ ...(refusedMeta ?? {}), lastRefusal: refusal });
    return { saved: false, refusal, meta };
  }
  return { saved: true, meta: saveSystemMemory(content, metaPatch) };
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
  try {
    const mp = getSystemMemoryMetaPath();
    ensureDir(mp);
    writeFileSync(mp, JSON.stringify(merged, null, 2) + "\n");
  } catch {
    // ignore — the profile itself is back, which is what was asked for
  }
  return { restored: true, from: chosen.path, bytes: Buffer.byteLength(body) };
}

/** Merge a patch into the meta sidecar (leaves the md untouched). Never throws. */
export function saveSystemMemoryMeta(patch: Partial<SystemMemoryMeta>): SystemMemoryMeta {
  const merged: SystemMemoryMeta = { ...loadSystemMemoryMeta(), ...patch };
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
    const kept: SystemMemoryMeta = {};
    if (mode) kept.mode = mode;
    if (schedule) kept.schedule = schedule;
    writeFileSync(mp, JSON.stringify(kept, null, 2) + "\n");
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
 * The one resolution every surface uses: live sidecar mode → explicit config
 * mode → migration from the withdrawn controls → the default.
 *
 * The migration, in full:
 *   enabled = false            → off
 *   schedule = daily|weekly|Nd → auto  ("cadence withdrawn; memory is now auto")
 *   schedule = manual|off      → manual
 *   nothing at all             → the caller's default (auto for the CLI)
 *
 * `enabled = false` is asked FIRST because a user who switched memory off and
 * left a cadence behind meant the off.
 */
export function resolveMemoryMode(
  cfg: { mode?: string; enabled?: boolean; schedule?: string } | undefined,
  meta: SystemMemoryMeta | undefined,
  fallback: MemoryMode = "auto",
): ResolvedMemoryMode {
  // A mode chosen live wins over anything in the file — same precedence the
  // withdrawn cadence had, so `/memory manual` keeps meaning what it meant.
  const live = meta?.mode;
  if (live) return { mode: live };
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
