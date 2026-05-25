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
