// ─── Recorder: the flight recorder ───
// One instance per process. Owns the trail ring buffer, redaction, fingerprint,
// storage, and run-scoped outcome resolution. Every public method is
// exception-proof: a recorder failure degrades to a line in the last-resort
// log and (after repeated failures) disables itself — it must never become the
// thing that crashed the flight.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUIDv7 } from "bun";
import {
  fingerprintIncident,
  type IncidentInput,
  type IncidentOutcome,
  type IncidentRecord,
  type TrailEntry,
} from "@alan/shared";
import { redactText } from "./redact";
import { BlackboxStore } from "./store";

export interface RecorderConfig {
  dbPath: string;
  /** App version + commit, stamped on every incident. */
  version: string;
  /** Keep at most this many trail entries per snapshot. Default 30. */
  maxTrail?: number;
  /** Where recorder-internal failures are appended. Default `<db dir>/blackbox.last-resort.log`. */
  lastResortPath?: string;
  /** Periodically mirror the trail to this spool file (crash forensics). */
  spoolPath?: string;
}

const MAX_SUMMARY_CHARS = 200;
const MAX_INTERNAL_FAILURES = 3;
const SPOOL_EVERY_NOTES = 20;

export class Recorder {
  private store: BlackboxStore | null = null;
  private config: Required<Pick<RecorderConfig, "dbPath" | "version">> & RecorderConfig;
  private trail: TrailEntry[] = [];
  private trailSeq = 0;
  private notesSinceSpool = 0;
  private sessionId: string | null = null;
  private turn: number | null = null;
  private pendingRunIds: string[] = [];
  private internalFailures = 0;
  private lastInternalError: string | null = null;

  constructor(config: RecorderConfig) {
    this.config = { maxTrail: 30, ...config };
    try {
      this.store = new BlackboxStore(config.dbPath);
    } catch (err) {
      this.internalFailure("open store", err);
    }
  }

  /**
   * Scope subsequent incidents + the trail to a session/run. Deliberately does
   * NOT clear pendingRunIds: an incident recorded BETWEEN runs (e.g. /bug) is
   * resolved by the next run's endRun — "what happened after the report" is
   * its outcome. endRun/recordFatal are the only points that clear.
   */
  beginRun(sessionId: string, turn: number): void {
    this.sessionId = sessionId;
    this.turn = turn;
  }

  /**
   * Resolve every incident captured during the current run. Call exactly once
   * per run, from the engine's finally block.
   */
  endRun(outcome: Exclude<IncidentOutcome, "pending">): void {
    try {
      if (this.store && this.pendingRunIds.length > 0) {
        this.store.resolve(this.pendingRunIds, outcome);
      }
    } catch (err) {
      this.internalFailure("endRun", err);
    }
    this.pendingRunIds = [];
    this.turn = null;
  }

  /** Append one compact entry to the flight trail. Summaries are redacted + capped. */
  note(kind: string, summary: string): void {
    try {
      this.trailSeq++;
      this.trail.push({
        seq: this.trailSeq,
        kind,
        summary: redactText(summary).slice(0, MAX_SUMMARY_CHARS),
      });
      const cap = (this.config.maxTrail ?? 30) * 2;
      if (this.trail.length > cap) this.trail.splice(0, this.trail.length - cap);
      if (this.config.spoolPath && ++this.notesSinceSpool >= SPOOL_EVERY_NOTES) {
        this.spool();
      }
    } catch (err) {
      this.internalFailure("note", err);
    }
  }

  /** Record an incident. Returns the incident id, or null if recording failed/disabled. */
  record(input: IncidentInput): string | null {
    try {
      if (!this.store) return null;
      const record: IncidentRecord = {
        ...input,
        message: redactText(input.message).slice(0, 2000),
        stack: input.stack ? redactText(input.stack).slice(0, 4000) : undefined,
        id: randomUUIDv7(),
        ts: new Date().toISOString(),
        version: this.config.version,
        sessionId: this.sessionId,
        turn: this.turn,
        trail: this.trail.slice(-(this.config.maxTrail ?? 30)),
        outcome: "pending",
        fingerprint: fingerprintIncident(input.class, input.component, input.message),
      };
      this.store.insert(record);
      this.pendingRunIds.push(record.id);
      if (this.config.spoolPath) this.spool();
      return record.id;
    } catch (err) {
      this.internalFailure("record", err);
      return null;
    }
  }

  /**
   * Synchronous variant for process-exit paths (uncaughtException handlers).
   * Identical behavior — bun:sqlite writes are synchronous — but resolves the
   * outcome immediately (nothing will get to end the run).
   */
  recordFatal(input: IncidentInput): string | null {
    const id = this.record(input);
    try {
      if (id && this.store) this.store.resolve([id], "crash");
      if (this.pendingRunIds.length > 0 && this.store) {
        this.store.resolve(this.pendingRunIds, "crash");
        this.pendingRunIds = [];
      }
    } catch (err) {
      this.internalFailure("recordFatal", err);
    }
    return id;
  }

  /** Direct store access for surfaces (doctor / incidents / bug). Null when disabled. */
  getStore(): BlackboxStore | null {
    return this.store;
  }

  getTrailSnapshot(): TrailEntry[] {
    return this.trail.slice(-(this.config.maxTrail ?? 30));
  }

  /**
   * Replace the in-memory trail (crash forensics: attach a previous run's
   * spooled trail to the dirty_exit incident, then clear with []).
   */
  seedTrail(entries: TrailEntry[]): void {
    this.trail = [...entries];
    this.trailSeq = entries.length > 0 ? Math.max(...entries.map((e) => e.seq)) : 0;
  }

  health(): { ok: boolean; dbPath: string; lastError: string | null; failures: number } {
    return {
      ok: this.store !== null && this.internalFailures < MAX_INTERNAL_FAILURES,
      dbPath: this.config.dbPath,
      lastError: this.lastInternalError,
      failures: this.internalFailures,
    };
  }

  close(): void {
    try {
      this.store?.close();
    } catch {
      // closing is best-effort
    }
    this.store = null;
  }

  // ─── internals ───

  private spool(): void {
    if (!this.config.spoolPath) return;
    this.notesSinceSpool = 0;
    try {
      mkdirSync(dirname(this.config.spoolPath), { recursive: true });
      writeFileSync(
        this.config.spoolPath,
        JSON.stringify({
          sessionId: this.sessionId,
          version: this.config.version,
          ts: new Date().toISOString(),
          trail: this.getTrailSnapshot(),
        }),
      );
    } catch {
      // spool is forensic best-effort; never count it as a hard failure
    }
  }

  private internalFailure(op: string, err: unknown): void {
    this.internalFailures++;
    this.lastInternalError = `${op}: ${err instanceof Error ? err.message : String(err)}`;
    try {
      const path =
        this.config.lastResortPath ?? `${dirname(this.config.dbPath)}/blackbox.last-resort.log`;
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${new Date().toISOString()} recorder ${this.lastInternalError}\n`);
    } catch {
      // Truly nothing left to do — stay silent rather than throw.
    }
    if (this.internalFailures >= MAX_INTERNAL_FAILURES) {
      try {
        this.store?.close();
      } catch {
        // best-effort
      }
      this.store = null; // disable for the rest of the run
    }
  }
}
