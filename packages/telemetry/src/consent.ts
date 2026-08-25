// ─── Telemetry consent + install identity ───
// Everything that decides WHETHER anything may leave the machine lives here, in
// one small JSON file (~/.gear/telemetry.json). The reporter refuses to be
// constructed unless decision === "granted", so this file is the single,
// auditable gate — a user can `cat` it and know exactly where they stand.
//
// Privacy invariants (enforced by construction, not convention):
//  - installId is a random UUIDv7, minted lazily and ONLY after consent. It is
//    NOT derived from the machine (no MAC address, hostname, serial, or any
//    fingerprint) — it identifies an *install*, never a person or device, and
//    `gear telemetry reset` throws it away and mints a new one.
//  - decision defaults to null ("never asked"). It is only ever flipped by an
//    explicit user action — the first-run prompt or `gear telemetry on/off`.
//    No code path sets it to "granted" implicitly, and a corrupt/unreadable
//    file fails SAFE (treated as "never consented" ⇒ nothing is sent).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUIDv7 } from "bun";

export type ConsentDecision = "granted" | "denied" | null;

export interface TelemetryState {
  /** Schema version, for forward-compatible migrations. */
  v: 1;
  /** Random install id (UUIDv7). Present only once consent is granted. */
  installId: string | null;
  /** The user's explicit choice. null = never asked. */
  decision: ConsentDecision;
  /** ISO timestamp of the last decision change. */
  decidedAt: string | null;
  /** Date (YYYY-MM-DD, UTC) of the last usage heartbeat — at most one per day. */
  lastHeartbeat: string | null;
}

const EMPTY: TelemetryState = {
  v: 1,
  installId: null,
  decision: null,
  decidedAt: null,
  lastHeartbeat: null,
};

export function telemetryStatePath(home: string): string {
  return join(home, "telemetry.json");
}

export function loadTelemetryState(home: string): TelemetryState {
  try {
    const path = telemetryStatePath(home);
    if (!existsSync(path)) return { ...EMPTY };
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<TelemetryState>;
    return {
      v: 1,
      installId: typeof raw.installId === "string" ? raw.installId : null,
      // Anything but the two known strings ⇒ "never asked" (fail safe).
      decision: raw.decision === "granted" || raw.decision === "denied" ? raw.decision : null,
      decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : null,
      lastHeartbeat: typeof raw.lastHeartbeat === "string" ? raw.lastHeartbeat : null,
    };
  } catch {
    // A corrupt state file must fail SAFE — treat as "never consented".
    return { ...EMPTY };
  }
}

export function saveTelemetryState(home: string, state: TelemetryState): void {
  try {
    const path = telemetryStatePath(home);
    mkdirSync(dirname(path), { recursive: true });
    // Write temp + rename so a crash never leaves a half-written file.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
  } catch {
    // best-effort; telemetry state must never crash the app
  }
}

/** Record an explicit user decision. Mints the install id on the first grant. */
export function setConsent(home: string, decision: "granted" | "denied"): TelemetryState {
  const state = loadTelemetryState(home);
  state.decision = decision;
  state.decidedAt = new Date().toISOString();
  if (decision === "granted" && !state.installId) {
    state.installId = randomUUIDv7();
  }
  saveTelemetryState(home, state);
  return state;
}

/** The install id when (and only when) consent is granted; mints it if missing. */
export function ensureInstallId(home: string): string | null {
  const state = loadTelemetryState(home);
  if (state.decision !== "granted") return null;
  if (state.installId) return state.installId;
  state.installId = randomUUIDv7();
  saveTelemetryState(home, state);
  return state.installId;
}

export function markHeartbeat(home: string, day: string): void {
  const state = loadTelemetryState(home);
  state.lastHeartbeat = day;
  saveTelemetryState(home, state);
}

/** Privacy reset: throw away identity + decision (next run asks again). */
export function resetTelemetryState(home: string): void {
  saveTelemetryState(home, { ...EMPTY });
}

/** UTC calendar day, the heartbeat's once-per-day key. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
