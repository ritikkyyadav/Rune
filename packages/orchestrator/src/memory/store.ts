// ─── The memory store ───
//
// `~/.rune/memory/entries/<id>.json`, one file per entry. Not a database, on
// purpose: the founder has to be able to `cat` a memory, see where it came
// from, and `rm` it — a memory the user cannot read and cannot delete by hand
// is a memory they have to take on trust, and this repo's own history says that
// trust is exactly what a learned store has not yet earned.
//
// Same lenient contract as every other sidecar here (model-store, secrets,
// system-memory): a missing or malformed file is an empty store and never
// throws. Memory is an amenity. It may not break a run.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";

import { getMemoryEntriesDir, getMemoryStoreDir } from "@rune/shared";

import { guardMemoryText } from "./guard";
import {
  MAX_ENTRIES,
  MAX_TEXT_CHARS,
  type MemoryCandidate,
  type MemoryEntry,
  type MemoryKind,
  type MemoryRefusal,
  type MemoryScope,
  type MemorySource,
  type MemoryStatus,
  sameScope,
  scopeKey,
} from "./types";

/** The refusal log's ceiling — it is a diary, not an archive. */
const REFUSAL_LOG_LINES = 200;

export interface StoreResult {
  entry?: MemoryEntry;
  refusal?: MemoryRefusal;
  /** True when this call created the entry rather than bumping an existing one. */
  created?: boolean;
}

export class MemoryStore {
  private readonly dir: string;
  private readonly entriesDir: string;

  constructor(dir?: string) {
    this.dir = dir ?? getMemoryStoreDir();
    this.entriesDir = dir ? join(dir, "entries") : getMemoryEntriesDir();
  }

  get root(): string {
    return this.dir;
  }

  // ── Read ──

  /** Every entry on disk, in a stable order (id). Malformed files are skipped. */
  all(): MemoryEntry[] {
    let names: string[];
    try {
      if (!existsSync(this.entriesDir)) return [];
      names = readdirSync(this.entriesDir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: MemoryEntry[] = [];
    for (const name of names.sort()) {
      const entry = this.readFile(join(this.entriesDir, name));
      if (entry) out.push(entry);
    }
    return out;
  }

  get(id: string): MemoryEntry | undefined {
    return this.readFile(this.pathFor(id)) ?? undefined;
  }

  /** Promoted entries only, optionally narrowed to one workspace. Superseded
   *  and candidate entries are never returned here — the renderer reads this,
   *  and quarantine that reaches a prompt is not quarantine. */
  promoted(workspace?: string, at: Date = new Date()): MemoryEntry[] {
    const now = at.getTime();
    return this.all().filter((e) => {
      if (e.status !== "promoted") return false;
      if (!e.pinned && e.expiresAt && Date.parse(e.expiresAt) <= now) return false;
      if (e.scope === "global") return true;
      return workspace !== undefined && e.scope.workspace === workspace;
    });
  }

  candidates(): MemoryEntry[] {
    return this.all().filter((e) => e.status === "candidate");
  }

  // ── Write ──

  /**
   * Record a candidate. Idempotent on content: the same fact from a second
   * session bumps `observedCount` and adds the session id rather than landing
   * twice, which is what makes "seen in two sessions" a countable thing at all.
   *
   * Every write goes through the guard, including this one — there is no path
   * into the store that skips it.
   */
  observe(candidate: MemoryCandidate, now: Date = new Date()): StoreResult {
    const text = normalizeText(candidate.text);
    const verdict = guardMemoryText(text);
    if (!verdict.ok) {
      this.logRefusal(verdict.refusal!, now);
      return { refusal: verdict.refusal };
    }
    const id = entryId(candidate.kind, candidate.scope, text);
    const existing = this.get(id);
    const at = now.toISOString();

    if (existing) {
      const sessionIds = existing.provenance.sessionIds.includes(candidate.sessionId)
        ? existing.provenance.sessionIds
        : [...existing.provenance.sessionIds, candidate.sessionId];
      const seenAgain = sessionIds.length > existing.provenance.sessionIds.length;
      const next: MemoryEntry = {
        ...existing,
        // A stronger source upgrades the entry: a fact first merely OBSERVED
        // and later stated outright by the user is the user's fact now.
        provenance: {
          ...existing.provenance,
          source: strongerSource(existing.provenance.source, candidate.source),
          sessionIds,
          lastSeenAt: at,
          evidence: candidate.evidence ?? existing.provenance.evidence,
        },
        observedCount: existing.observedCount + 1,
        confidence: Math.min(
          1,
          Math.max(existing.confidence, candidate.confidence ?? existing.confidence) +
            (seenAgain ? 0.1 : 0),
        ),
      };
      this.put(next);
      return { entry: next, created: false };
    }

    const entry: MemoryEntry = {
      id,
      kind: candidate.kind,
      status: "candidate",
      text,
      provenance: {
        source: candidate.source,
        sessionIds: [candidate.sessionId],
        at,
        lastSeenAt: at,
        ...(candidate.evidence ? { evidence: candidate.evidence } : {}),
      },
      confidence: candidate.confidence ?? defaultConfidence(candidate.source),
      observedCount: 1,
      scope: candidate.scope,
    };
    this.put(entry);
    return { entry, created: true };
  }

  /** Write an entry through, unguarded on content it already carries — callers
   *  that MUTATE an entry (promote, supersede, pin) use this; callers that
   *  introduce text use `observe`. */
  put(entry: MemoryEntry): MemoryEntry {
    try {
      mkdirSync(this.entriesDir, { recursive: true });
      writeFileSync(this.pathFor(entry.id), JSON.stringify(entry, null, 2) + "\n");
    } catch {
      // A store that cannot write is a store with no memory, not a broken run.
    }
    return entry;
  }

  remove(id: string): boolean {
    const p = this.pathFor(id);
    try {
      if (!existsSync(p)) return false;
      rmSync(p);
      return true;
    } catch {
      return false;
    }
  }

  setPinned(id: string, pinned: boolean): MemoryEntry | undefined {
    const entry = this.get(id);
    if (!entry) return undefined;
    // Pinning is the user saying "this one is right" — it promotes as well as
    // protects, because a pinned entry the store still calls a candidate would
    // be pinned out of sight.
    const next: MemoryEntry = {
      ...entry,
      pinned,
      status: pinned && entry.status === "candidate" ? "promoted" : entry.status,
    };
    delete (next as { expiresAt?: string }).expiresAt;
    return this.put(next);
  }

  /** Wipe every entry. Keeps the directory and the refusal log. */
  clear(): void {
    for (const e of this.all()) this.remove(e.id);
  }

  /**
   * Hold the store to MAX_ENTRIES. Pinned entries and the user's own words are
   * never dropped; everything else goes lowest-confidence-oldest-first.
   * Returns how many were dropped.
   */
  prune(limit: number = MAX_ENTRIES): number {
    const all = this.all();
    if (all.length <= limit) return 0;
    const protectedSources: ReadonlySet<MemorySource> = new Set(["user-said", "user-corrected"]);
    const droppable = all
      .filter((e) => !e.pinned && !protectedSources.has(e.provenance.source))
      .sort((a, b) => {
        if (a.confidence !== b.confidence) return a.confidence - b.confidence;
        return (a.provenance.lastSeenAt ?? a.provenance.at).localeCompare(
          b.provenance.lastSeenAt ?? b.provenance.at,
        );
      });
    let dropped = 0;
    for (const e of droppable) {
      if (all.length - dropped <= limit) break;
      if (this.remove(e.id)) dropped += 1;
    }
    return dropped;
  }

  // ── The refusal diary ──

  /** What the guard turned away, newest last. Read by `/memory`. */
  refusals(): Array<MemoryRefusal & { at: string }> {
    try {
      const p = this.refusalPath();
      if (!existsSync(p)) return [];
      return readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as MemoryRefusal & { at: string };
          } catch {
            return null;
          }
        })
        .filter((r): r is MemoryRefusal & { at: string } => r !== null);
    } catch {
      return [];
    }
  }

  logRefusal(refusal: MemoryRefusal, now: Date = new Date()): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(
        this.refusalPath(),
        JSON.stringify({ ...refusal, at: now.toISOString() }) + "\n",
      );
      const lines = this.refusals();
      if (lines.length > REFUSAL_LOG_LINES) {
        writeFileSync(
          this.refusalPath(),
          lines
            .slice(-REFUSAL_LOG_LINES)
            .map((l) => JSON.stringify(l))
            .join("\n") + "\n",
        );
      }
    } catch {
      // ignore
    }
  }

  // ── Internals ──

  private refusalPath(): string {
    return join(this.dir, "refused.jsonl");
  }

  private pathFor(id: string): string {
    return join(this.entriesDir, `${id}.json`);
  }

  private readFile(path: string): MemoryEntry | null {
    try {
      if (!existsSync(path)) return null;
      return sanitize(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
    } catch {
      return null;
    }
  }
}

// ─── Helpers ───

/** Whitespace-collapsed and clipped. The clip is a backstop; the guard already
 *  refuses anything over the cap, so this only ever trims trailing space. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

/**
 * The id is the content: kind + scope + a case-folded, punctuation-stripped
 * reading of the text. "Always run typecheck first." and "always run typecheck
 * first" are one memory, which is the only way `observedCount` means anything.
 */
export function entryId(kind: MemoryKind, scope: MemoryScope, text: string): string {
  const signature = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256")
    .update(`${kind} ${scopeKey(scope)} ${signature}`)
    .digest("hex")
    .slice(0, 12);
}

const SOURCE_RANK: Record<MemorySource, number> = {
  distilled: 0,
  observed: 1,
  "verified-outcome": 2,
  "user-said": 3,
  "user-corrected": 4,
};

export function strongerSource(a: MemorySource, b: MemorySource): MemorySource {
  return SOURCE_RANK[b] > SOURCE_RANK[a] ? b : a;
}

function defaultConfidence(source: MemorySource): number {
  switch (source) {
    case "user-corrected":
      return 0.95;
    case "user-said":
      return 0.9;
    case "verified-outcome":
      return 0.75;
    case "observed":
      return 0.4;
    case "distilled":
      return 0.3;
  }
}

const KINDS: ReadonlySet<string> = new Set(["person", "working", "project", "lesson"]);
const STATUSES: ReadonlySet<string> = new Set(["candidate", "promoted", "superseded"]);
const SOURCES: ReadonlySet<string> = new Set(Object.keys(SOURCE_RANK));

/** A hand-edited or half-written file must not become a malformed entry in
 *  memory. Anything that does not read as an entry is simply not one. */
function sanitize(raw: Record<string, unknown>): MemoryEntry | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.text !== "string" || !raw.text.trim()) return null;
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) return null;
  const status =
    typeof raw.status === "string" && STATUSES.has(raw.status) ? raw.status : "candidate";
  const prov = (raw.provenance ?? {}) as Record<string, unknown>;
  const source =
    typeof prov.source === "string" && SOURCES.has(prov.source) ? prov.source : "observed";
  const sessionIds = Array.isArray(prov.sessionIds)
    ? prov.sessionIds.filter((s): s is string => typeof s === "string")
    : [];
  const scope =
    raw.scope &&
    typeof raw.scope === "object" &&
    typeof (raw.scope as { workspace?: unknown }).workspace === "string"
      ? { workspace: (raw.scope as { workspace: string }).workspace }
      : "global";
  return {
    id: raw.id,
    kind: raw.kind as MemoryKind,
    status: status as MemoryStatus,
    text: raw.text,
    provenance: {
      source: source as MemorySource,
      sessionIds,
      at: typeof prov.at === "string" ? prov.at : new Date(0).toISOString(),
      ...(typeof prov.lastSeenAt === "string" ? { lastSeenAt: prov.lastSeenAt } : {}),
      ...(typeof prov.evidence === "string" ? { evidence: prov.evidence } : {}),
    },
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
    observedCount: typeof raw.observedCount === "number" ? raw.observedCount : 1,
    ...(raw.pinned === true ? { pinned: true } : {}),
    ...(typeof raw.expiresAt === "string" ? { expiresAt: raw.expiresAt } : {}),
    scope: scope as MemoryScope,
    ...(typeof raw.supersededBy === "string" ? { supersededBy: raw.supersededBy } : {}),
    ...(typeof raw.supersedes === "string" ? { supersedes: raw.supersedes } : {}),
  };
}

export { sameScope, scopeKey };
