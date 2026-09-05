// ─── Provider health, remembered across sessions ───
//
// The gateway already learns which models are gone and which providers are
// capped. It learned it in memory, so every new session started ignorant and
// paid the same tuition again: 24 recorded failures against a model retired
// six weeks earlier, and 105 rate-limit incidents in ten days, most of them a
// fresh session re-walking a cascade the last one had already proved doomed.
//
// Each rediscovery is not free. A model-gone 404 costs a full request with the
// whole conversation attached before it fails, and the cascade behind it costs
// one more per provider.
//
// Deliberately a small JSON file rather than a table in the session database:
// it is machine-wide rather than per-session (which is the entire point), it
// must be readable before any session exists, and a corrupt or missing file
// has to degrade to "know nothing" rather than fail a startup.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { getRuneHome } from "@rune/shared";

/**
 * How long a model stays on the retired list.
 *
 * Not permanent: ids come back — a model is un-deprecated, a free tier
 * reopens, a typo is fixed upstream — and a permanent local blocklist would
 * outlive the truth with no way for a user to discover why. A week is long
 * enough that a genuinely dead id costs one probe per week instead of one per
 * session.
 */
export const RETIREMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Entries older than this with no expiry left are dropped on write. */
const MAX_ENTRIES = 200;

export interface RetiredModel {
  provider: string;
  model: string;
  /** Epoch ms when this record stops being believed. */
  until: number;
  reason: string;
}

export interface CappedProvider {
  provider: string;
  /** Epoch ms when the plan/quota cap is expected to lift. */
  until: number;
  message: string;
}

interface HealthFile {
  version: 1;
  retired: RetiredModel[];
  capped: CappedProvider[];
}

const EMPTY: HealthFile = { version: 1, retired: [], capped: [] };

function defaultPath(): string {
  return join(getRuneHome(), "provider-health.json");
}

/**
 * Cross-session memory of what is dead and what is capped.
 *
 * Every method is failure-tolerant by construction. This store exists to save
 * wasted requests; it must never be the reason one cannot be made.
 */
export class ProviderHealthStore {
  private data: HealthFile = { ...EMPTY, retired: [], capped: [] };
  private readonly path: string;
  private loaded = false;
  // Overridden per-instance by ephemeral(); hence a property, not a method.
  protected save: () => void = () => this.persist();

  constructor(path?: string) {
    this.path = path ?? defaultPath();
  }

  /**
   * A store that remembers nothing beyond this object.
   *
   * The default for any gateway built without an explicit store. Persistence
   * is a machine-global side effect and has to be asked for: a gateway that
   * quietly reads and writes the user's home makes one process's live run
   * change another's behaviour, and makes tests depend on the machine they run
   * on. The CLI opts in; everything else gets this.
   */
  static ephemeral(): ProviderHealthStore {
    const s = new ProviderHealthStore("");
    s.loaded = true; // never read from disk
    s.save = () => {}; // never write to disk
    return s;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<HealthFile>;
      if (raw?.version !== 1) return;
      this.data = {
        version: 1,
        retired: Array.isArray(raw.retired) ? raw.retired : [],
        capped: Array.isArray(raw.capped) ? raw.capped : [],
      };
    } catch {
      // Absent, unreadable or malformed: know nothing, which is exactly the
      // behaviour that existed before this file did.
    }
  }

  private persist(): void {
    const now = Date.now();
    // Expiry is enforced on write as well as read, so the file cannot grow
    // without bound on a machine that never restarts.
    this.data.retired = this.data.retired.filter((r) => r.until > now).slice(-MAX_ENTRIES);
    this.data.capped = this.data.capped.filter((c) => c.until > now).slice(-MAX_ENTRIES);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch {
      // Read-only home, full disk, a race with another instance: the in-memory
      // view is still correct for this session.
    }
  }

  /** True when this provider/model was seen to be gone and the record still holds. */
  isRetired(provider: string, model: string): boolean {
    this.load();
    const now = Date.now();
    return this.data.retired.some(
      (r) => r.provider === provider && r.model === model && r.until > now,
    );
  }

  /** Why it was retired, for a message a user can act on. */
  retirementReason(provider: string, model: string): string | null {
    this.load();
    const now = Date.now();
    const hit = this.data.retired.find(
      (r) => r.provider === provider && r.model === model && r.until > now,
    );
    return hit ? hit.reason : null;
  }

  noteRetired(provider: string, model: string, reason: string): void {
    if (!provider || !model) return;
    this.load();
    this.data.retired = this.data.retired.filter(
      (r) => !(r.provider === provider && r.model === model),
    );
    this.data.retired.push({
      provider,
      model,
      until: Date.now() + RETIREMENT_TTL_MS,
      reason: reason.slice(0, 200),
    });
    this.save();
  }

  /** Epoch ms this provider's plan/quota cap lifts, or 0 when it is not capped. */
  cappedUntil(provider: string): number {
    this.load();
    const now = Date.now();
    const hit = this.data.capped.find((c) => c.provider === provider && c.until > now);
    return hit ? hit.until : 0;
  }

  capMessage(provider: string): string | null {
    this.load();
    const now = Date.now();
    const hit = this.data.capped.find((c) => c.provider === provider && c.until > now);
    return hit ? hit.message : null;
  }

  noteCapped(provider: string, until: number, message: string): void {
    if (!provider || !Number.isFinite(until) || until <= Date.now()) return;
    this.load();
    this.data.capped = this.data.capped.filter((c) => c.provider !== provider);
    this.data.capped.push({ provider, until, message: message.slice(0, 200) });
    this.save();
  }

  /** Everything currently believed, for `/providers` and diagnostics. */
  snapshot(): { retired: RetiredModel[]; capped: CappedProvider[] } {
    this.load();
    const now = Date.now();
    return {
      retired: this.data.retired.filter((r) => r.until > now),
      capped: this.data.capped.filter((c) => c.until > now),
    };
  }

  /** Forget a specific record — the escape hatch when a model comes back early. */
  clearRetired(provider: string, model: string): void {
    this.load();
    const before = this.data.retired.length;
    this.data.retired = this.data.retired.filter(
      (r) => !(r.provider === provider && r.model === model),
    );
    if (this.data.retired.length !== before) this.save();
  }

  /** Forget everything. Test seam, and the user's reset button. */
  clearAll(): void {
    this.loaded = true;
    this.data = { version: 1, retired: [], capped: [] };
    this.save();
  }
}
