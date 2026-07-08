// ─── @alan/telemetry: the Black Box ───
// Flight recorder for incidents (failures, degradations, struggles) with
// crash-safe storage, redaction, trail forensics, and outcome resolution.
// The legacy TelemetrySink surface is kept below for compatibility; the
// Recorder is the real pipeline.

export { Recorder, type RecorderConfig } from "./recorder";
export { BlackboxStore, type FingerprintRow, type ListFilter } from "./store";
export { redactText, containsSecret, type RedactOptions } from "./redact";
export {
  armSentinel,
  disarmSentinel,
  consumeDirtyExit,
  sweepDirtyExits,
  sentinelPathFor,
  isPidAlive,
  type SentinelMeta,
  type DirtyExit,
} from "./sentinel";

// ─── Opt-in, transparent outbound telemetry (off by default) ───
export {
  TelemetryReporter,
  toIncidentWire,
  type ReporterOptions,
  type IncidentWire,
  type UsageWire,
  type WireReport,
} from "./reporter";
export {
  type ConsentDecision,
  type TelemetryState,
  telemetryStatePath,
  loadTelemetryState,
  saveTelemetryState,
  setConsent,
  ensureInstallId,
  markHeartbeat,
  resetTelemetryState,
  todayUtc,
} from "./consent";
export { type UsageCounters, usageCountersPath, bumpUsage, takeUsage, peekUsage } from "./counters";

// ─── Legacy sink API (predates the Recorder; kept for compatibility) ───

export type TelemetryLevel = "debug" | "info" | "warn" | "error";

export interface TelemetryEvent {
  name: string;
  level?: TelemetryLevel;
  attributes?: Record<string, string | number | boolean | null>;
  timestamp?: Date;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void | Promise<void>;
}

export class NoopTelemetrySink implements TelemetrySink {
  emit(_event: TelemetryEvent): void {
    // Intentionally empty.
  }
}

let sink: TelemetrySink = new NoopTelemetrySink();

export function setTelemetrySink(nextSink: TelemetrySink): void {
  sink = nextSink;
}

export async function emitTelemetry(event: TelemetryEvent): Promise<void> {
  await sink.emit({ ...event, timestamp: event.timestamp ?? new Date() });
}
