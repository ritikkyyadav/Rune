import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Minimal structured logger ───
// Zero-dependency, leveled, namespaced. Routes to stderr (so it never corrupts
// stdout protocol/IPC streams) and, when GEAR_LOG_DIR is set, appends to a file.
//
// Verbosity:
//   GEAR_LOG=debug|info|warn|error|silent   explicit threshold (default "warn")
//   DEBUG=<anything truthy>                  shorthand for GEAR_LOG=debug
//
// Designed for subsystems like MCP that previously used raw console.* — those
// calls corrupt a raw-mode TUI and can't be silenced. Through the logger a user
// can set GEAR_LOG=silent (or redirect via GEAR_LOG_DIR) and get a clean screen.

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** Derive a logger with an extended namespace (e.g. "mcp" → "mcp:files"). */
  child(namespace: string): Logger;
}

const LEVEL_ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Resolve the active threshold from the environment (re-read each call so tests
 * and runtime toggles take effect without a restart). */
function threshold(): number {
  const raw = (process.env.GEAR_LOG ?? "").toLowerCase().trim();
  if (raw === "silent") return Number.POSITIVE_INFINITY;
  if (raw in LEVEL_ORDER) return LEVEL_ORDER[raw as keyof typeof LEVEL_ORDER];
  if (process.env.DEBUG && process.env.DEBUG !== "0" && process.env.DEBUG !== "false") {
    return LEVEL_ORDER.debug;
  }
  return LEVEL_ORDER.warn;
}

let fileSinkChecked = false;
let fileSinkPath: string | null = null;

/** Resolve (once) the optional file sink under GEAR_LOG_DIR. Never throws. */
function fileSink(): string | null {
  if (fileSinkChecked) return fileSinkPath;
  fileSinkChecked = true;
  const dir = process.env.GEAR_LOG_DIR;
  if (!dir) return (fileSinkPath = null);
  try {
    mkdirSync(dir, { recursive: true });
    fileSinkPath = join(dir, "gear.log");
  } catch {
    fileSinkPath = null; // unwritable dir — silently drop the file sink
  }
  return fileSinkPath;
}

function format(
  level: string,
  namespace: string,
  msg: string,
  meta?: Record<string, unknown>,
): string {
  const ts = new Date().toISOString();
  let line = `${ts} ${level.padEnd(5)} [${namespace}] ${msg}`;
  if (meta && Object.keys(meta).length > 0) {
    try {
      line += ` ${JSON.stringify(meta)}`;
    } catch {
      // Circular / non-serializable meta — omit rather than throw.
    }
  }
  return line;
}

function emit(
  levelNum: number,
  level: string,
  namespace: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  if (levelNum < threshold()) return;
  const line = format(level, namespace, msg, meta);
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // stderr closed — nothing we can do.
  }
  const sink = fileSink();
  if (sink) {
    try {
      appendFileSync(sink, `${line}\n`);
    } catch {
      // Best-effort file logging.
    }
  }
}

/** Create a namespaced logger. Cheap — make as many as you like. */
export function createLogger(namespace: string): Logger {
  return {
    debug: (msg, meta) => emit(LEVEL_ORDER.debug, "debug", namespace, msg, meta),
    info: (msg, meta) => emit(LEVEL_ORDER.info, "info", namespace, msg, meta),
    warn: (msg, meta) => emit(LEVEL_ORDER.warn, "warn", namespace, msg, meta),
    error: (msg, meta) => emit(LEVEL_ORDER.error, "error", namespace, msg, meta),
    child: (sub) => createLogger(`${namespace}:${sub}`),
  };
}

/** A logger that drops everything — handy as a default/no-op injection point. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
