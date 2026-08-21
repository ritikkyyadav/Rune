// ─── System Memory store ("dreaming") ───
// Gear's evergreen profile of the user and the codebases they work in — a small,
// narrative GUIDE (not a list of rules) that gets injected into the system prompt
// so even tiny models get useful, personalised context cheaply. Two sidecars in
// ~/.alan/, same lenient pattern as model-store.ts / secrets.ts (a missing or
// malformed file is treated as empty and never throws):
//
//   • system-memory.md   — the human-readable guide (the text actually injected)
//   • system-memory.json — scheduling / bookkeeping metadata
//
// The guide is deliberately size-capped (see clampToBudget) so it stays
// butter-smooth for small context windows. It is refreshed either manually
// (`/memory update`) or automatically on a user-chosen cadence (the "dream").

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

// ─── Types ───

/** How the automatic refresh ("dream") is scheduled. */
export type MemoryScheduleKind = "manual" | "interval";

export interface ParsedSchedule {
  kind: MemoryScheduleKind;
  /** For kind === "interval": the period in days (1 = daily, 7 = weekly). */
  days?: number;
}

export interface SystemMemoryMeta {
  /** ISO timestamp the content last changed (dream, manual add/edit). */
  updatedAt?: string;
  /** ISO timestamp the automatic distillation ("dream") last ran. */
  lastReflectedAt?: string;
  /** User-chosen cadence set via `/memory <cadence>` — overrides the config default. */
  schedule?: string;
  /** Approx token size of the content at last save (for display). */
  tokens?: number;
  /** Per-session high-water seq already folded into memory (avoids re-reading). */
  foldedSeqBySession?: Record<string, number>;
}

export interface SystemMemory {
  content: string;
  meta: SystemMemoryMeta;
}

// ─── Paths ───

/**
 * Resolve the memory file path. Honors `ALAN_SYSTEM_MEMORY_PATH` (tests / advanced
 * setups); otherwise `~/.alan/system-memory.md`. Computed per-call so the env
 * override always takes effect.
 */
export function getSystemMemoryPath(): string {
  const override =
    process.env.GEAR_SYSTEM_MEMORY_PATH ??
    process.env.ELIO_SYSTEM_MEMORY_PATH ??
    process.env.ALAN_SYSTEM_MEMORY_PATH;
  if (override) return override;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".alan", "system-memory.md");
}

/** The meta sidecar sits next to the md so the env override relocates both. */
export function getSystemMemoryMetaPath(): string {
  const md = getSystemMemoryPath();
  return md.replace(/\.md$/i, "") + ".json";
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

/**
 * Persist the memory content (md) and merge a meta patch (json). Never throws —
 * a write failure must not crash the CLI (the in-memory state already applied).
 * Returns the merged meta that was written.
 */
export function saveSystemMemory(
  content: string,
  metaPatch?: Partial<SystemMemoryMeta>,
): SystemMemoryMeta {
  const text = content.trim();
  try {
    const p = getSystemMemoryPath();
    ensureDir(p);
    writeFileSync(p, text ? text + "\n" : "");
  } catch {
    // ignore — persistence failed but the caller's in-memory state still applied
  }
  return saveSystemMemoryMeta(metaPatch ?? {});
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
 * Wipe the memory content. Keeps the user's chosen cadence (`schedule`) but
 * resets the dream bookkeeping so the next refresh rebuilds from scratch.
 */
export function clearSystemMemory(): void {
  const schedule = loadSystemMemoryMeta().schedule;
  try {
    const p = getSystemMemoryPath();
    ensureDir(p);
    writeFileSync(p, "");
  } catch {
    // ignore
  }
  try {
    const mp = getSystemMemoryMetaPath();
    ensureDir(mp);
    writeFileSync(mp, JSON.stringify(schedule ? { schedule } : {}, null, 2) + "\n");
  } catch {
    // ignore
  }
}

// ─── Scheduling ───

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
