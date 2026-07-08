// ─── `berne telemetry`: the opt-in outbound channel's control surface ───
// status | on | off | preview | reset. No Engine boot, no provider validation —
// it only reads config + ~/.alan/telemetry.json and (for preview) shapes sample
// payloads. `preview` is the whole trust story: it prints the EXACT bytes that
// would ever leave the machine, so a user or a compliance reviewer can verify
// the claim instead of taking it on faith.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAlanHome, loadConfig, type AlanConfig, type IncidentRecord } from "@alan/shared";
import {
  BlackboxStore,
  TelemetryReporter,
  loadTelemetryState,
  peekUsage,
  resetTelemetryState,
  setConsent,
  toIncidentWire,
} from "@alan/telemetry";
import { PRODUCT_VERSION } from "./ui/brand";
import { accent, bold, dim, faint, info, ok, text, warn } from "./ui/theme";

const HOME = () => getAlanHome();

type TelemetryCfg = AlanConfig["telemetry"];

function loadTelemetryCfg(): TelemetryCfg {
  try {
    return loadConfig(process.cwd()).telemetry ?? { enabled: false };
  } catch {
    return { enabled: false };
  }
}

function maskId(id: string | null): string {
  return id ? `…${id.slice(-8)}` : dim("<assigned on opt-in>");
}

function queuedCount(): number {
  try {
    const p = join(HOME(), "telemetry-queue.jsonl");
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function recentIncident(): IncidentRecord | null {
  try {
    const db = join(HOME(), "blackbox.db");
    if (!existsSync(db)) return null;
    const store = new BlackboxStore(db);
    const list = store.list({ limit: 1 });
    store.close();
    return list[0] ?? null;
  } catch {
    return null;
  }
}

function previewReporter(cfg: TelemetryCfg, installId: string | null): TelemetryReporter {
  return new TelemetryReporter({
    home: HOME(),
    endpoint: cfg.endpoint ?? "https://<your-collector>/ingest",
    token: cfg.token,
    installId: installId ?? "<assigned-on-opt-in>",
    version: PRODUCT_VERSION,
    streams: { crash: cfg.crashReports !== false, usage: cfg.usageStats !== false },
  });
}

/** True only when a report could actually be transmitted right now. */
function effectiveOn(cfg: TelemetryCfg, decision: string | null): boolean {
  return !!(cfg.enabled && cfg.endpoint && decision === "granted");
}

// ─── subcommands ───

function cmdStatus(cfg: TelemetryCfg): void {
  const state = loadTelemetryState(HOME());
  const on = effectiveOn(cfg, state.decision);

  console.log(`\n  ${dim("§ BERNE TELEMETRY")}\n`);
  console.log(
    `  ${on ? ok("● ON") : dim("○ OFF")}  ${
      on
        ? text("anonymous diagnostics are shared at each launch")
        : dim("nothing is transmitted")
    }`,
  );

  console.log(`\n  ${dim("config")}`);
  console.log(`    ${dim("enabled:")}  ${cfg.enabled ? ok("true") : warn("false")}`);
  console.log(
    `    ${dim("endpoint:")} ${cfg.endpoint ? info(cfg.endpoint) : warn("not set — nothing can be sent")}`,
  );
  console.log(`    ${dim("token:")}    ${cfg.token ? ok("set") : dim("none")}`);
  console.log(
    `    ${dim("streams:")}  ${cfg.crashReports !== false ? ok("crash-reports") : dim("crash-reports")} ${dim(
      "·",
    )} ${cfg.usageStats !== false ? ok("usage-stats") : dim("usage-stats")}`,
  );

  console.log(`\n  ${dim("consent")}`);
  const decisionPaint =
    state.decision === "granted"
      ? ok("granted")
      : state.decision === "denied"
        ? warn("denied")
        : dim("not asked yet");
  console.log(`    ${dim("decision:")}  ${decisionPaint}`);
  console.log(`    ${dim("install id:")} ${maskId(state.installId)}`);
  if (state.decidedAt) console.log(`    ${dim("decided at:")} ${faint(state.decidedAt)}`);
  console.log(`    ${dim("last heartbeat:")} ${faint(state.lastHeartbeat ?? "never")}`);

  const queued = queuedCount();
  if (queued > 0) {
    console.log(`\n  ${dim("queued:")} ${info(String(queued))} ${dim("report(s) awaiting next launch")}`);
  }

  console.log(
    `\n  ${faint("preview exactly what would be sent:")} ${info("berne telemetry preview")}`,
  );
  console.log(
    `  ${faint(state.decision === "granted" ? "turn off:" : "opt in:")} ${info(
      state.decision === "granted" ? "berne telemetry off" : "berne telemetry on",
    )}\n`,
  );
}

function cmdOn(cfg: TelemetryCfg): void {
  const state = setConsent(HOME(), "granted");
  console.log(`\n  ${ok("✓")} ${text("Telemetry opted IN.")} Thank you — this genuinely helps.`);
  console.log(`  ${dim("install id:")} ${maskId(state.installId)} ${faint("(anonymous, resettable)")}`);
  if (!cfg.endpoint) {
    console.log(
      `\n  ${warn("Note:")} no ${info("[telemetry] endpoint")} is configured, so nothing will actually be sent yet.`,
    );
  } else if (!cfg.enabled) {
    console.log(
      `\n  ${warn("Note:")} ${info("[telemetry] enabled")} is false in config, so nothing is sent until it's true.`,
    );
  } else {
    console.log(`\n  ${dim("Reports will be delivered at the start of each launch.")}`);
  }
  console.log(`  ${faint("see the exact payloads:")} ${info("berne telemetry preview")}\n`);
}

function cmdOff(): void {
  setConsent(HOME(), "denied");
  console.log(`\n  ${ok("✓")} ${text("Telemetry opted OUT.")} Nothing will be transmitted.`);
  console.log(
    `  ${dim("Your local Black Box still records incidents on this machine —")} ${info("berne doctor")}\n`,
  );
}

function cmdReset(): void {
  resetTelemetryState(HOME());
  console.log(
    `\n  ${ok("✓")} ${text("Telemetry state reset.")} Install id discarded; you'll be asked again next launch.\n`,
  );
}

function cmdPreview(cfg: TelemetryCfg): void {
  const state = loadTelemetryState(HOME());
  const reporter = previewReporter(cfg, state.installId);

  console.log(`\n  ${dim("§ TELEMETRY PREVIEW")} ${faint("— the complete set of what could ever be sent")}\n`);
  console.log(`  ${dim("destination:")} ${cfg.endpoint ? info(cfg.endpoint) : warn("(no endpoint configured)")}`);
  console.log(
    `  ${dim("transport:")}   ${faint("HTTPS POST · at launch only · best-effort · never blocks or retries in-session")}\n`,
  );

  const real = recentIncident();
  if (real) {
    console.log(`  ${bold("1. A crash/error report")} ${faint("(shaped from your most recent local incident):")}`);
    console.log(indent(JSON.stringify(toIncidentWire(real, sampleMeta(state.installId)), null, 2)));
  } else {
    console.log(`  ${bold("1. A crash/error report")} ${faint("(sample — no local incidents yet):")}`);
    console.log(indent(JSON.stringify(reporter.previewSampleIncident(), null, 2)));
  }

  console.log(`\n  ${bold("2. The daily usage heartbeat")} ${faint("(anonymous counts, at most one per day):")}`);
  console.log(indent(JSON.stringify(reporter.previewHeartbeat(), null, 2)));

  console.log(`\n  ${bold("Never included:")}`);
  for (const line of [
    "file contents, diffs, code, or prompts",
    "your IP address or any device / hardware fingerprint",
    "file paths (home is collapsed to ~) or the flight trail's summaries",
    "API keys or secrets (stripped at the redaction chokepoint before storage)",
  ]) {
    console.log(`    ${dim("·")} ${faint(line)}`);
  }
  const peek = peekUsage(HOME());
  if (Object.keys(peek).length === 0) {
    console.log(`\n  ${faint("(usage counters are empty right now — they accrue as you use Berne.)")}`);
  }
  console.log("");
}

function sampleMeta(installId: string | null): { installId: string; os: string; arch: string } {
  return {
    installId: installId ?? "<assigned-on-opt-in>",
    os: process.platform,
    arch: process.arch,
  };
}

function indent(block: string): string {
  return block
    .split("\n")
    .map((l) => `    ${faint(l)}`)
    .join("\n");
}

export function runTelemetry(args: string[]): void {
  const cfg = loadTelemetryCfg();
  const sub = (args[0] ?? "status").toLowerCase();
  switch (sub) {
    case "on":
    case "enable":
      return cmdOn(cfg);
    case "off":
    case "disable":
      return cmdOff();
    case "reset":
      return cmdReset();
    case "preview":
      return cmdPreview(cfg);
    case "status":
    default:
      return cmdStatus(cfg);
  }
}
