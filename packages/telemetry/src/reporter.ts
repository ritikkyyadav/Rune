// ─── TelemetryReporter: the opt-in outbound channel ───
// The ONE place anything leaves the machine, and only ever when a
// TelemetryReporter exists — which the CLI creates solely after the consent
// gate (see consent.ts) says "granted" AND an endpoint is configured. If either
// is missing the object is never built, so there is no network path at all.
//
// Design, matching the Black Box's crash-safe ethos:
//  - onIncident is SYNCHRONOUS and does no network: it shapes the record
//    through a strict allowlist and appends one line to a durable JSONL queue.
//    This is what lets it run inside uncaughtException/exit handlers — the
//    report is safely on disk even mid-crash, and the NEXT launch delivers it.
//  - Network happens only in flush()/heartbeat, called once at startup. That
//    makes the traffic predictable and trivial to see in a proxy: a burst at
//    launch, nothing during the session. Everything is best-effort and never
//    throws — telemetry must never become the thing that broke the flight.
//
// What ships is deliberately minimal (see toIncidentWire): class/severity/
// where/fingerprint, an already-redacted message + stack, a whitelisted context
// bag, and OS/arch. Never the flight trail (its summaries are the content-rich
// part), never file contents, never a raw IP or device fingerprint.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { IncidentContext, IncidentRecord } from "@gear/shared";
import { redactText } from "./redact";
import { markHeartbeat, todayUtc, type TelemetryState } from "./consent";
import { peekUsage, takeUsage } from "./counters";

// ─── Wire shapes: the exhaustive list of what can ever be transmitted ───

export interface IncidentWire {
  t: "incident";
  installId: string;
  version: string;
  ts: string;
  class: string;
  severity: string;
  component: string;
  where: string;
  fingerprint: string;
  /** Already redacted by the recorder; re-redacted + capped here as a belt-and-braces. */
  msg: string;
  stack?: string;
  outcome: string;
  /** Session id (a random UUID — groups a run's incidents; not person/device identifying). */
  run: string | null;
  turn: number | null;
  ctx: WireContext;
  os: string;
  arch: string;
}

/** Whitelisted context fields — everything else on IncidentContext is dropped. */
interface WireContext {
  provider?: string;
  model?: string;
  tier?: string;
  tool?: string;
  argsHash?: string;
  status?: number;
  retries?: number;
  permissionMode?: string;
  ui?: string;
}

export interface UsageWire {
  t: "usage";
  installId: string;
  version: string;
  ts: string;
  day: string;
  os: string;
  arch: string;
  counters: Record<string, number>;
}

export type WireReport = IncidentWire | UsageWire;

const MSG_CAP = 500;
const STACK_CAP = 2000;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_QUEUE_BYTES = 512 * 1024; // ~hundreds of reports; then oldest are dropped

const CTX_ALLOW: (keyof WireContext)[] = [
  "provider",
  "model",
  "tier",
  "tool",
  "argsHash",
  "status",
  "retries",
  "permissionMode",
  "ui",
];

function pickContext(ctx: IncidentContext | undefined): WireContext {
  const out: WireContext = {};
  if (!ctx) return out;
  for (const key of CTX_ALLOW) {
    const v = ctx[key];
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** Pure, testable: shape a stored incident into the minimal wire payload. */
export function toIncidentWire(
  record: IncidentRecord,
  meta: { installId: string; os: string; arch: string },
): IncidentWire {
  return {
    t: "incident",
    installId: meta.installId,
    version: record.version,
    ts: record.ts,
    class: record.class,
    severity: record.severity,
    component: record.component,
    where: record.where,
    fingerprint: record.fingerprint,
    msg: redactText(record.message).slice(0, MSG_CAP),
    stack: record.stack ? redactText(record.stack).slice(0, STACK_CAP) : undefined,
    outcome: record.outcome,
    run: record.sessionId,
    turn: record.turn,
    ctx: pickContext(record.context),
    os: meta.os,
    arch: meta.arch,
  };
}

export interface ReporterOptions {
  home: string;
  endpoint: string;
  token?: string;
  installId: string;
  version: string;
  os?: string;
  arch?: string;
  streams?: { crash?: boolean; usage?: boolean };
  now?: () => Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  queuePath?: string;
  maxQueueBytes?: number;
}

export class TelemetryReporter {
  private readonly home: string;
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly installId: string;
  private readonly version: string;
  private readonly os: string;
  private readonly arch: string;
  private readonly crash: boolean;
  private readonly usage: boolean;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly queuePath: string;
  private readonly maxQueueBytes: number;

  constructor(opts: ReporterOptions) {
    this.home = opts.home;
    this.endpoint = opts.endpoint;
    this.token = opts.token;
    this.installId = opts.installId;
    this.version = opts.version;
    this.os = opts.os ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.crash = opts.streams?.crash !== false;
    this.usage = opts.streams?.usage !== false;
    this.now = opts.now ?? (() => new Date());
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.queuePath = opts.queuePath ?? join(opts.home, "telemetry-queue.jsonl");
    this.maxQueueBytes = opts.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
  }

  /** Recorder sink: synchronous, durable, no network. Safe in crash handlers. */
  onIncident(record: IncidentRecord): void {
    if (!this.crash) return;
    try {
      this.appendReport(toIncidentWire(record, this.meta()));
    } catch {
      // best-effort; a telemetry failure must never surface to the app
    }
  }

  /**
   * Enqueue at most one usage heartbeat per UTC day. Reads-and-RESETS the local
   * counters so the next day starts fresh; if the later flush fails the report
   * still sits durably in the queue, so no counts are lost. Returns whether one
   * was enqueued (for `telemetry status`).
   */
  maybeHeartbeat(state: TelemetryState): boolean {
    if (!this.usage) return false;
    const day = todayUtc(this.now());
    if (state.lastHeartbeat === day) return false;
    try {
      const counters = takeUsage(this.home);
      this.appendReport(this.buildUsage(counters, day));
      markHeartbeat(this.home, day);
      return true;
    } catch {
      return false;
    }
  }

  /** Drain the durable queue to the collector. Best-effort; never throws. */
  async flush(): Promise<void> {
    try {
      if (!existsSync(this.queuePath)) return;
      const buffer = readFileSync(this.queuePath, "utf-8");
      // Track how far we read as a string length (code units) so the later
      // truncate slices at exactly the same boundary it measured.
      const sentLen = buffer.length;
      const reports = buffer
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return JSON.parse(l) as WireReport;
          } catch {
            return null;
          }
        })
        .filter((r): r is WireReport => r !== null);
      if (reports.length === 0) {
        this.clearQueueUpTo(sentLen);
        return;
      }
      const ok = await this.post(reports);
      // Only drop what we actually read — anything appended meanwhile survives.
      if (ok) this.clearQueueUpTo(sentLen);
    } catch {
      // never throw
    }
  }

  close(): void {
    // The queue and counters are already durable on disk; nothing to flush.
  }

  // ─── preview surface (for `gear telemetry preview`) ───

  /** The exact wire payload a report of this kind would take. */
  previewSampleIncident(): IncidentWire {
    const sample: IncidentRecord = {
      id: "sample",
      ts: this.now().toISOString(),
      version: this.version,
      sessionId: "run-xxxx",
      turn: 1,
      class: "provider.rate_limit",
      severity: "warn",
      component: "gateway",
      where: "gateway#send",
      message: "429 from provider; backing off 2s before retry",
      stack: undefined,
      trail: [],
      outcome: "recovered",
      fingerprint: "sample0000000000",
      context: { provider: "example", model: "example-model", status: 429, retries: 1 },
    };
    return toIncidentWire(sample, this.meta());
  }

  /** The heartbeat that WOULD be sent right now, without sending or resetting. */
  previewHeartbeat(): UsageWire {
    return this.buildUsage(peekUsage(this.home), todayUtc(this.now()));
  }

  // ─── internals ───

  private meta(): { installId: string; os: string; arch: string } {
    return { installId: this.installId, os: this.os, arch: this.arch };
  }

  private buildUsage(counters: Record<string, number>, day: string): UsageWire {
    return {
      t: "usage",
      installId: this.installId,
      version: this.version,
      ts: this.now().toISOString(),
      day,
      os: this.os,
      arch: this.arch,
      counters,
    };
  }

  private appendReport(report: WireReport): void {
    mkdirSync(dirname(this.queuePath), { recursive: true });
    appendFileSync(this.queuePath, `${JSON.stringify(report)}\n`);
    this.trimQueue();
  }

  /** Keep the queue bounded: if it outgrows the cap, drop the oldest half. */
  private trimQueue(): void {
    try {
      if (!existsSync(this.queuePath)) return;
      const buffer = readFileSync(this.queuePath, "utf-8");
      if (Buffer.byteLength(buffer, "utf-8") <= this.maxQueueBytes) return;
      const lines = buffer.split("\n").filter((l) => l.trim().length > 0);
      const kept = lines.slice(Math.floor(lines.length / 2));
      this.atomicWrite(`${kept.join("\n")}\n`);
    } catch {
      // best-effort
    }
  }

  private clearQueueUpTo(sentLen: number): void {
    try {
      if (!existsSync(this.queuePath)) return;
      const current = readFileSync(this.queuePath, "utf-8");
      // Preserve anything appended after our snapshot; drop what we sent.
      const remainder = current.length > sentLen ? current.slice(sentLen) : "";
      this.atomicWrite(remainder);
    } catch {
      // best-effort
    }
  }

  private atomicWrite(contents: string): void {
    const tmp = `${this.queuePath}.${process.pid}.tmp`;
    writeFileSync(tmp, contents);
    renameSync(tmp, this.queuePath);
  }

  private async post(reports: WireReport[]): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify({ v: 1, reports }),
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // offline / timeout / DNS failure — keep the queue for next launch
      return false;
    }
  }
}
