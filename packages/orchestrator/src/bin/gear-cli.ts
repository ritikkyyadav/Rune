#!/usr/bin/env bun
import { Engine } from "../engine";
import { formatCostReport } from "../cost-report";
import type { PermissionHandler, UserPermissionDecision } from "../engine";
import {
  hasStoredCredential,
  loadConfig,
  loadSecrets,
  providerKeyEntries,
  setProviderKey as persistKey,
  addProviderKey as persistAddKey,
  removeProviderKey as persistRemoveKey,
  setActiveProviderKey as persistSetActiveKey,
  clearProviderKey as persistClearKey,
  setCustomEndpoint as persistCustom,
  clearCustomEndpoint as persistClearCustom,
  setProviderDisabled as persistDisabled,
  setLocalEndpoint as persistLocalEndpoint,
  getPreset,
  PROVIDER_PRESETS,
  AUTO_PROVIDER_PRIORITY,
  normalizeFallbackOrder,
  normalizeModelIntegrity,
  normalizeSubagentEffort,
  normalizeSubagentMode,
  normalizeQuotaPolicy,
  CUSTOM_PROVIDER_ID,
  applySearchKeysToEnv,
  searchKeyStatus,
  SEARCH_KEY_PRESETS,
  loadLastModel,
  loadPrefs,
  saveLastModel,
  loadSavedSandboxState,
  resolveInitialSandbox,
  saveSandboxState,
  loadSavedBrowserState,
  resolveInitialBrowser,
  saveBrowserState,
  getSystemMemoryPath,
  adoptLegacyEnv,
  ensureGearHome,
  getGearHome,
  migrateLegacyHome,
  workspaceConfigPath,
  openCredentialStore,
} from "@gear/shared";
import type { ProviderName, ResolvedCredential } from "@gear/llm-gateway";
import { configModeToPermissionMode, resolveStartupPermissionFlags } from "../permissions";
import { runTeamCommand } from "../team/command";
import { resolveProviderCredentials } from "../provider-registry";
import { buildSavedKeys, readAuthOverrides } from "./byop-cli-shared";
import {
  armSentinel,
  disarmSentinel,
  sentinelPathFor,
  sweepDirtyExits,
  TelemetryReporter,
  bumpUsage,
  ensureInstallId,
  loadTelemetryState,
  setConsent,
} from "@gear/telemetry";
import { rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { parseArgs } from "util";
import * as readline from "readline";
import { renderWelcome } from "./welcome";
import { TurnRenderer, userBlock, renderReplay } from "./ui/turn";
import { renderStatus } from "./ui/status";
import {
  promptString,
  statusLine,
  composerRule,
  modeInfo,
  permissionModeBanner,
  sandboxModeBanner,
  browserModeBanner,
  renderPermissionCard,
} from "./ui/composer";
import { buildPermissionPreview } from "./ui/permission-preview";
import {
  providerChoices,
  accountChoices,
  modelChoices,
  fetchLiveModels,
  treeHeadline,
  formatProviderLine,
  formatAccountLine,
  formatModelLine,
} from "./ui/model-picker";
import { renderWorkspaceDiff } from "./ui/workspace-diff";
import { truncate, visLen } from "./ui/render";
import * as F from "./ui/flow";
import { runTui } from "./ui/tui";
import { resolveSurface } from "./ui/surface";
import { exportSession } from "../session-export";
import { loadCommands, findCommand } from "../commands";
import { isClarification } from "../research-types";
import type { ResearchPlan, ResearchReport } from "../research-types";
import { renderResearchPlan, renderClarifyingQuestions, formatResearchEvent } from "./ui/research";
import {
  formatLoopDue,
  formatLoopInterval,
  loopPromptPreview,
  type LoopCompletion,
  type LoopTask,
} from "../loop-mode";

// ─── CLI Argument Parsing ───

// `--status` is declared as a STRING (sessions filter by status), so a bare
// `gear serve --status` would swallow the next argument as its value. Rewrite
// it to a positional before parsing, so `gear serve --status` and
// `gear serve status` mean the same thing and neither eats a following flag.
const rawArgv = Bun.argv.slice(2);
if (rawArgv[0] === "serve") {
  const at = rawArgv.indexOf("--status");
  if (at !== -1) rawArgv.splice(at, 1, ...(rawArgv.includes("status") ? [] : ["status"]));
}

const { values, positionals } = parseArgs({
  args: rawArgv,
  options: {
    model: { type: "string", short: "m" },
    provider: { type: "string", short: "p" },
    workspace: { type: "string", short: "w" },
    gear: { type: "string" },
    yolo: { type: "boolean", default: false },
    trust: { type: "boolean", default: false },
    autonomy: { type: "string" },
    resume: { type: "string", short: "r" },
    new: { type: "boolean", short: "n", default: false },
    list: { type: "boolean", short: "l", default: false },
    all: { type: "boolean", default: false },
    status: { type: "string" },
    format: { type: "string", default: "md" },
    sign: { type: "boolean", default: false },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
    // Headless: one prompt in, an answer and an exit code out. `-p` is already
    // --provider's short flag, so this takes -P.
    print: { type: "string", short: "P" },
    json: { type: "boolean", default: false },
    "auto-approve": { type: "boolean", default: false },
    tui: { type: "boolean", default: false },
    classic: { type: "boolean", default: false },
    fullscreen: { type: "boolean", default: false },
    inline: { type: "boolean", default: false },
    pristine: { type: "boolean", default: false },
    sandbox: { type: "boolean" },
    "no-sandbox": { type: "boolean" },
    browser: { type: "boolean" },
    "no-browser": { type: "boolean" },
    // `gear login`: pick an auth method / migrate legacy keys.
    method: { type: "string" },
    migrate: { type: "boolean", default: false },
    "by-version": { type: "boolean", default: false },
    // `gear detach --worktree`: isolate the run in a git worktree checkout.
    worktree: { type: "boolean", default: false },
    // `gear serve`: the websocket transport (see docs/protocol.md).
    port: { type: "string" },
    host: { type: "string" },
    origin: { type: "string" },
    "allow-remote-settings": { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0] ?? "chat";

// Single version string — stamped on every black-box incident so regressions
// are queryable per release. Mirrors the public brand version (Gear v0.1).
const GEAR_VERSION = PRODUCT_VERSION;

// ─── Top-level --version ───

if (values.version) {
  process.stdout.write(`${PRODUCT_LABEL}\n`);
  process.exit(0);
}

// ─── Top-level --help ───

if (values.help) {
  process.stdout.write(
    terminalText(
      `\n  ${PRODUCT_LABEL} — AI coding agent\n\n` +
        `  Usage:\n` +
        `    gear [chat]                   Start chatting — offers to resume recent work (Enter = new)\n` +
        `    gear --new                    Skip the picker and start a fresh session\n` +
        `    gear resume [sessionId]       Resume a session (no id → interactive picker)\n` +
        `    gear list [--all]             List stored sessions (--all includes archived)\n` +
        `    gear export <sessionId>       Export a session transcript\n` +
        `    gear detach "<prompt>"        Start a background run that survives this terminal (--worktree isolates it)\n` +
        `    gear attach [session|latest]  Reattach to a detached run — replay, live-stream, Ctrl+C detaches again\n` +
        `    gear login [provider]         Authenticate a provider — API key, or OAuth where supported (--method, --no-browser, --migrate)\n` +
        `    gear logout <provider>        Remove a provider's stored key/OAuth from the secure store\n` +
        `    gear providers                List providers, their auth method, and credential status\n` +
        `    gear use <provider> [model]   Set the active provider (+ model) for new sessions\n` +
        `    gear models [provider]        List a provider's models (live discovery, static fallback)\n` +
        `    gear doctor                   Health: incidents, crash sentinel, gear-tools, build freshness\n` +
        `    gear tools-smoke              Verify the native tool executor end to end (write/read/edit/bash)\n` +
        `    gear incidents [sub]          Browse recorded failures — list | show <id> | top [--by-version] | export\n` +
        `    gear audit [session|last]     One page on a session: plan with evidence, log, safety decisions, held steps, cost\n` +
        `    gear evolve [sub]             Self-evolution — status | scorecard [--by model|workspace] [--days N] | lessons | tune | gardener [--run]\n` +
        `    gear notebook [sub]           Learned tactics notebook — list | show <id> | rm <id> | export\n` +
        `    gear telemetry [sub]          Opt-in diagnostics — status | on | off | preview | reset (off by default)\n\n` +
        `  Export options:\n` +
        `    --format md|json             Output format (default: md)\n` +
        `    --sign                       Sign the export with Ed25519\n` +
        `    --out <path>                 Write output to file instead of stdout\n\n` +
        `  Global options:\n` +
        `    -m, --model <model>          LLM model to use\n` +
        `    -p, --provider <provider>    LLM provider (anthropic|openai|openrouter|google|ollama-turbo|ollama|lmstudio)\n` +
        `    -w, --workspace <path>       Workspace root directory\n` +
        `    -r, --resume <sessionId>     Resume an existing session\n` +
        `    -n, --new                    Start a fresh session (skip the resume picker)\n` +
        `    --gear <1|2|3|4|auto>        Start in a gear: 1 guided · 2 workspace edits · 3 + sandboxed shell · 4 full autonomy · auto classifier\n` +
        `                                 (Shift+Tab shifts up: 1st → 2nd → 3rd → 4th → auto)\n` +
        `    --autonomy <I|II|III>        Legacy alias for --gear 2|3|4\n` +
        `    --yolo                       Legacy alias for --gear 4\n` +
        `    --trust                      Legacy alias for --gear 3 (workspace trust)\n` +
        `    --classic                    Plain readline prompt (default is the pinned composer)\n` +
        `    --tui                        Force the Codex-style pinned composer\n` +
        `    --inline                     Legacy layout: transcript in the terminal's own scrollback,\n` +
        `                                 only the composer pinned (default pins header + composer)\n` +
        `    --fullscreen                 Accepted, no-op — names the default fixed-chrome layout\n` +
        `    --pristine                   Run without the learned tactics notebook (evolution control group)\n` +
        `    --sandbox / --no-sandbox     Force the OS command sandbox on/off for this run (overrides /sandbox + config)\n` +
        `    --browser / --no-browser     Force the agent browser (Playwright MCP) on/off for this run (overrides /browser + config)\n` +
        `    -h, --help                   Show this help\n\n`,
    ),
  );
  process.exit(0);
}

// ─── Black-box surfaces: no Engine, no provider validation — instant ───

if (command === "doctor") {
  const { runDoctor } = await import("./blackbox-cli");
  runDoctor();
  process.exit(0);
}
if (command === "tools-smoke") {
  // End-to-end native-tools check (CI runs this against the packaged binary).
  const lookup = await findToolsBinary();
  if (!lookup.found) {
    console.error(
      `  ${glyph("failure")} gear-tools not found -- set GEAR_TOOLS_BIN, re-run scripts/install.sh, or \`cargo build --release -p gear-tools\``,
    );
    process.exit(1);
  }
  const { runToolsSmoke } = await import("./tools-smoke-cli");
  process.exit(await runToolsSmoke(lookup.path));
}
if (command === "incidents") {
  const { runIncidents } = await import("./blackbox-cli");
  runIncidents(positionals as string[], values as Record<string, unknown>);
  process.exit(0);
}
if (command === "audit") {
  const { runAudit } = await import("./audit-cli");
  process.exit(await runAudit(positionals.slice(1) as string[], values as Record<string, unknown>));
}
if (command === "evolve") {
  const { runEvolve } = await import("./evolve-cli");
  process.exit(
    await runEvolve(positionals.slice(1) as string[], values as Record<string, unknown>),
  );
}
if (command === "notebook") {
  const { runNotebook } = await import("./notebook-cli");
  runNotebook(positionals as string[], values as Record<string, unknown>);
  process.exit(0);
}
if (command === "telemetry") {
  const { runTelemetry } = await import("./telemetry-cli");
  runTelemetry(positionals.slice(1) as string[]);
  process.exit(0);
}
if (command === "detach") {
  const { runDetach } = await import("./detach-cli");
  await runDetach(positionals as string[], values as Record<string, unknown>);
  process.exit(0);
}
if (command === "attach") {
  const { runAttach } = await import("./detach-cli");
  await runAttach(positionals as string[]);
  process.exit(0);
}
if (command === "serve") {
  // Long-lived: `serve` returns only on shutdown, so no process.exit here.
  const { runServe } = await import("./serve-cli");
  await runServe(positionals as string[], values as Record<string, unknown>);
  if (values.status === true || positionals[1] === "status") process.exit(0);
}

// ─── BYOP: provider authentication surfaces (no Engine boot) ───

if (command === "login") {
  const { runLogin } = await import("./login-cli");
  await runLogin(positionals.slice(1) as string[], values as Record<string, unknown>);
  process.exit(process.exitCode ?? 0);
}
if (command === "logout") {
  const { runLogout } = await import("./login-cli");
  await runLogout(positionals.slice(1) as string[]);
  process.exit(process.exitCode ?? 0);
}
if (command === "providers") {
  const { runProviders } = await import("./providers-cli");
  await runProviders();
  process.exit(process.exitCode ?? 0);
}
if (command === "use") {
  const { runUse } = await import("./providers-cli");
  await runUse(positionals.slice(1) as string[]);
  process.exit(process.exitCode ?? 0);
}
if (command === "models") {
  const { runModels } = await import("./providers-cli");
  await runModels(positionals.slice(1) as string[]);
  process.exit(process.exitCode ?? 0);
}

type CliProvider =
  "anthropic" | "openai" | "openrouter" | "google" | "ollama-turbo" | "ollama" | "lmstudio";

const DEFAULT_MODELS: Record<CliProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  // qwen/qwen3-coder:free and qwen3-coder:480b were retired 2026-07-15, and
  // deepseek-v4-flash:free was withdrawn from the free tier 2026-08-26;
  // these mirror the gateway's refreshed, live-verified defaults.
  openrouter: "minimax/minimax-m3:free",
  google: "gemini-2.5-flash",
  "ollama-turbo": "gpt-oss:120b",
  ollama: "llama3.1",
  lmstudio: "local-model",
};

/** Local runtimes that need no API key — reached by base URL on this machine. */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["ollama", "lmstudio"]);

function isCliProvider(provider: string): provider is CliProvider {
  return (
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "openrouter" ||
    provider === "google" ||
    provider === "ollama-turbo" ||
    provider === "ollama" ||
    provider === "lmstudio"
  );
}

function configuredModelForProvider(
  config: ReturnType<typeof loadConfig>,
  provider: CliProvider,
): string | undefined {
  switch (provider) {
    case "anthropic":
      return config.llm.anthropic?.model;
    case "openai":
      return config.llm.openai?.model;
    case "openrouter":
      return config.llm.openrouter?.model;
    case "google":
      return config.llm.google?.model;
    case "ollama":
      return config.llm.ollama?.model;
    case "lmstudio":
      return config.llm.lmstudio?.model;
    case "ollama-turbo":
      // No dedicated config.llm section; fall back to DEFAULT_MODELS / --model.
      return undefined;
  }
}

/** Merge local-runtime base URLs from config.toml + the secrets sidecar (secrets win). */
function resolveLocalBaseUrls(
  config: ReturnType<typeof loadConfig>,
  secrets: ReturnType<typeof loadSecrets>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (config.llm.ollama?.baseUrl) out.ollama = config.llm.ollama.baseUrl;
  if (config.llm.lmstudio?.baseUrl) out.lmstudio = config.llm.lmstudio.baseUrl;
  for (const [id, url] of Object.entries(secrets.endpoints ?? {})) {
    if (url) out[id] = url;
  }
  return out;
}

/**
 * The full key pool per provider for the `/keys` panel, built from secrets so a
 * provider that has ANY saved key (a single legacy key or a multi-account pool)
 * gets a stable-id entry list with dates. Restricted to real provider presets so
 * the non-provider search keys (tavily/brave) don't leak into the panel.
 */
function providerKeyEntryMap(
  secrets: ReturnType<typeof loadSecrets>,
): Record<string, import("@gear/shared").StoredKey[]> {
  const out: Record<string, import("@gear/shared").StoredKey[]> = {};
  for (const preset of PROVIDER_PRESETS) {
    const entries = providerKeyEntries(secrets, preset.id);
    if (entries.length) out[preset.id] = entries;
  }
  return out;
}

// ─── Resolve Tool Binary ───

/**
 * Locate the Rust tool executor. Order: GEAR_TOOLS_BIN (legacy ALAN_TOOLS_BIN is
 * adopted at startup) → the source checkout's target/{release,debug}/gear-tools
 * → ~/.gear/bin/gear-tools (installed next to the launcher) → `gear-tools` on
 * PATH. A bare name that is not on PATH makes every tool call fail later, so the
 * startup path warns loudly instead of silently degrading.
 */
async function findToolsBinary(): Promise<{ path: string; found: boolean }> {
  const candidates: string[] = [];
  const envPath = process.env.GEAR_TOOLS_BIN;
  if (envPath) candidates.push(envPath);
  candidates.push(
    new URL("../../../../target/release/gear-tools", import.meta.url).pathname,
    new URL("../../../../target/debug/gear-tools", import.meta.url).pathname,
    joinPath(getGearHome(), "bin", "gear-tools"),
  );
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return { path: candidate, found: true };
  }
  const onPath = Bun.which("gear-tools");
  if (onPath) return { path: onPath, found: true };
  return { path: "gear-tools", found: false };
}

// ─── Ensure Data Directory ───

function ensureDataDir(): string {
  return ensureGearHome();
}

// ─── Colors (L'Atlas Terminal Palette) ───

import {
  bold,
  paper,
  dim,
  vermillion,
  brass,
  cyanotype,
  green,
  stripAnsi,
  text,
  muted,
  faint,
  info,
  warn,
  accent,
  ok,
  setTheme,
  configureAutoTheme,
  getTheme,
  listThemes,
  swatch,
  terminalThemeSeq,
  TERMINAL_THEME_RESET,
} from "./colors";
import { loadSavedTheme, resolveInitialTheme, saveTheme } from "./ui/theme-store";
import { detectTerminalColors } from "./ui/terminal-colors";
import {
  buildInteractiveDirective,
  loadInteractiveAuto,
  saveInteractiveAuto,
  shouldOfferInteractive,
} from "./ui/interactive";
import { PRODUCT_VERSION, PRODUCT_LABEL } from "./ui/brand";
import { glyph, terminalText } from "./ui/glyphs";

/** A compact "2h ago" style age for the session list and pickers. */
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/** Find a session by exact id or unique id-prefix, across every status. */
function findSessionByIdish(engine: Engine, idish: string) {
  const all = engine.listSessions({ status: "all" });
  return all.find((s) => s.id === idish) ?? all.find((s) => s.id.startsWith(idish));
}

type ListedSession = ReturnType<Engine["listSessions"]>[number];

/** Untouched launch placeholders are not user history and should never fill a picker. */
function isMeaningfulSession(session: ListedSession): boolean {
  return session.eventCount > 0 || Boolean(session.title?.trim());
}

function discardSessionIfEmpty(engine: Engine, id: string): void {
  const session = engine.getSessionInfo(id);
  if (!session || session.eventCount > 0 || session.title?.trim()) return;
  try {
    engine.purgeSession(id);
  } catch {
    // Best-effort housekeeping must not block resume or shutdown.
  }
}

/** Resolve `gear resume <id>` / `--resume <id>` to a session, reconciling its model+provider. */
function resolveResumeId(engine: Engine, idish: string): string {
  const found = findSessionByIdish(engine, idish);
  if (!found) {
    process.stdout.write(
      `  ${brass("⚠")} ${dim("no session matches")} ${text(idish)} ${dim("— starting a new one")}\n`,
    );
    return engine.createSession();
  }
  engine.resumeSession(found.id);
  return found.id;
}

/** `gear resume` with no id: a numbered picker on a TTY, most-recent on a pipe. */
async function pickSessionToResume(engine: Engine): Promise<string> {
  const sessions = engine.listSessions().filter(isMeaningfulSession);
  if (sessions.length === 0) {
    process.stdout.write(`  ${dim("No saved sessions — starting fresh.")}\n`);
    return engine.createSession();
  }
  if (!process.stdin.isTTY) {
    engine.resumeSession(sessions[0].id);
    return sessions[0].id;
  }
  const top = sessions.slice(0, 15);
  process.stdout.write(`\n  ${bold(text("Resume a session"))}\n\n`);
  top.forEach((s, i) => {
    const title = s.title?.trim() || "untitled";
    process.stdout.write(
      `    ${brass(String(i + 1).padStart(2))}  ${text(title)}\n` +
        `        ${dim(`${relTime(s.updatedAt)} · ${s.eventCount} events · ${s.model}`)}\n`,
    );
  });
  process.stdout.write(`\n  ${dim("Enter a number, or press Enter for a new session.")}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question(`  ${info("›")} `, res));
  rl.close();
  const n = parseInt(answer.trim(), 10);
  if (!answer.trim() || Number.isNaN(n) || n < 1 || n > top.length) {
    return engine.createSession();
  }
  engine.resumeSession(top[n - 1].id);
  return top[n - 1].id;
}

/** Resolve a `/resume`/`/delete`/`/archive` argument: a 1-based index into the active list, or an id-prefix. */
function resolveSessionArg(engine: Engine, arg: string) {
  const a = arg.trim();
  if (/^\d+$/.test(a))
    return engine.listSessions().filter(isMeaningfulSession)[parseInt(a, 10) - 1];
  return findSessionByIdish(engine, a);
}

/** Print a session's replayed history to stdout (classic path). Renders the same
 *  two-partition language as a live turn — work inside the rail, each turn's final
 *  answer outside it — so a resumed session is faithful. */
/**
 * The `resumed <title> <id>` marker that opens a replayed session.
 *
 * The title is budgeted against the measure rather than printed whole: a long
 * session title ran this row two cells past an 80-column window, and a line
 * that reaches the terminal's last cell soft-wraps -- which is the one thing
 * every other row in this UI is careful not to do.
 */
function resumedBanner(title: string | null | undefined, id: string): string {
  const lead = `  ${faint("\u2576\u2500")} ${muted("resumed")} `;
  const tail = ` ${faint(id.slice(0, 8))} ${faint("\u2576\u2500")}`;
  const room = Math.max(8, F.measure() - visLen(lead) - visLen(tail));
  return `${lead}${text(truncate(title?.trim() || "untitled", room))}${tail}`;
}

function printSessionTranscript(engine: Engine, id: string): void {
  const lines = engine.getTranscript(id);
  if (lines.length === 0) {
    process.stdout.write(`  ${faint("(no earlier messages)")}\n`);
    return;
  }
  process.stdout.write(renderReplay(lines) + "\n");
}

/** Recolour the whole terminal (fg+bg) to the active theme — only on a real TTY. */
function applyTerminalTheme(): void {
  if (process.stdout.isTTY) process.stdout.write(terminalThemeSeq());
}

// ─── Opt-in telemetry: first-run consent prompt ───
// Asked at most once (persisted in ~/.gear/telemetry.json), only on an
// interactive TTY, and only when a collector endpoint is configured. Default is
// NO — a bare Enter, a pipe, or any non-"yes" answer leaves telemetry off.
async function askTelemetryConsent(): Promise<boolean> {
  process.stdout.write(
    `\n  ${bold(text("Help improve Gear?"))}\n` +
      `  ${dim("Send anonymous, redacted diagnostics — crash/error reports and a daily usage")}\n` +
      `  ${dim("heartbeat — so bugs get fixed before the next release. Off unless you say yes.")}\n\n` +
      `  ${faint("· No file contents, prompts, IP address, or device id — ever.")}\n` +
      `  ${faint("· Inspect the exact payloads any time:")} ${info("gear telemetry preview")}\n` +
      `  ${faint("· Change your mind any time:")} ${info("gear telemetry on|off")}\n\n`,
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`  ${text("Share anonymous diagnostics?")} ${dim("[y/N]")} `, resolve);
    });
    return /^\s*y(es)?\s*$/i.test(answer);
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

// ─── Main ───

async function main() {
  // Rename migration: ALAN_* env → GEAR_*, ~/.alan → ~/.gear (once, with a note).
  adoptLegacyEnv();
  const homeMigrationNote = migrateLegacyHome();
  if (homeMigrationNote) console.error(`  ${dim(`gear: ${homeMigrationNote}`)}`);
  const dataDir = ensureDataDir();
  const toolsLookup = await findToolsBinary();
  const toolsBinary = toolsLookup.path;
  if (!toolsLookup.found) {
    console.error(
      `  ${vermillion("⚠")} ${dim("gear-tools binary not found — set GEAR_TOOLS_BIN, re-run scripts/install.sh, or `cargo build --release -p gear-tools`; file and shell tools will fail until then (`gear doctor` shows what was searched).")}`,
    );
  }
  const workspaceRoot = (values.workspace as string | undefined) ?? process.cwd();

  const config = loadConfig(workspaceRoot);
  const secrets = loadSecrets();

  // Learn the host terminal surface before anything repaints it. The adaptive
  // "auto" theme uses the reported foreground/background (including custom
  // red/blue profiles) to derive accessible semantic colors while preserving
  // the terminal itself. One-shot printers skip the probe: they exit before a
  // slow terminal answers, and the late OSC reply would land in the SHELL
  // prompt as typed junk. (detectTerminalColors itself no-ops off-TTY.)
  const oneShotCommand =
    command === "list" ||
    command === "export" ||
    Boolean(values.list) ||
    typeof values.print === "string";
  if (!oneShotCommand) configureAutoTheme(await detectTerminalColors());

  // Apply the persisted / configured color mode before anything renders.
  // GEAR_THEME (legacy ALAN_THEME is adopted at startup).
  setTheme(
    resolveInitialTheme({
      env: process.env.GEAR_THEME,
      saved: loadSavedTheme(),
      configured: config.ui?.theme,
    }),
  );
  // The TUI paints its own background edge-to-edge in the alternate screen, so OSC terminal
  // recolouring is applied only on the classic readline path (set up after the TUI branch).

  // ─── Smart Provider Detection ───
  // Priority: CLI arg > config > auto-detect from available API keys
  function detectBestProvider(): CliProvider {
    // Prefer reliable/funded capacity when several keys exist. Explicit CLI,
    // config, and the user's sticky /model choice have already won above.
    const envVars: Record<(typeof AUTO_PROVIDER_PRIORITY)[number], string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    };
    for (const provider of AUTO_PROVIDER_PRIORITY) {
      const cfgSection = config.llm[provider] as { apiKey?: string } | undefined;
      const envVar = envVars[provider];
      if (process.env[envVar] || cfgSection?.apiKey) return provider;
    }
    // Keyed hosts without an [llm.*] config section: a saved /keys secret (or
    // env var) is a working credential too. Without this, a user whose ONLY
    // key was ollama-turbo auto-detected into a keyless openrouter boot.
    if (process.env.OLLAMA_API_KEY || secrets.keys["ollama-turbo"]) return "ollama-turbo";
    return "openrouter"; // last resort
  }

  const cliProvider = values.provider as string | undefined;
  const configProvider = config.llm.defaultProvider;

  // Does a provider have working credentials — an env var, an [llm.*].apiKey, or a /keys secret?
  // ollama-turbo carries no [llm.*] section (its key lives in secrets.json / OLLAMA_API_KEY).
  const providerEnvVar: Partial<Record<CliProvider, string>> = {
    google: "GOOGLE_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "ollama-turbo": "OLLAMA_API_KEY",
  };
  const hasCreds = (p: CliProvider): boolean => {
    // Local runtimes are keyless — always "available"; reachability of the
    // localhost server is surfaced at call time, not gated here.
    if (LOCAL_PROVIDERS.has(p)) return true;
    const envVar = providerEnvVar[p];
    return (
      !!(envVar && process.env[envVar]) ||
      !!(config.llm[p as keyof typeof config.llm] as { apiKey?: string } | undefined)?.apiKey ||
      !!secrets.keys[p]
    );
  };

  // The model you last used IS the model you get. It loses only to an explicit
  // --model/--provider on this run; nothing else outranks it, and there is no
  // separate "default" to keep in sync.
  //
  // This used to be gated on `isCliProvider`, a hand-written list of seven ids
  // that was never updated when the subscription providers were added — so a
  // sticky `codex` model failed the gate and every new session silently opened
  // on an auto-detected google/gemini-2.5-flash instead of the GPT-5.6 the user
  // had chosen. `hasCreds` was the second half of the same bug: it knew env
  // vars, [llm.*].apiKey and the legacy secrets file, none of which a
  // subscription provider uses. Both are now asked of the provider registry and
  // the credential store, so adding a provider cannot break stickiness again.
  const lastUsed = !cliProvider && !values.model ? loadLastModel() : null;
  const stickyUsable = (p: string): boolean =>
    getPreset(p) !== undefined &&
    (LOCAL_PROVIDERS.has(p) || hasStoredCredential(p) || (isCliProvider(p) && hasCreds(p)));
  const sticky = lastUsed && stickyUsable(lastUsed.provider) ? lastUsed : null;

  let provider: ProviderName;
  let model: string;
  if (sticky) {
    provider = sticky.provider as ProviderName;
    model = sticky.model;
  } else {
    // CLI arg first, then config (only if that provider has a key), then auto-detect.
    if (cliProvider && isCliProvider(cliProvider)) provider = cliProvider;
    else if (configProvider && isCliProvider(configProvider) && hasCreds(configProvider))
      provider = configProvider;
    else provider = detectBestProvider();
    model =
      (values.model as string | undefined) ??
      configuredModelForProvider(config, provider) ??
      DEFAULT_MODELS[provider];
  }

  // Explicit CLI gear flags win over the persisted gear.
  const gearFlag = values.gear !== undefined ? String(values.gear) : undefined;
  if (gearFlag !== undefined && !configModeToPermissionMode(gearFlag)) {
    throw new Error(`Invalid --gear "${gearFlag}"; use 1, 2, 3, 4, or auto`);
  }
  // Legacy --autonomy I|II|III → 2nd|3rd|4th gear.
  const autonomyFlag = values.autonomy
    ? String(values.autonomy).toLowerCase().startsWith("autonomy")
      ? String(values.autonomy)
      : `autonomy-${String(values.autonomy)}`
    : undefined;
  if (autonomyFlag && !configModeToPermissionMode(autonomyFlag)) {
    throw new Error(`Invalid --autonomy level "${values.autonomy}"; use I, II, or III (or --gear)`);
  }
  // The gear the last session ended in, remembered — see prefs-store. It sits
  // BELOW an explicit flag and below the project's own config, and above the
  // built-in default: a flag is this run's instruction and a config file is the
  // project's policy, but between two runs with neither, what the user last
  // chose is the best available answer. Opening on the built-in default instead
  // means re-stating a preference every morning, which is not a preference.
  const rememberedGear = loadPrefs().gear;
  const { yoloMode, trustWorkspace, permissionMode } = resolveStartupPermissionFlags({
    gearFlag,
    yoloFlag: values.yolo as boolean,
    trustFlag: values.trust as boolean,
    modeFlag: autonomyFlag,
    configGear: config.permissions?.gear ?? rememberedGear,
    configMode: config.permissions?.mode,
    configTrustWorkspace: config.permissions?.trustWorkspace,
  });
  // Make the [search].provider config visible to the env-based backend selector
  // used by the web_search tool (keys themselves already come from the env).
  if (
    config.search?.provider &&
    config.search.provider !== "auto" &&
    !process.env.GEAR_SEARCH_BACKEND &&
    !process.env.GEAR_SEARCH_BACKEND
  ) {
    process.env.GEAR_SEARCH_BACKEND = config.search.provider;
  }
  // Copy saved Tavily/Brave keys into the env so the web_search backends (used
  // by /research) pick them up; keyless DuckDuckGo remains the fallback.
  applySearchKeysToEnv();
  // Sandbox posture: flag > GEAR_SANDBOX_ENABLED env > /sandbox sidecar > config > on.
  const sandboxEnabled = resolveInitialSandbox({
    flag: values["no-sandbox"] === true ? false : values.sandbox === true ? true : undefined,
    env: process.env.GEAR_SANDBOX_ENABLED ?? null,
    saved: loadSavedSandboxState(),
    configured: config.sandbox?.enabled ?? null,
  });
  // Browser posture: flag > GEAR_BROWSER_ENABLED env > /browser sidecar > config > off.
  const browserEnabled = resolveInitialBrowser({
    flag: values["no-browser"] === true ? false : values.browser === true ? true : undefined,
    env: process.env.GEAR_BROWSER_ENABLED ?? null,
    saved: loadSavedBrowserState(),
    configured: config.browser?.enabled ?? null,
  });

  // ─── BYOP: resolve stored credentials (keychain / OAuth) before boot ───
  // Best-effort: any failure yields an empty map, and the gateway then falls back
  // to today's exact env/secrets key resolution — so this is byte-identical to
  // pre-BYOP for anyone who never runs `gear login`.
  let credentials: Record<string, ResolvedCredential> = {};
  try {
    const store = await openCredentialStore();
    credentials = await resolveProviderCredentials({
      store,
      keys: buildSavedKeys(config, secrets),
      active: provider as ProviderName,
      disabled: new Set(secrets.disabled ?? []),
      localBaseUrls: resolveLocalBaseUrls(config, secrets),
      authOverrides: readAuthOverrides(config),
    });
  } catch {
    credentials = {};
  }

  // ─── [fallback] order: validate before it can quietly do nothing ───
  const fallbackOrder = normalizeFallbackOrder(config.fallback?.order);
  if (fallbackOrder.unknown.length > 0) {
    console.warn(
      `  ${brass("!")} ${dim(
        `[fallback] order: ignoring unknown provider${
          fallbackOrder.unknown.length === 1 ? "" : "s"
        } ${fallbackOrder.unknown.join(", ")} — the rest of the list still applies`,
      )}`,
    );
  }

  const engine = new Engine({
    model,
    provider,
    workspaceRoot,
    dbPath: config.engine.dbPath,
    toolsBinaryPath: toolsBinary,
    yoloMode,
    trustWorkspace,
    permissionMode,
    autoMode: config.permissions?.autoMode,
    reasoningEffort: config.llm?.reasoningEffort,
    doctrineDelivery: config.llm?.doctrineDelivery,
    effortRouting: config.llm?.effortRouting,
    sandboxEnabled,
    sandboxRequireOs: config.sandbox?.requireOs === true,
    lspAutoFeedback: config.lsp?.autoFeedback === true,
    reliability: config.reliability,
    fallbackOrder: fallbackOrder.order as ProviderName[],
    quotaPolicy: normalizeQuotaPolicy(config.fallback?.onQuotaExceeded),
    modelIntegrity: normalizeModelIntegrity(config.fallback?.modelIntegrity),
    // [verify] — previously EngineConfig-only, unreachable from any config.
    enableVerification: config.verify?.enabled,
    verifyCommand: config.verify?.commands,
    verifyPerStep: config.verify?.perStep,
    verifyTimeoutMs:
      typeof config.verify?.timeoutSecs === "number" && config.verify.timeoutSecs > 0
        ? Math.floor(config.verify.timeoutSecs * 1000)
        : undefined,
    browser: { ...config.browser, enabled: browserEnabled },
    // Pass config-file keys as "saved" — but NOT when they merely echo an env
    // var (loadConfig folds env into config.llm.*), so an env-only key is
    // reported as "env" by the gateway's env fallback instead of "saved".
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ? undefined : config.llm.anthropic?.apiKey,
    openaiApiKey: process.env.OPENAI_API_KEY ? undefined : config.llm.openai?.apiKey,
    openrouterApiKey: process.env.OPENROUTER_API_KEY ? undefined : config.llm.openrouter?.apiKey,
    googleApiKey: process.env.GOOGLE_API_KEY ? undefined : config.llm.google?.apiKey,
    // BYOP: credentials resolved from the secure store (keychain) + OAuth tokens.
    credentials,
    // BYOK keys + custom endpoint + toggles from ~/.gear/secrets.json (win over config.toml).
    providerKeys: secrets.keys,
    // Multi-account pools + active selection so the panel can show every key + date.
    providerKeyEntries: providerKeyEntryMap(secrets),
    activeKeyId: secrets.activeKeyId,
    customEndpoint: secrets.custom,
    disabledProviders: secrets.disabled,
    // Local runtime base URLs (ollama / lmstudio): config.toml defaults + /keys edits.
    localBaseUrls: resolveLocalBaseUrls(config, secrets),
    search: config.search,
    research: config.research,
    memory: config.memory,
    tiers: config.tiers,
    subagents: {
      mode: normalizeSubagentMode(config.subagents?.mode),
      model: config.subagents?.model,
      effort: normalizeSubagentEffort(config.subagents?.effort),
    },
    git: config.git,
    context: config.context,
    // Autonomy toggle precedence: /interactive sidecar > [interactive] auto.
    interactive: { auto: loadInteractiveAuto() ?? config.interactive?.auto },
    // Multi-instance teamwork: on by default for the real CLI ([team] can turn
    // it off). Unit tests construct the Engine directly and stay hermetic.
    team: config.team,
    // Black box: on by default for the real CLI (config [diagnostics] can turn
    // it off). Unit tests construct the Engine directly and stay hermetic.
    // The trail spool is pid-scoped so two concurrent Gear instances don't
    // overwrite each other's flight data (it pairs with the pid-scoped
    // crash sentinel armed below).
    blackbox:
      config.diagnostics?.enabled !== false
        ? {
            enabled: true,
            version: GEAR_VERSION,
            spoolPath: joinPath(getGearHome(), `blackbox.spool.${process.pid}.json`),
          }
        : undefined,
    // Tactics notebook: on by default; `--pristine` runs without any learned
    // context (the control group for measuring evolution lift).
    notebook: {
      enabled: !(values.pristine as boolean) && config.notebook?.enabled !== false,
    },
    // Self-evolution: the retro is always written; the playbook follows
    // config ([evolve] playbook = false turns the file off).
    evolve: config.evolve,
  });

  // ─── DB-only commands — run before provider validation ───

  if (command === "list" || values.list) {
    const showAll = !!values.all || (values.status as string) === "archived";
    const sessions = engine
      .listSessions(showAll ? { status: "all" } : undefined)
      .filter(isMeaningfulSession);
    const archivedCount = showAll
      ? 0
      : engine.listSessions({ status: "archived" }).filter(isMeaningfulSession).length +
        engine.listSessions({ status: "deleted" }).filter(isMeaningfulSession).length;
    if (sessions.length === 0) {
      console.log(dim("  No sessions found."));
    } else {
      console.log(`\n  ${dim("§ SESSIONS")}\n`);
      for (const s of sessions) {
        const title = s.title?.trim() || dim("untitled");
        const tag = s.status !== "active" ? ` ${brass(`[${s.status}]`)}` : "";
        console.log(
          `  ${cyanotype(s.id.slice(0, 8))}  ${text(title)}${tag}` +
            `\n            ${dim(`${relTime(s.updatedAt)} · ${s.eventCount} events · ${s.model}`)}`,
        );
      }
      if (archivedCount > 0) {
        console.log(
          `\n  ${dim(`+ ${archivedCount} archived/deleted — `)}${dim("gear list --all")}`,
        );
      }
      console.log(
        `\n  ${dim("Resume: ")}${cyanotype("gear resume")}${dim(" (picker) or ")}${cyanotype("gear resume <id>")}\n`,
      );
    }
    engine.close();
    return;
  }

  if (command === "export") {
    const sessionId = positionals[1];
    if (!sessionId) {
      process.stderr.write(
        `  ${vermillion("✕")} Usage: gear export <sessionId> [--format md|json] [--sign] [--out <path>]\n`,
      );
      engine.close();
      process.exit(1);
    }

    const format = (values.format as string | undefined) ?? "md";
    if (format !== "md" && format !== "json") {
      process.stderr.write(
        `  ${vermillion("✕")} Invalid format: ${format}. Must be "md" or "json".\n`,
      );
      engine.close();
      process.exit(1);
    }

    const sign = values.sign as boolean;
    const outPath = values.out as string | undefined;

    try {
      const result = await exportSession(config.engine.dbPath, sessionId, { format, sign });

      if (outPath) {
        await Bun.write(outPath, result.content);
        process.stdout.write(`  ${green("✓")} Export written to ${brass(outPath)}\n`);
      } else {
        process.stdout.write(result.content);
        if (!result.content.endsWith("\n")) process.stdout.write("\n");
      }

      if (sign && result.signature && result.publicKey) {
        process.stdout.write(`\n  ${dim("§ SIGNATURE")}\n\n`);
        process.stdout.write(`  ${dim("signature:")}  ${result.signature}\n`);
        process.stdout.write(`  ${dim("public-key:")}\n${result.publicKey}\n`);
        if (result.chainHead) {
          process.stdout.write(`  ${dim("chain-head:")} ${result.chainHead}\n`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ${vermillion("✕")} ${msg}\n`);
      engine.close();
      process.exit(1);
    }

    engine.close();
    return;
  }

  // ─── Startup Provider Validation ───
  const registeredProviders = engine.getRegisteredProviders();
  if (registeredProviders.length === 0) {
    process.stdout.write(
      `\n  ${vermillion("✕")} ${vermillion("No API keys configured.")}\n` +
        `  ${dim("Set at least one API key to get started:")}\n\n` +
        `  ${brass("export GOOGLE_API_KEY=")}${dim('"your-key"')}       ${dim("# free tier — recommended")}\n` +
        `  ${brass("export OPENROUTER_API_KEY=")}${dim('"your-key"')}   ${dim("# free models available")}\n` +
        `  ${brass("export ANTHROPIC_API_KEY=")}${dim('"your-key"')}    ${dim("# Claude models")}\n` +
        `  ${brass("export OPENAI_API_KEY=")}${dim('"your-key"')}      ${dim("# GPT models")}\n\n` +
        `  ${dim("Or add apiKey to ~/.gear/config.toml")}\n\n`,
    );
    engine.close();
    process.exit(1);
  }
  if (!registeredProviders.includes(provider as any)) {
    // Selected provider has no key — auto-switch to first available
    const fallback = registeredProviders[0];
    process.stdout.write(
      `  ${brass("⚠")} ${dim(`${provider} has no API key, using`)} ${green(fallback)} ${dim("instead")}\n`,
    );
    engine.switchModel(DEFAULT_MODELS[fallback as CliProvider] ?? DEFAULT_MODELS.google, fallback);
  }

  // ─── Composer mode decision (needed before session resolution) ───
  // The TUI — the focused terminal workbench from docs/design/gear-customizer.html — is the default on
  // interactive terminals, with fixed chrome: a pinned header, a scrolling transcript and a pinned
  // composer. `--inline` remains the escape hatch for users who value the terminal's own scrollback
  // over a fixed frame. Piped/non-TTY stdin and `--classic` / GEAR_CLASSIC fall back to the plain
  // readline prompt; `--tui` / GEAR_TUI force the TUI even past `--classic`.
  const surface = resolveSurface({
    isTTY: !!process.stdin.isTTY,
    classicForced: (values.classic as boolean) || !!process.env.GEAR_CLASSIC,
    tuiForced: (values.tui as boolean) || !!process.env.GEAR_TUI,
    inline: (values.inline as boolean) || !!process.env.GEAR_INLINE,
    fullscreenForced: (values.fullscreen as boolean) || !!process.env.GEAR_FULLSCREEN,
  });
  const useTui = surface.useTui;

  // ─── Create or resume session (one native flow) ───
  // `gear resume [id]` / `--resume <id>` target a specific session. Otherwise, on an
  // interactive terminal with prior sessions, a smart picker offers to resume (Enter =
  // new) — so "continue where you left off" is the front door, not a flag to remember.
  // `--new`/`-n` and non-interactive runs skip straight to a fresh session. In the TUI
  // the picker is shown inside the alternate screen (launchPick); classic uses readline.
  const resumeId =
    command === "resume"
      ? (positionals[1] ?? (values.resume as string | undefined))
      : (values.resume as string | undefined);
  const wantNew = !!values.new;
  const explicitResumePick = command === "resume" && !resumeId;
  const defaultLaunch = command === "chat" && !resumeId && !wantNew;
  const offerPicker =
    (explicitResumePick || defaultLaunch) &&
    !!process.stdin.isTTY &&
    engine.listSessions().some(isMeaningfulSession);

  let sessionId: string;
  let launchPick = false;
  if (resumeId) {
    sessionId = resolveResumeId(engine, resumeId);
  } else if (offerPicker && useTui) {
    sessionId = engine.createSession();
    launchPick = true; // the TUI renders the picker itself, in its pinned region
  } else if (explicitResumePick || offerPicker) {
    sessionId = await pickSessionToResume(engine); // classic readline picker (most-recent on a pipe)
  } else {
    sessionId = engine.createSession();
  }
  // User commands plus plugin-bundled ones (tagged with their plugin; user
  // names win on conflict — the loader refuses shadowing with a warning).
  const pluginCommandDirs = engine
    .listPlugins()
    .plugins.flatMap((p) => p.commandDirs.map((dir) => ({ dir, source: p.name })));
  const customCommands = await loadCommands(workspaceRoot, pluginCommandDirs);

  // ─── Black box: crash forensics for the interactive session ───
  // Arm a pid-scoped sentinel now; it is removed by the process "exit" hook,
  // so it only survives a SIGKILL / power-loss class death — exactly the
  // failure no in-process handler can record. The startup sweep consumes only
  // markers whose owner pid is DEAD, so concurrent Gear tabs never file
  // false dirty-exit incidents about each other. Next startup turns real
  // leftovers into dirty_exit incidents carrying the spooled flight trail.
  const recorder = engine.getRecorder();
  const sentinelDir = joinPath(getGearHome(), "sentinels");
  const ownSentinel = sentinelPathFor(sentinelDir, process.pid);
  const ownSpool = joinPath(getGearHome(), `blackbox.spool.${process.pid}.json`);
  if (recorder) {
    // ─── Opt-in telemetry: consent + attach the outbound sink ───
    // Only when a collector endpoint is actually configured. First-run consent
    // is asked at most once, only on a TTY, default NO. The sink is attached
    // BEFORE the dirty-exit sweep below so last run's hard-kill crash report is
    // forwarded too. All network is deferred to the fire-and-forget flush at the
    // end of this block, so nothing here waits on connectivity.
    let telemetryReporter: TelemetryReporter | null = null;
    const tcfg = config.telemetry;
    if (tcfg?.enabled && tcfg?.endpoint) {
      const home = getGearHome();
      if (loadTelemetryState(home).decision === null && process.stdin.isTTY) {
        const granted = await askTelemetryConsent();
        setConsent(home, granted ? "granted" : "denied");
      }
      const installId = ensureInstallId(home); // null unless consent granted
      if (installId) {
        telemetryReporter = new TelemetryReporter({
          home,
          endpoint: tcfg.endpoint,
          token: tcfg.token,
          installId,
          version: GEAR_VERSION,
          streams: { crash: tcfg.crashReports !== false, usage: tcfg.usageStats !== false },
        });
        recorder.setSink((r) => telemetryReporter?.onIncident(r));
        bumpUsage(home, "sessions", 1);
        telemetryReporter.maybeHeartbeat(loadTelemetryState(home));
      }
    }

    const dirtyExits = sweepDirtyExits(sentinelDir, {
      legacyPath: joinPath(getGearHome(), "blackbox.sentinel.json"),
    });
    for (const dirty of dirtyExits.slice(0, 3)) {
      recorder.seedTrail(dirty.trail);
      recorder.recordFatal({
        class: "crash.dirty_exit",
        severity: "critical",
        component: "cli",
        where: "gear-cli#startup",
        message:
          `previous run (v${dirty.meta.version}` +
          `${dirty.meta.sessionId ? `, session ${dirty.meta.sessionId.slice(0, 8)}` : ""}, ` +
          `started ${dirty.meta.startedAt}) exited without cleanup`,
      });
      recorder.seedTrail([]);
    }
    // Incidents still pending from long-dead processes can never resolve now.
    // Only sweep old ones so a concurrently running gear isn't clobbered.
    recorder.getStore()?.sweepPending(new Date(Date.now() - 2 * 3_600_000).toISOString());
    armSentinel(ownSentinel, {
      pid: process.pid,
      version: GEAR_VERSION,
      sessionId,
      startedAt: new Date().toISOString(),
      spoolPath: ownSpool,
    });
    process.on("exit", () => {
      disarmSentinel(ownSentinel);
      // Clean exit needs no flight trail — drop the spool so pid-scoped
      // spools don't accumulate in ~/.gear.
      try {
        rmSync(ownSpool, { force: true });
      } catch {
        // best-effort
      }
    });
    // ─── Terminal closed / killed: exit cleanly instead of faking a crash ───
    // Node's DEFAULT disposition for SIGHUP and SIGTERM terminates the process
    // WITHOUT running "exit" hooks, so the sentinel above stayed armed and the
    // next startup filed a `critical` crash.dirty_exit. Closing the terminal
    // window is not a crash. It was the single most common incident in this
    // install's black box — 143 records, six of them inside six minutes — and
    // the noise is worse than the miss: a real SIGKILL is indistinguishable
    // from a closed tab, which is the one thing this sentinel exists to tell
    // apart. Registered here, next to the arming, so BOTH front ends get it
    // (the classic-readline path had a SIGTERM handler; the TUI — the default
    // UI — had none). Conventional 128+signo exit codes; process.exit runs the
    // "exit" hooks above, which disarm the sentinel and drop the spool.
    const exitOnSignal = (signal: "SIGHUP" | "SIGTERM", code: number) => {
      process.on(signal, () => {
        try {
          discardSessionIfEmpty(engine, sessionId);
          engine.close();
        } catch {
          // Shutting down anyway — never let cleanup keep the process alive.
        }
        process.exit(code);
      });
    };
    exitOnSignal("SIGHUP", 129);
    exitOnSignal("SIGTERM", 143);

    process.on("uncaughtException", (err: Error) => {
      recorder.recordFatal({
        class: "crash.uncaught_exception",
        severity: "critical",
        component: "cli",
        where: "process#uncaughtException",
        message: err?.message ?? String(err),
        stack: err?.stack,
      });
      console.error(err);
      process.exit(1); // runs "exit" hooks: terminal restore + sentinel disarm
    });
    process.on("unhandledRejection", (reason: unknown) => {
      recorder.recordFatal({
        class: "crash.unhandled_rejection",
        severity: "critical",
        component: "cli",
        where: "process#unhandledRejection",
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
      console.error(reason);
      process.exit(1);
    });

    // Deliver last run's queued reports + this run's dirty-exit crash + today's
    // heartbeat. Fire-and-forget with an internal timeout — the session never
    // waits on it, and a failure just leaves the durable queue for next launch.
    if (telemetryReporter) void telemetryReporter.flush().catch(() => {});
  }

  // ─── Headless: one prompt in, an answer and an exit code out ───
  // Placed before the TUI branch because it must never touch the alternate
  // screen: stdout is the answer, and a benchmark harness or a shell pipeline
  // reads it verbatim. Progress goes to stderr so `gear -P "..." > out.txt`
  // captures the answer alone.
  if (typeof values.print === "string") {
    const { runHeadless, headlessExitCode, headlessEnvelope } = await import("../headless");
    const result = await runHeadless(engine, sessionId, values.print as string, {
      autoApprove: values["auto-approve"] === true,
      onProgress: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(
      values.json === true ? `${headlessEnvelope(result)}\n` : `${result.text}\n`,
    );
    if (!result.ok && result.error) process.stderr.write(`${result.error}\n`);
    // Say WHY, once, when the run was blocked rather than incapable. Without
    // this the caller sees a refusal with no cause and scores the agent for
    // the harness's missing flag.
    if (result.permissionsDenied > 0) {
      process.stderr.write(
        `${result.permissionsDenied} permission request(s) denied — no approver in a headless run. ` +
          `Pass --auto-approve to grant them.\n`,
      );
    }
    engine.close();
    process.exit(headlessExitCode(result));
  }

  if (useTui) {
    await runTui({
      engine,
      sessionId,
      launchPick,
      workspaceRoot,
      version: GEAR_VERSION,
      yoloMode,
      trustWorkspace,
      customCommands,
      inline: surface.inline,
      quotaAutoResume: config.fallback?.autoResume !== false,
      heldStepPrompt: config.permissions?.autoMode?.heldStepPrompt !== false,
    });
    return;
  }

  // ─── Classic readline path: OSC terminal recolour (TUI handles its own bg) ───
  // Paint the terminal in the theme's bg/fg, and restore it on any exit so we never leave
  // the user's terminal recoloured after Gear quits.
  applyTerminalTheme();
  if (process.stdout.isTTY) {
    const restore = () => {
      try {
        process.stdout.write(TERMINAL_THEME_RESET);
      } catch {
        /* nothing useful to do while exiting */
      }
    };
    process.on("exit", restore);
    process.on("SIGTERM", () => {
      restore();
      discardSessionIfEmpty(engine, sessionId);
      engine.close();
      process.exit(143);
    });
  }

  // ─── Welcome Screen ───
  const recentSessions = engine
    .listSessions()
    .filter((s) => s.id !== sessionId && isMeaningfulSession(s));

  const startingGear = modeInfo(engine.getPermissionMode());
  process.stdout.write(
    renderWelcome({
      model: engine.getModel(),
      provider: engine.getProvider(),
      sessionId,
      workspace: workspaceRoot,
      version: GEAR_VERSION,
      sandbox: sandboxEnabled,
      // The header states what the agent may do to this machine before the
      // first prompt, not after the first surprise.
      scope: startingGear.label,
      caution: startingGear.desc || undefined,
      recentSessions,
    }) + "\n",
  );

  // When launched with --resume / `gear resume`, replay the prior conversation so
  // the classic path also lands the user where they left off (the TUI seeds its
  // own viewport). A brand-new session has no history and prints nothing.
  if (engine.getTranscript(sessionId).length > 0) {
    const info = engine.getSessionInfo(sessionId);
    process.stdout.write(resumedBanner(info?.title, sessionId) + "\n");
    printSessionTranscript(engine, sessionId);
    process.stdout.write(`  ${faint("continue where you left off ↓")}\n\n`);
  }

  // Classic mode is a frozen NON-INTERACTIVE plain printer (pipes / CI /
  // one-shot). The stderr spinner is retired: two independently-buffered
  // streams sharing a terminal row was the documented "garbled composer"
  // failure, and in a pipe it was pure noise. The interactive product is
  // the Flow TUI; this null-object keeps the 30+ call sites inert.
  const spinner = {
    start: (_phase?: string) => {},
    stop: () => {},
    isRunning: () => false,
    addTokens: (_n?: number) => {},
    setActivity: (_a?: string) => {},
    setTool: (_t?: string) => {},
  };

  // ─── Paste Interception ───
  // Intercept stdin BEFORE readline to prevent echo flood on large pastes.
  // readline echoes every line as it processes — by the time 'line' events fire,
  // 1000+ lines are already printed. This catches paste at the data level.

  const PASTE_LINE_THRESHOLD = 5;
  let pasteCount = 0;
  let pasteAccum = "";
  let pasteFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let turnAborted = false; // Ctrl-C mid-turn: close the record as "interrupted"
  let activeLoopId: string | null = null;
  let loopPoll: ReturnType<typeof setInterval> | null = null;
  const filesEdited = new Set<string>(); // session-wide, shown on the footer readout
  let interactiveTipShown = false; // the /interactive offer fires at most once per session

  const _origStdinEmit = process.stdin.emit;
  process.stdin.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    if (event === "data" && !busy) {
      const chunk = args[0];
      const data =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf-8")
            : String(chunk);
      const lines = data.split(/\r?\n|\r/);

      if (lines.length > PASTE_LINE_THRESHOLD) {
        // Large paste detected — swallow the data so readline never echoes it
        pasteAccum += data;
        if (pasteFlushTimer) clearTimeout(pasteFlushTimer);
        pasteFlushTimer = setTimeout(() => {
          const content = pasteAccum;
          pasteAccum = "";
          pasteCount++;
          const lineCount = content.split(/\r?\n|\r/).filter((l) => l.length > 0).length;
          process.stdout.write(
            `  ${info("\u203A")} ${faint(`[pasted #${pasteCount} \u00B7 +${lineCount} lines]`)}\n`,
          );
          const raw = content.trim();
          if (raw) {
            handleInput(raw).catch((err) => {
              console.error(vermillion(`\n  Error: ${err instanceof Error ? err.message : err}\n`));
              busy = false;
              showPrompt();
            });
          }
        }, 50);
        return true; // consumed — readline never sees it
      }
    }
    return (_origStdinEmit as Function).apply(process.stdin, [event, ...args]);
  } as typeof process.stdin.emit;

  // ─── Prompt ───

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptString(),
  });

  // ─── Permission Handler ───
  // The prompt must be UNMISSABLE. Default = ALLOW (Enter proceeds, 'n' denies).

  const permissionHandler: PermissionHandler = async (prompt) => {
    const preview = await buildPermissionPreview({
      toolName: prompt.toolName,
      argsSummary: prompt.argsSummary,
      rawArgs: prompt.rawArgs,
      workspaceRoot,
      safety: prompt.safety,
      exactSessionGrant: prompt.exactSessionGrant,
    });
    return new Promise<UserPermissionDecision>((resolve) => {
      const wasSpinning = spinner.isRunning?.() ?? false;
      spinner.stop();

      const card = renderPermissionCard(
        prompt.toolName,
        prompt.argsSummary,
        process.stdout.columns || 80,
        {
          preview,
          selected: 0,
          maxPreviewLines: 7,
          hints: ["enter", "2 / s", "3 / n"],
        },
      );
      process.stdout.write(card.lines.join("\n") + "\n");

      rl.question(`  ${info("\u203a")} `, (answer) => {
        const a = answer.trim().toLowerCase();
        let decision: UserPermissionDecision;
        if (a === "3" || a === "n" || a === "no" || a === "d" || a === "deny") {
          decision = { kind: "deny" };
        } else if (a === "2" || a === "s" || a === "a" || a === "session") {
          decision = { kind: "allow_session" };
        } else {
          // Default (Enter / 1 / y / yes / anything) = allow once.
          decision = { kind: "allow_once" };
        }

        if (decision.kind === "deny") {
          process.stdout.write(`  ${muted("◇ declined · no action taken")}\n`);
        } else if (decision.kind === "allow_session") {
          process.stdout.write(`  ${ok("\u2713 approved for session")}\n`);
        } else {
          process.stdout.write(`  ${ok("\u2713 approved once")}\n`);
        }

        if (wasSpinning) spinner.start("tool_call");
        resolve(decision);
      });
    });
  };

  // Register in every mode. The broker short-circuits in 4th gear, so the
  // handler is simply never called there — but stays wired so cycling back to confirm/auto
  // (Shift+Tab, /mode, /autonomy) restores prompts without re-registration.
  engine.setPermissionHandler(permissionHandler);

  // ─── Question Handler (ask_user tool) ───
  // Numbered options; a bare number picks one, anything else is a free-text
  // answer, Enter alone takes the first option. Wired only on a real TTY:
  // piped/CI runs leave it absent so ask_user degrades to its instructive
  // error instead of parking the run on a readline nobody will answer.

  if (process.stdin.isTTY) {
    engine.setQuestionHandler(
      (q) =>
        new Promise<string>((resolve) => {
          const wasSpinning = spinner.isRunning?.() ?? false;
          spinner.stop();

          // `2 of 4`, so a batched round reads as a round and not as four
          // unrelated interruptions. See UserQuestion.index in ask-user.ts.
          const round =
            q.total && q.total > 1 ? `  ${faint(`${(q.index ?? 0) + 1} of ${q.total}`)}` : "";
          process.stdout.write("\n");
          process.stdout.write(`  ${info("?")} ${bold(text(q.question))}${round}\n`);
          q.options.forEach((opt, i) => {
            process.stdout.write(`    ${info(String(i + 1))} ${text(opt)}\n`);
          });
          // A free-form question (no salvageable options) has no numbers to
          // offer and no default for a bare Enter to mean.
          process.stdout.write(
            `  ${muted(
              q.options.length > 0
                ? "number to choose · or type an answer · Enter = 1"
                : "type an answer in your own words",
            )}\n`,
          );

          rl.question(`  ${info("›")} `, (answer) => {
            const a = answer.trim();
            let result: string;
            const n = Number.parseInt(a, 10);
            if (!a) {
              result = q.options[0] ?? "(no answer -- proceed with your best judgment)";
            } else if (!Number.isNaN(n) && n >= 1 && n <= q.options.length && String(n) === a) {
              result = q.options[n - 1];
            } else {
              result = a; // free-text answer
            }
            process.stdout.write(`  ${ok("✓")} ${muted(truncate(result, 80))}\n`);
            if (wasSpinning) spinner.start("tool_call");
            resolve(result);
          });
        }),
    );
  }

  // ─── Slash Command Definitions ───

  const SLASH_CMDS: [string, string][] = [
    ["/theme", "Switch accent colors and light/dark mode"],
    ["/model", "Choose model/provider"],
    ["/sessions", "Browse, resume, rename, archive, or delete sessions"],
    ["/mode", "Shift gears — 1st · 2nd · 3rd · 4th · auto"],
    ["/diff", "Inspect staged and uncommitted workspace changes"],
    ["/loop", "Repeat a prompt while this session stays open"],
    ["/loops", "List and manage this session's loops"],
    ["/resume", "Resume a session — /resume <n|id>"],
    ["/rename", "Rename the current session"],
    ["/status", "Session status"],
    ["/providers", "List providers"],
    ["/keys", "Manage API keys"],
    ["/mcp", "List MCP servers"],
    ["/team", "Other Gear instances in this repo — status · send · claim"],
    ["/skills", "Browse & search skills"],
    ["/research", "Research — propose a plan, then a cited report"],
    ["/deepresearch", "Deep research — multi-round, long-form"],
    ["/cost", "Session cost"],
    ["/compress", "Summarize & shrink context"],
    ["/undo", "Revert the last Gear auto-commit ([git] autoCommit)"],
    ["/interactive", "Live dashboard from the last report (auto on|off · open)"],
    ["/memory", "System memory — your evergreen profile (update/add/edit/cadence)"],
    ["/notebook", "Learned tactics active for this workspace"],
    ["/bug", "Flag a problem — records the flight trail to the black box"],
    ["/gear", "Shift gears — /gear 1 | 2 | 3 | 4 | auto (empty shifts up)"],
    ["/sandbox", "OS sandbox for commands — on | off (off = full access)"],
    ["/browser", "Agent web browser — on | off (Playwright, headless)"],
    ["/rewind", "Roll back the conversation"],
    ["/help", "Show all commands"],
    ["/quit", "Exit Gear"],
  ];

  function commandReferenceRows(commands: [string, string][]): string[] {
    const nameWidth = Math.max(...commands.map(([name]) => name.length)) + 2;
    if ((process.stdout.columns || 80) < 64) {
      return commands.flatMap(([name, description]) => [
        `    ${info(name)}`,
        `      ${muted(description)}`,
      ]);
    }
    return commands.map(
      ([name, description]) => `    ${info(name.padEnd(nameWidth))}${muted(description)}`,
    );
  }

  function showPrompt() {
    let contextPercent: number | undefined;
    try {
      contextPercent = engine.getContextUsage().percent;
    } catch {
      contextPercent = undefined;
    }
    const loop = engine.getLoopStatus(sessionId);
    process.stdout.write(
      "\n" +
        statusLine({
          model: engine.getModel(),
          workspace: workspaceRoot,
          mode: engine.getPermissionMode(),
          contextPercent,
          filesEdited: filesEdited.size || undefined,
          theme: getTheme().name === "auto" ? "auto" : getTheme().appearance,
          loop:
            loop.count > 0 && loop.nextRunAt !== null
              ? `${loop.count === 1 ? "loop" : `${loop.count} loops`} · ${formatLoopDue(loop.nextRunAt)}`
              : undefined,
        }) +
        "\n" +
        composerRule() +
        "\n",
    );
    rl.prompt();
  }

  function printLoopTasks(): void {
    const tasks = engine.listLoopTasks(sessionId);
    if (tasks.length === 0) {
      process.stdout.write(
        `  ${muted("No loops are active in this session.")} ${faint("Try /loop 5m check CI")}\n\n`,
      );
      return;
    }
    process.stdout.write(`  ${bold(text(`Loops — ${tasks.length} active`))}\n`);
    for (const task of tasks) {
      const cadence =
        task.cadence === "fixed"
          ? `every ${formatLoopInterval(task.intervalMs)}`
          : `adaptive ${formatLoopInterval(task.intervalMs)}`;
      process.stdout.write(
        `    ${warn("↻")} ${info(task.id)} ${text(cadence)} ${faint(`· ${formatLoopDue(task.nextRunAt)} · ${loopPromptPreview(task.prompt, 54)}`)}\n`,
      );
    }
    process.stdout.write(
      `  ${faint("/loop cancel <id> · /loop clear · Esc stops the newest loop")}\n\n`,
    );
  }

  function handleLoopSlash(commandName: "loop" | "loops", arg: string): void {
    const tokens = arg.split(/\s+/).filter(Boolean);
    const operation = (tokens[0] ?? "").toLowerCase();
    if (
      (commandName === "loops" && !arg) ||
      operation === "list" ||
      operation === "ls" ||
      operation === "status"
    ) {
      printLoopTasks();
      return;
    }
    if (["cancel", "stop", "off", "delete", "rm"].includes(operation)) {
      const result = engine.cancelLoopTask(sessionId, tokens[1]);
      process.stdout.write(
        result.ok && result.task
          ? `  ${vermillion("✕")} ${muted("stopped loop")} ${info(result.task.id)} ${faint(loopPromptPreview(result.task.prompt, 58))}\n\n`
          : `  ${vermillion("✕")} ${muted(result.error ?? "Could not stop that loop.")}\n\n`,
      );
      return;
    }
    if (["clear", "cancel-all", "stop-all"].includes(operation)) {
      const count = engine.clearLoopTasks(sessionId);
      process.stdout.write(
        count > 0
          ? `  ${vermillion("✕")} ${muted(`stopped ${count} ${count === 1 ? "loop" : "loops"}`)}\n\n`
          : `  ${muted("No loops are active in this session.")}\n\n`,
      );
      return;
    }
    if (operation === "help") {
      process.stdout.write(
        [
          `  ${bold(text("Loop mode"))}`,
          `    ${info("/loop 5m check the deploy")} ${faint("fixed interval")}`,
          `    ${info("/loop check CI and review comments")} ${faint("adaptive 1–60m cadence")}`,
          `    ${info("/loop")} ${faint("built-in maintenance prompt, or .gear/loop.md")}`,
          `    ${info("/loops")} ${faint("list active tasks")}`,
          `    ${info("/loop cancel <id>")} ${faint("stop one · /loop clear stops all")}`,
          "",
        ].join("\n"),
      );
      return;
    }

    try {
      const result = engine.scheduleLoop(sessionId, arg);
      const task = result.task;
      const cadence =
        task.cadence === "fixed"
          ? `every ${formatLoopInterval(task.intervalMs)}`
          : `adaptive · first check ${formatLoopDue(task.nextRunAt)}`;
      process.stdout.write(
        `  ${ok("✓")} ${text("loop scheduled")} ${info(task.id)} ${faint(`· ${cadence} · expires in 7d`)}\n` +
          `    ${faint("└")} ${muted(loopPromptPreview(task.prompt, Math.max(36, (process.stdout.columns || 80) - 10)))}\n`,
      );
      if (result.promptPath) process.stdout.write(`    ${faint(`prompt: ${result.promptPath}`)}\n`);
      for (const warning of result.warnings) {
        process.stdout.write(`    ${warn("•")} ${muted(warning)}\n`);
      }
      process.stdout.write("\n");
    } catch (error) {
      process.stdout.write(
        `  ${vermillion("✕")} ${muted(error instanceof Error ? error.message : String(error))}\n\n`,
      );
    }
  }

  function cancelNewestLoop(): boolean {
    const cancelled = engine.cancelLoopTask(sessionId);
    if (!cancelled.ok || !cancelled.task) return false;
    process.stdout.write(
      `\r\x1b[2K  ${vermillion("✕")} ${muted("stopped loop")} ${info(cancelled.task.id)} ${faint(loopPromptPreview(cancelled.task.prompt, 56))}\n`,
    );
    return true;
  }

  function renderLoopCompletion(task: LoopTask, completion: LoopCompletion): string {
    if (completion.state === "rescheduled" && completion.task) {
      return `  ${warn("↻")} ${muted(`loop ${task.id} next ${formatLoopDue(completion.task.nextRunAt)}`)} ${faint(`· ${completion.reason}`)}\n`;
    }
    if (completion.state === "stopped") {
      return `  ${ok("✓")} ${muted(`loop ${task.id} complete`)} ${faint(`· ${completion.reason}`)}\n`;
    }
    if (completion.state === "expired") {
      return `  ${muted(`loop ${task.id} expired`)} ${faint(`· ${completion.reason}`)}\n`;
    }
    return `  ${muted(`loop ${task.id} stopped`)}\n`;
  }

  async function runDueLoopTask(): Promise<void> {
    if (busy || activeLoopId || rl.line.trim() || pasteBuffer.length > 0 || pasteTimer) return;
    const task = engine.claimDueLoopTask(sessionId);
    if (!task) return;
    try {
      await handleInput(task.prompt, task);
    } catch (error) {
      try {
        if (engine.getActiveLoopTask(sessionId)?.id === task.id) {
          engine.completeLoopTask(sessionId, task.id, { toolErrors: 1 });
        }
      } catch {
        /* the original failure is the actionable one */
      }
      busy = false;
      activeLoopId = null;
      process.stdout.write(
        `\n  ${vermillion("✕")} ${muted(`loop failed: ${error instanceof Error ? error.message : String(error)}`)}\n`,
      );
      showPrompt();
    }
  }

  /**
   * Switch the permission mode and re-render the prompt (Shift+Tab / /autonomy / /mode).
   * The buffer the user is mid-typing is preserved across the reprint.
   */
  function cycleMode(target?: ReturnType<typeof engine.getPermissionMode>) {
    let next: ReturnType<typeof engine.getPermissionMode>;
    if (target) {
      const res = engine.setPermissionMode(target);
      if (!res.ok && res.reason) process.stdout.write(`\r\x1b[2K${res.reason}\n`);
      next = engine.getPermissionMode(); // the actual mode, not the wish
    } else {
      next = engine.cyclePermissionMode();
    }
    const buf = rl.line;
    process.stdout.write("\r\x1b[2K"); // clear the current input line
    process.stdout.write(permissionModeBanner(next) + "\n");
    showPrompt();
    if (buf) rl.write(buf); // restore whatever was being typed
  }

  // Best-effort Shift+Tab (back-tab) in the readline path: readline decodes it to
  // { name: "tab", shift: true } once keypress events are enabled. Terminals that
  // swallow it can fall back to /mode or /autonomy.
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on(
      "keypress",
      (_str: string, key: { name?: string; shift?: boolean } | undefined) => {
        if (!busy && key?.name === "tab" && key.shift) {
          cycleMode();
        } else if (!busy && key?.name === "escape" && !rl.line) {
          if (cancelNewestLoop()) showPrompt();
        }
      },
    );
  }

  // ─── Line Handler ───
  // Small inputs (< PASTE_LINE_THRESHOLD) come through readline normally.
  // Large pastes are intercepted at stdin level above and never reach here.

  let pasteBuffer: string[] = [];
  let pasteTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── System Memory: discoverability hint + background "dream" ───
  {
    const mem = engine.getSystemMemory();
    if (mem.enabled && !mem.content.trim() && mem.scheduleLabel === "manual") {
      process.stdout.write(
        `  ${faint("tip: Gear can learn your style over time —")} ${info("/memory")}\n`,
      );
    }
    // Auto-refresh in the background when the chosen cadence is due. Non-blocking;
    // prints a subtle notice on completion. Skips silently with no provider /
    // nothing new / when the cadence is manual.
    void engine
      .maybeReflectSystemMemory()
      .then((r) => {
        if (r.updated && !busy) {
          process.stdout.write(
            `\n  ${green("✦")} ${faint(`system memory refreshed (~${r.tokensAfter ?? 0} tokens) · /memory to view`)}\n`,
          );
          showPrompt();
        }
      })
      .catch(() => {});
  }

  showPrompt();
  loopPoll = setInterval(() => {
    void runDueLoopTask().catch((error) => {
      busy = false;
      activeLoopId = null;
      process.stdout.write(
        `\n  ${vermillion("✕")} ${muted(`loop failed: ${error instanceof Error ? error.message : String(error)}`)}\n`,
      );
      showPrompt();
    });
  }, 1_000);

  rl.on("line", (line: string) => {
    if (busy) return;

    pasteBuffer.push(line);
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
      const lines = [...pasteBuffer];
      pasteBuffer = [];
      pasteTimer = null;

      const raw = lines.join("\n").trim();
      if (!raw) {
        showPrompt();
        return;
      }

      handleInput(raw).catch((err) => {
        console.error(vermillion(`\n  Error: ${err instanceof Error ? err.message : err}\n`));
        busy = false;
        showPrompt();
      });
    }, 50);
  });

  async function handleInput(input: string, scheduledLoop?: LoopTask) {
    if (!input) {
      showPrompt();
      return;
    }

    process.stdout.write("\n");

    const scheduledDisplayPrompt = input;
    // A scheduled custom/plugin slash command re-runs its prompt template. Built-in
    // control commands are intentionally delivered as plain text instead of being
    // allowed to recursively reconfigure the terminal from a timer.
    if (scheduledLoop && input.startsWith("/") && !input.startsWith("/ ")) {
      const [name, ...args] = input.slice(1).split(" ");
      const custom = findCommand(customCommands, name);
      if (custom) input = custom.render(args.join(" "));
    }

    // ─── Slash Commands ───

    if (!scheduledLoop) {
      if (input === "/") {
        // Bare slash — show all available commands
        process.stdout.write(`  ${bold(text("Commands"))}\n\n`);
        process.stdout.write(commandReferenceRows(SLASH_CMDS).join("\n") + "\n");
        if (customCommands.length) {
          process.stdout.write(`\n  ${bold(text("Custom"))}\n\n`);
          process.stdout.write(
            commandReferenceRows(
              customCommands.map((command) => [
                "/" + command.name,
                command.description ?? "Custom command",
              ]),
            ).join("\n") + "\n",
          );
        }
        process.stdout.write("\n");
        showPrompt();
        return;
      }

      if (input === "/quit" || input === "/exit") {
        console.log(dim("  Goodbye.\n"));
        discardSessionIfEmpty(engine, sessionId);
        engine.close();
        process.exit(0);
      }

      if (input === "/help") {
        process.stdout.write(`  ${bold(text("Commands"))}\n\n`);
        process.stdout.write(commandReferenceRows(SLASH_CMDS).join("\n") + "\n");
        process.stdout.write("\n");
        showPrompt();
        return;
      }

      if (input === "/cost") {
        // Same readout as the TUI — one formatter, so the two front ends can
        // never drift into reporting different numbers for the same session.
        const rows = formatCostReport(engine.getCostBreakdown());
        const width = Math.max(...rows.map((r) => r.label.length));
        for (const row of rows) {
          const note = row.note ? dim(` (${row.note})`) : "";
          console.log(`  ${dim(row.label.padStart(width))}  ${row.value}${note}`);
        }
        console.log("");
        showPrompt();
        return;
      }

      if (input === "/diff") {
        process.stdout.write(renderWorkspaceDiff(workspaceRoot) + "\n\n");
        showPrompt();
        return;
      }

      if (
        input === "/loop" ||
        input.startsWith("/loop ") ||
        input === "/loops" ||
        input.startsWith("/loops ")
      ) {
        const commandName = input === "/loops" || input.startsWith("/loops ") ? "loops" : "loop";
        const arg = input.slice(commandName.length + 1).trim();
        handleLoopSlash(commandName, arg);
        showPrompt();
        return;
      }

      if (input === "/status") {
        const status = engine.getStatus(sessionId);
        process.stdout.write(
          "\n" +
            renderStatus({
              model: status.model,
              provider: status.provider,
              workspace: status.workspace,
              sessionId,
              cost: status.cost,
              costSummary: status.costSummary,
              yoloMode: status.yoloMode,
              trustWorkspace: status.trustWorkspace,
              permissionMode: status.permissionMode,
              sandboxEnabled: status.sandboxEnabled,
              sandboxDegraded: status.sandboxDegraded,
              orgPolicy: status.orgPolicy,
              autoMode: status.autoMode,
              registeredProviders: status.registeredProviders,
              version: GEAR_VERSION,
            }) +
            "\n\n",
        );
        if (status.mcp.servers > 0) {
          process.stdout.write(
            `  ${muted("MCP")}  ${text(`${status.mcp.servers} server(s), ${status.mcp.tools} tools`)}\n\n`,
          );
        }
        if (status.skills > 0) {
          process.stdout.write(
            `  ${muted("Skills")}  ${text(`${status.skills} loaded`)} ${faint("(/skills to browse)")}\n\n`,
          );
        }
        if (status.team.enabled && status.team.peerCount > 0) {
          process.stdout.write(
            `  ${muted("Team")}  ${text(`${status.team.peerCount} other instance(s) in this repo`)} ${faint("(/team)")}\n\n`,
          );
        }
        showPrompt();
        return;
      }

      if (input === "/team" || input.startsWith("/team ")) {
        const lines = runTeamCommand(engine.getTeamBus(), input.slice("/team".length).trim());
        process.stdout.write(
          "\n" + lines.map((l, i) => `  ${i === 0 ? text(l) : muted(l)}`).join("\n") + "\n\n",
        );
        showPrompt();
        return;
      }

      if (input === "/mcp") {
        const servers = await engine.listMcpServers();
        process.stdout.write(`  ${bold(text("MCP Servers"))}\n\n`);
        if (servers.length === 0) {
          process.stdout.write(
            `    ${muted("None configured. Add servers in ")}${info(".gear/mcp.json")}${muted(".")}\n\n`,
          );
        } else {
          for (const s of servers) {
            const dot =
              s.health === "healthy" ? ok("●") : s.health === "degraded" ? warn("●") : faint("○");
            const proto = s.protocolVersion ? muted(` · MCP ${s.protocolVersion}`) : "";
            process.stdout.write(
              `    ${dot} ${text(s.name)} ${muted(`(${s.kind}, ${s.toolCount} tools)`)}${proto}\n`,
            );
            if (s.tools.length) {
              process.stdout.write(`      ${faint(s.tools.join(", "))}\n`);
            }
            if (s.lastError) {
              process.stdout.write(`      ${warn("⚠")} ${faint(s.lastError)}\n`);
            }
          }
          process.stdout.write("\n");
        }
        showPrompt();
        return;
      }

      if (input === "/skills" || input.startsWith("/skills ")) {
        const query = input.slice("/skills".length).trim();
        if (query) {
          const hits = await engine.searchSkills(query);
          process.stdout.write(`  ${bold(text("Skills"))} ${muted(`matching “${query}”`)}\n\n`);
          if (hits.length === 0) {
            process.stdout.write(`    ${muted("No matches.")}\n\n`);
          } else {
            for (const h of hits) {
              process.stdout.write(`    ${info(h.id)}\n`);
              if (h.description) process.stdout.write(`      ${faint(h.description)}\n`);
            }
            process.stdout.write("\n");
          }
          showPrompt();
          return;
        }
        const { total, plugins } = await engine.listSkills();
        process.stdout.write(
          `  ${bold(text("Skills"))} ${muted(`(${total} across ${plugins.length} domains)`)}\n\n`,
        );
        if (total === 0) {
          process.stdout.write(
            `    ${muted("None found. Add skills under ")}${info("skills/")}${muted(" or ")}${info(".gear/skills/")}${muted(".")}\n\n`,
          );
        } else {
          for (const p of plugins) {
            const names = p.skills.map((s) => s.name).join(", ");
            process.stdout.write(
              `    ${ok("●")} ${text(p.plugin)} ${muted(`(${p.skills.length})`)}\n`,
            );
            process.stdout.write(`      ${faint(names)}\n`);
          }
          process.stdout.write(
            `\n  ${muted("The agent loads a skill automatically when your request matches it.")}\n`,
          );
          process.stdout.write(
            `  ${muted("Search with ")}${info("/skills <keywords>")}${muted(".")}\n\n`,
          );
        }
        showPrompt();
        return;
      }

      if (input === "/providers" || input.startsWith("/providers ")) {
        const parts = input.slice("/providers".length).trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "").toLowerCase();

        // `/providers on|off <id>` toggles a provider — the canonical place to do it.
        if ((sub === "on" || sub === "off") && parts[1]) {
          const id = parts[1].toLowerCase();
          if (!getPreset(id) && id !== CUSTOM_PROVIDER_ID) {
            process.stdout.write(
              `  ${warn("Unknown provider")} ${info(id)}${muted(" · try ")}${faint(PROVIDER_PRESETS.map((p) => p.id).join(", "))}\n\n`,
            );
            showPrompt();
            return;
          }
          const disabled = sub === "off";
          persistDisabled(id, disabled);
          const res = engine.setProviderDisabled(id, disabled, sessionId);
          process.stdout.write(
            `  ${green("✓")} ${info(id)} ${muted(disabled ? "disabled" : "enabled")}\n`,
          );
          if (res.switchedTo) {
            process.stdout.write(
              `  ${brass("→")} ${muted("active provider was off — now on")} ${info(`${res.switchedTo.provider}/${res.switchedTo.model}`)}\n`,
            );
          }
          process.stdout.write("\n");
          showPrompt();
          return;
        }

        // Data-driven listing: every configured provider, its key state, on/off, active.
        const rows = engine.getProviderStatus();
        process.stdout.write(
          `  ${bold(text("Providers"))}  ${faint("· ")}${ok("●")}${faint(" active  ")}${info("●")}${faint(" ready  ")}${faint("○ no key/off")}\n\n`,
        );
        for (const r of rows) {
          const dot = r.disabled
            ? faint("○")
            : r.active
              ? ok("●")
              : r.hasKey
                ? info("●")
                : faint("○");
          const name = (r.active ? ok : r.hasKey && !r.disabled ? text : faint)(r.id.padEnd(13));
          const keyState =
            r.source === "none"
              ? faint("no key".padEnd(10))
              : muted((r.source === "saved" ? "key" : r.source).padEnd(10));
          const state = r.disabled
            ? warn("off")
            : r.active
              ? ok("active")
              : r.hasKey
                ? muted("ready")
                : faint("—");
          process.stdout.write(`    ${dot} ${name} ${keyState} ${state}\n`);
        }
        process.stdout.write(
          `\n  ${muted("Toggle ")}${info("/providers on|off <id>")}${muted(" · keys ")}${info("/keys")}${muted(" · switch ")}${info("/model")}\n\n`,
        );
        showPrompt();
        return;
      }

      if (input === "/theme" || input.startsWith("/theme ")) {
        const themes = listThemes();
        const arg = input.slice("/theme".length).trim().toLowerCase();
        if (arg) {
          // Legacy palette names still migrate onto Flow; the active choices
          // are the six foreground roles or terminal-native mode.
          const labelMatch = themes.find((t) => t.label.toLowerCase() === arg);
          const applied = setTheme(arg) || (labelMatch ? setTheme(labelMatch.name) : false);
          if (applied) {
            saveTheme(getTheme().name);
            applyTerminalTheme();
            process.stdout.write(
              `  ${green(glyph("verified"))} theme set to ${brass(getTheme().label)}\n\n`,
            );
          } else {
            process.stdout.write(`  ${vermillion(glyph("failure"))} unknown theme: ${arg}\n\n`);
          }
          showPrompt();
          return;
        }
        const current = getTheme().name;
        process.stdout.write(`  ${bold(text("Color modes"))}\n\n`);
        themes.forEach((t, i) => {
          const isCurrent = t.name === current;
          const marker = isCurrent ? ` ${info(`${glyph("selection")} current`)}` : "";
          const description = t.name === "auto" ? "host terminal" : "six ANSI16 foreground roles";
          process.stdout.write(
            `    ${warn(`[${String(i + 1).padStart(2)}]`)} ${(isCurrent ? text : muted)(t.label.padEnd(18))} ${swatch(t.name)}  ${faint(description)}${marker}\n`,
          );
        });
        process.stdout.write("\n");
        rl.question(`  ${info(glyph("selection"))} `, (answer) => {
          const a = answer.trim().toLowerCase();
          const pick =
            themes.find((_, i) => String(i + 1) === a) ??
            themes.find((t) => t.name === a || t.label.toLowerCase() === a);
          if (pick) {
            setTheme(pick.name);
            saveTheme(pick.name);
            applyTerminalTheme();
            process.stdout.write(
              `  ${green(glyph("verified"))} theme set to ${brass(getTheme().label)}\n\n`,
            );
          } else {
            process.stdout.write(`  ${dim("no change")}\n\n`);
          }
          showPrompt();
        });
        return;
      }

      if (input === "/keys" || input.startsWith("/keys ")) {
        const parts = input.slice("/keys".length).trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "").toLowerCase();

        const printTable = () => {
          process.stdout.write(
            `  ${bold(text("API keys"))} ${faint("· saved to ~/.gear/secrets.json, applied live")}\n` +
              `  ${faint("· OAuth & OS-keychain storage:")} ${info("gear login <provider>")} ${faint("· status:")} ${info("gear providers")}\n\n`,
          );
          for (const r of engine.getProviderStatus()) {
            const hasKey = r.hasKey;
            const dot = r.disabled
              ? faint("○")
              : r.active
                ? ok("●")
                : hasKey
                  ? info("●")
                  : faint("○");
            const name = (r.active ? ok : hasKey ? text : faint)(r.id.padEnd(12));
            // Local runtimes show their base URL instead of a (non-existent) key.
            const valCol = r.local
              ? faint((r.endpoint || "—").padEnd(26))
              : r.source === "none"
                ? faint("not set".padEnd(26))
                : text((r.masked || "set").padEnd(26));
            const src = r.disabled
              ? warn("off")
              : r.local
                ? faint("local")
                : r.source === "none"
                  ? faint("—")
                  : faint(r.source);
            process.stdout.write(`    ${dot} ${name} ${valCol} ${src}\n`);
          }
          process.stdout.write(
            `\n  ${muted("Set ")}${info("/keys set <provider> <key>")}${muted(" · ")}${info("/keys clear <provider>")}${muted(" · ")}${info("/keys off|on <provider>")}\n`,
          );
          process.stdout.write(
            `  ${muted("Local ")}${info("/keys url <ollama|lmstudio> <baseUrl>")}${muted(" · no key needed")}\n`,
          );
          process.stdout.write(
            `  ${muted("Custom ")}${info("/keys custom <baseUrl> <model> <key>")}${muted(" · providers: ")}${faint(PROVIDER_PRESETS.map((p) => p.id).join(", "))}\n\n`,
          );

          // Web-search backends (used by /research). Not LLM providers — keys live
          // in the same secrets file and feed the web_search tool via the env.
          process.stdout.write(
            `  ${bold(text("Search backends"))} ${faint("· power /research; keyless DuckDuckGo is the fallback")}\n\n`,
          );
          for (const r of searchKeyStatus()) {
            const has = r.source !== "none";
            const dot = has ? info("●") : faint("○");
            const name = (has ? text : faint)(r.id.padEnd(12));
            const keyCol = has ? text((r.masked || "set").padEnd(14)) : faint("not set".padEnd(14));
            const src = has ? faint(r.source) : faint("— DuckDuckGo");
            process.stdout.write(`    ${dot} ${name} ${keyCol} ${src}\n`);
          }
          process.stdout.write(
            `\n  ${muted("Set ")}${info("/keys set tavily <key>")}${muted(" · ")}${info("/keys set brave <key>")}${muted(" · ")}${info("/keys clear <id>")}\n\n`,
          );
        };

        if (!sub) {
          printTable();
          showPrompt();
          return;
        }
        if (sub === "set" && parts.length >= 3) {
          const id = parts[1].toLowerCase();
          if (SEARCH_KEY_PRESETS.some((p) => p.id === id)) {
            persistKey(id, parts.slice(2).join(" "));
            applySearchKeysToEnv();
            process.stdout.write(
              `  ${ok("✓")} ${muted("saved search key for")} ${info(id)} ${faint("· used by /research")}\n`,
            );
            showPrompt();
            return;
          }
          if (!getPreset(id)) {
            process.stdout.write(
              `  ${warn("Unknown provider")} ${info(id)}${muted(" · try ")}${faint(PROVIDER_PRESETS.map((p) => p.id).join(", "))}\n`,
            );
            showPrompt();
            return;
          }
          const key = parts.slice(2).join(" ");
          persistKey(id, key);
          engine.setProviderKey(id, key);
          process.stdout.write(
            `  ${ok("✓")} ${muted("saved key for")} ${info(id)} ${faint("· /model to switch")}\n`,
          );
          showPrompt();
          return;
        }
        if (sub === "clear" && parts[1]) {
          const id = parts[1].toLowerCase();
          const sk = SEARCH_KEY_PRESETS.find((p) => p.id === id);
          if (sk) {
            persistClearKey(id);
            delete process.env[sk.envVar];
            if (sk.altEnvVar) delete process.env[sk.altEnvVar];
            process.stdout.write(`  ${ok("✓")} ${muted("cleared search key")} ${info(id)}\n`);
            showPrompt();
            return;
          }
          let res: ReturnType<typeof engine.setProviderKey>;
          if (id === CUSTOM_PROVIDER_ID) {
            persistClearCustom();
            res = engine.setCustomEndpoint(null, sessionId);
          } else {
            persistClearKey(id);
            res = engine.setProviderKey(id, null, sessionId);
          }
          process.stdout.write(`  ${ok("✓")} ${muted("cleared")} ${info(id)}\n`);
          if (res.switchedTo) {
            process.stdout.write(
              `  ${brass("→")} ${muted("active provider lost its key — now on")} ${info(`${res.switchedTo.provider}/${res.switchedTo.model}`)}\n`,
            );
          }
          showPrompt();
          return;
        }
        if ((sub === "off" || sub === "on") && parts[1]) {
          const id = parts[1].toLowerCase();
          const disabled = sub === "off";
          persistDisabled(id, disabled);
          const res = engine.setProviderDisabled(id, disabled, sessionId);
          process.stdout.write(
            `  ${ok("✓")} ${info(id)} ${muted(disabled ? "disabled" : "enabled")}\n`,
          );
          if (res.switchedTo) {
            process.stdout.write(
              `  ${brass("→")} ${muted("active provider was off — now on")} ${info(`${res.switchedTo.provider}/${res.switchedTo.model}`)}\n`,
            );
          }
          showPrompt();
          return;
        }
        if (sub === "custom" && parts.length >= 4) {
          const ep = { baseUrl: parts[1], model: parts[2], key: parts.slice(3).join(" ") };
          persistCustom(ep);
          engine.setCustomEndpoint(ep);
          process.stdout.write(
            `  ${ok("✓")} ${muted("saved custom endpoint")} ${faint(ep.baseUrl)} ${faint(`· /model custom/${ep.model}`)}\n`,
          );
          showPrompt();
          return;
        }
        // Local runtime base URL: `/keys url ollama http://host:11434` (no key).
        if (sub === "url" && parts[1]) {
          const id = parts[1].toLowerCase();
          const preset = getPreset(id);
          if (!preset?.local) {
            process.stdout.write(
              `  ${warn("Unknown local runtime")} ${info(id)}${muted(" · try ")}${faint("ollama, lmstudio")}\n`,
            );
            showPrompt();
            return;
          }
          const url = parts.slice(2).join(" ").trim();
          persistLocalEndpoint(id, url || undefined);
          engine.setLocalEndpoint(id, url || null);
          const shown = engine.getLocalEndpoint(id) ?? preset.baseUrl ?? "";
          process.stdout.write(
            `  ${ok("✓")} ${info(id)} ${muted(url ? "endpoint set to" : "reset to default")} ${faint(shown)} ${faint(`· /model ${id}/<model>`)}\n`,
          );
          showPrompt();
          return;
        }
        process.stdout.write(
          `  ${warn("Usage:")} ${info("/keys")}${muted(" · ")}${info("set <p> <key>")}${muted(" · ")}${info("clear <p>")}${muted(" · ")}${info("off|on <p>")}${muted(" · ")}${info("url <ollama|lmstudio> <baseUrl>")}${muted(" · ")}${info("custom <url> <model> <key>")}\n`,
        );
        showPrompt();
        return;
      }

      if (input === "/compress" || input.startsWith("/compress ")) {
        const instructions = input.slice("/compress".length).trim();
        busy = true;
        spinner.start("thinking");
        let result: Awaited<ReturnType<typeof engine.compactSession>>;
        try {
          result = await engine.compactSession(sessionId, instructions || undefined);
        } finally {
          spinner.stop();
          busy = false;
        }

        if (!result.compacted) {
          process.stdout.write(`  ${dim(`Nothing to compact — ${result.reason}.`)}\n\n`);
          showPrompt();
          return;
        }

        const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        const saved =
          result.sourceTokens > 0
            ? Math.max(0, Math.round((1 - result.summaryTokens / result.sourceTokens) * 100))
            : 0;

        process.stdout.write(
          `  ${green("✓")} ${text("Compacted conversation")} ${dim(`(${result.originalMessages} messages → summary)`)}\n`,
        );
        process.stdout.write(
          `  ${faint(`~${fmtTok(result.sourceTokens)} → ~${fmtTok(result.summaryTokens)} tokens · ${saved}% smaller · applies on the next turn`)}\n`,
        );
        if (instructions) {
          process.stdout.write(`  ${faint(`Focus: ${instructions}`)}\n`);
        }

        const preview = result.summary
          .split("\n")
          .map((l) => l.trimEnd())
          .filter(Boolean)
          .slice(0, 6);
        if (preview.length) {
          process.stdout.write("\n");
          for (const line of preview) {
            process.stdout.write(`  ${dim(line.slice(0, 100))}\n`);
          }
        }
        process.stdout.write("\n");
        showPrompt();
        return;
      }

      if (input === "/interactive" || input.startsWith("/interactive ")) {
        const arg = input.slice("/interactive".length).trim();
        const [sub = "", ...rest] = arg.split(/\s+/).filter(Boolean);
        if (sub === "auto") {
          const v = (rest[0] ?? "").toLowerCase();
          if (v === "on" || v === "off") {
            const on = v === "on";
            engine.setInteractiveAuto(on);
            saveInteractiveAuto(on);
            process.stdout.write(
              `  ${green("✓")} ${text(`autonomous dashboards ${on ? "on" : "off"}`)} ${faint(
                on
                  ? "— Gear builds one when an answer is data-heavy"
                  : "— dashboards only when you ask (/interactive)",
              )}\n\n`,
            );
          } else {
            process.stdout.write(
              `  ${text(`Autonomous dashboards: ${engine.isInteractiveAuto() ? "on" : "off"}`)}\n` +
                `  ${faint("Toggle: /interactive auto on|off")}\n\n`,
            );
          }
          showPrompt();
          return;
        }
        if (sub === "open") {
          const info = engine.openDashboard(rest[0]);
          process.stdout.write(
            info
              ? `  ${green("✓")} ${text(`opened "${info.title}"`)}\n  ${faint(info.url)}\n\n`
              : `  ${dim("No dashboard yet — run /interactive after a report, or ask for one.")}\n\n`,
          );
          showPrompt();
          return;
        }
        // Bare /interactive (or "/interactive view <focus>" / "/interactive <focus>")
        // becomes a normal turn: the model builds the dashboard with full context.
        const focus = sub === "view" ? rest.join(" ") : arg;
        input = buildInteractiveDirective(focus || undefined);
        // …falls through to the turn loop below.
      }

      if (input === "/undo") {
        const r = engine.undoLastAutoCommit();
        if (r.ok) {
          process.stdout.write(
            `  ${green("✓")} ${text(`Reverted ${r.undoneSha}`)} ${dim(`(${r.subject})`)}\n\n`,
          );
        } else {
          process.stdout.write(`  ${dim(`Cannot undo — ${r.reason}`)}\n`);
          if (!engine.isAutoCommitEnabled()) {
            process.stdout.write(
              `  ${faint("Tip: set [git] autoCommit = true in ~/.gear/config.toml so every run lands as a revertible commit.")}\n`,
            );
          }
          process.stdout.write("\n");
        }
        showPrompt();
        return;
      }

      if (input === "/notebook") {
        const entries = engine.getNotebookEntries(10);
        if (entries.length === 0) {
          process.stdout.write(
            `  ${dim("Notebook is empty for this workspace — Gear fills it as it verifies how your repos work.")}\n\n`,
          );
        } else {
          process.stdout.write(`\n  ${dim("§ NOTEBOOK — active for this workspace")}\n\n`);
          for (const e of entries) {
            process.stdout.write(
              `  ${cyanotype(e.id.slice(-8))} ${dim(`[${e.scope}]`)} ${text(e.body.slice(0, 90))}\n`,
            );
          }
          process.stdout.write(
            `\n  ${dim("manage: gear notebook [show <id>|rm <id>|export]")}\n\n`,
          );
        }
        showPrompt();
        return;
      }

      if (input === "/bug" || input.startsWith("/bug ")) {
        const note = input.slice("/bug".length).trim();
        const rec = engine.getRecorder();
        if (!rec) {
          process.stdout.write(
            `  ${dim("Diagnostics are disabled ([diagnostics] enabled = false) — nothing recorded.")}\n\n`,
          );
        } else {
          const id = rec.record({
            class: "ux.user_reported",
            severity: "warn",
            component: "cli",
            where: "slash#bug",
            message: note || "user flagged the last exchange (no note given)",
          });
          process.stdout.write(
            id
              ? `  ${green("✦")} ${text("Logged with the current flight trail.")} ${faint(`· gear incidents show ${id.slice(-8)}`)}\n\n`
              : `  ${dim("Could not record — see gear doctor.")}\n\n`,
          );
        }
        showPrompt();
        return;
      }

      if (input === "/memory" || input.startsWith("/memory ")) {
        const rest = input.slice("/memory".length).trim();
        const sub = (rest.split(/\s+/)[0] ?? "").toLowerCase();
        const arg = rest.slice(sub.length).trim();
        const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

        // ── update / refresh (the "dream") ──
        if (sub === "update" || sub === "refresh" || sub === "dream") {
          busy = true;
          spinner.start("thinking");
          let res: Awaited<ReturnType<typeof engine.reflectSystemMemory>>;
          try {
            res = await engine.reflectSystemMemory({ focus: arg || undefined, trigger: "manual" });
          } finally {
            spinner.stop();
            busy = false;
          }
          if (!res.updated) {
            process.stdout.write(`  ${dim(`Memory unchanged — ${res.reason}.`)}\n\n`);
            showPrompt();
            return;
          }
          process.stdout.write(
            `  ${green("✦")} ${text("System memory refreshed")} ${faint(`· ~${fmtTok(res.tokensBefore)} → ~${fmtTok(res.tokensAfter)} tokens`)}\n`,
          );
          const preview = (res.content ?? "")
            .split("\n")
            .map((l) => l.trimEnd())
            .filter(Boolean)
            .slice(0, 8);
          if (preview.length) {
            process.stdout.write("\n");
            for (const line of preview) process.stdout.write(`  ${dim(line.slice(0, 100))}\n`);
          }
          process.stdout.write("\n");
          showPrompt();
          return;
        }

        // ── add a manual note ──
        if (sub === "add" || sub === "note") {
          if (!arg) {
            process.stdout.write(`  ${dim("Usage: /memory add <note>")}\n\n`);
            showPrompt();
            return;
          }
          const res = engine.appendSystemMemoryNote(arg);
          process.stdout.write(
            `  ${green("✓")} ${text("noted")} ${faint(`· ~${fmtTok(res.tokens)} tokens total`)}\n\n`,
          );
          showPrompt();
          return;
        }

        // ── open the memory file in $EDITOR ──
        if (sub === "edit") {
          const path = getSystemMemoryPath();
          if (!engine.getSystemMemory().content.trim()) {
            engine.setSystemMemoryContent(
              "# About me\n- \n\n## How I like to work\n- \n\n## My codebases\n- \n\n## Notes\n",
            );
          }
          const editor = process.env.VISUAL || process.env.EDITOR || "nano";
          process.stdout.write(`  ${dim(`opening ${editor}…`)}\n`);
          rl.pause();
          try {
            const { spawnSync } = require("node:child_process");
            spawnSync(editor, [path], { stdio: "inherit" });
          } catch {
            /* editor unavailable — fall through and reload whatever's on disk */
          }
          rl.resume();
          try {
            const { readFileSync } = require("fs");
            const res = engine.setSystemMemoryContent(readFileSync(path, "utf-8"));
            process.stdout.write(
              `  ${green("✓")} ${text("memory saved")} ${faint(`· ~${fmtTok(res.tokens)} tokens`)}\n\n`,
            );
          } catch {
            process.stdout.write(`  ${dim("memory unchanged")}\n\n`);
          }
          showPrompt();
          return;
        }

        // ── clear ──
        if (sub === "clear" || sub === "reset" || sub === "forget") {
          engine.clearSystemMemory();
          process.stdout.write(`  ${green("✓")} ${text("system memory cleared")}\n\n`);
          showPrompt();
          return;
        }

        // ── set cadence (off | manual | daily | weekly | Nd | every N days) ──
        if (
          sub === "off" ||
          sub === "manual" ||
          sub === "daily" ||
          sub === "weekly" ||
          /^\d+\s*d/.test(rest) ||
          /^every\s+\d+/.test(rest)
        ) {
          const res = engine.setSystemMemorySchedule(rest);
          const verb = res.label === "manual" ? "manual (no auto-refresh)" : `auto · ${res.label}`;
          process.stdout.write(`  ${green("✓")} ${text("memory cadence:")} ${info(verb)}\n`);
          if (res.label !== "manual") {
            process.stdout.write(
              `  ${faint("Gear will refresh your profile in the background when it's due.")}\n`,
            );
          }
          process.stdout.write("\n");
          showPrompt();
          return;
        }

        // ── default: status + show the profile ──
        const mem = engine.getSystemMemory();
        process.stdout.write(
          `  ${bold(text("System memory"))}${mem.enabled ? "" : ` ${faint("(disabled)")}`}\n`,
        );
        const last = mem.meta.updatedAt ? relTime(mem.meta.updatedAt) : "never";
        const dreamt = mem.meta.lastReflectedAt ? relTime(mem.meta.lastReflectedAt) : "never";
        process.stdout.write(
          `  ${faint(`cadence: ${mem.scheduleLabel} · ~${fmtTok(mem.tokens)}/${fmtTok(mem.maxTokens)} tokens · updated ${last} · dreamed ${dreamt}`)}\n\n`,
        );
        if (!mem.content.trim()) {
          process.stdout.write(`  ${dim("Empty — Gear hasn't built your profile yet.")}\n`);
          process.stdout.write(
            `  ${dim("Seed it with ")}${info("/memory update")}${dim(", jot a note with ")}${info("/memory add <…>")}${dim(",")}\n`,
          );
          process.stdout.write(
            `  ${dim("or enable auto-updates with ")}${info("/memory weekly")}${dim(" (or daily / 3d).")}\n\n`,
          );
        } else {
          for (const line of mem.content.split("\n")) process.stdout.write(`  ${text(line)}\n`);
          process.stdout.write(
            `\n  ${faint("update: /memory update · note: /memory add <…> · edit: /memory edit · cadence: /memory daily|3d|weekly|manual")}\n\n`,
          );
        }
        showPrompt();
        return;
      }

      if (input === "/model") {
        // ── The model tree: providers → accounts/endpoints → models ──
        // Level 1 shows only configured providers; level 2 the real access paths
        // for the chosen one (skipped when there's just one); level 3 the models
        // under that account — live-listed for local runtimes. A number switches
        // this session; `d<n>` also sets the startup default (model.json).
        const ask = (q: string): Promise<string> =>
          new Promise((res) => rl.question(q, (a) => res(a.trim())));

        const applySwitch = (prov: string, model: string, asDefault: boolean) => {
          engine.switchModel(model, prov as any, sessionId);
          const now = `${engine.getProvider()}/${engine.getModel()}`;
          if (asDefault) {
            saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
            process.stdout.write(
              `  ${accent("◆")} default set — ${info(now)} ${dim("(used at startup)")}\n\n`,
            );
          } else {
            process.stdout.write(
              `  ${green("✓")} switched to ${info(now)} ${dim("· session only — d<n> in /model sets the default")}\n\n`,
            );
          }
        };

        void (async () => {
          try {
            const statusRows = engine.getProviderStatus();
            const customEp = engine.getCustomEndpoint();
            const current = { provider: engine.getProvider() as string, model: engine.getModel() };
            const def = loadLastModel();

            // ── Level 1: providers ──
            const provs = providerChoices(statusRows, customEp, process.env, getPreset);
            process.stdout.write(`  ${bold(text("Model"))}\n`);
            process.stdout.write(treeHeadline(current, def).join("\n") + "\n\n");
            if (provs.length === 0) {
              process.stdout.write(
                `  ${dim("No providers configured yet — add a key with")} ${info("/keys")}${dim(", or type one below.")}\n`,
              );
            }
            provs.forEach((p, i) => process.stdout.write(formatProviderLine(i + 1, p) + "\n"));
            process.stdout.write(`    ${warn("[t]")} ${faint("type provider/model directly")}\n\n`);
            process.stdout.write(
              `  ${faint("subscriptions (Claude Pro/Max · ChatGPT · Copilot):")} ${info("gear login")}\n`,
            );

            const a1 = (await ask(`  ${info("›")} `)).toLowerCase();
            if (a1 === "t" || a1 === "c") {
              const prov = await ask(`  ${dim("provider")} ${info("›")} `);
              const mod = await ask(`  ${dim("model")}    ${info("›")} `);
              if (prov && mod) applySwitch(prov, mod, false);
              else process.stdout.write(`  ${dim("no change")}\n\n`);
              return;
            }
            const chosen = provs[Number(a1) - 1];
            if (!a1 || !chosen) {
              if (a1) process.stdout.write(`  ${dim("no change")}\n\n`);
              return;
            }

            const row = statusRows.find((r) => r.id === chosen.id)!;
            const preset = getPreset(chosen.id);
            const accounts = accountChoices(preset, row, customEp, process.env);

            // ── Level 2: accounts / endpoints (skipped when only one path) ──
            let account = accounts[0];
            if (accounts.length > 1) {
              process.stdout.write(`\n  ${bold(text(`Model · ${chosen.label}`))}\n\n`);
              accounts.forEach((ac, i) =>
                process.stdout.write(formatAccountLine(i + 1, ac) + "\n"),
              );
              process.stdout.write(`    ${warn("[b]")} ${faint("back")}\n\n`);
              const a2 = (await ask(`  ${info("›")} `)).toLowerCase();
              if (a2 === "b" || !a2) return;
              account = accounts[Number(a2) - 1];
              if (!account) {
                process.stdout.write(`  ${dim("no change")}\n\n`);
                return;
              }
              // Picking a pooled key makes it the ACTIVE key — persisted and
              // applied to the live gateway, same as the /keys manager.
              if (account.kind === "key" && account.entryId && !account.active) {
                const file = persistSetActiveKey(chosen.id, account.entryId);
                engine.setProviderKeys(
                  chosen.id,
                  providerKeyEntries(file, chosen.id),
                  file.activeKeyId?.[chosen.id],
                  sessionId,
                );
                process.stdout.write(
                  `  ${green("✓")} ${dim("active key now")} ${text(account.label)} ${dim(account.detail)}\n`,
                );
              }
              // Honest wire note: selecting a path that BYOP outranks.
              if (row.source === "oauth" || row.source === "keychain") {
                if (account.kind === "key" || account.kind === "env") {
                  process.stdout.write(
                    `  ${dim(`note: the signed-in ${row.source} credential wins on the wire —`)} ${info(`gear logout ${chosen.id}`)} ${dim("to use API keys")}\n`,
                  );
                }
              } else if (account.kind === "env" && accounts.some((x) => x.kind === "key")) {
                process.stdout.write(
                  `  ${dim("note: the saved key wins on the wire —")} ${info(`/keys clear ${chosen.id}`)} ${dim("to use the env key")}\n`,
                );
              }
            }

            // ── Level 3: models under that account ──
            let live: string[] | null = null;
            if (preset && (chosen.local || account?.kind === "endpoint")) {
              live = await fetchLiveModels(preset.kind, row.endpoint ?? preset.baseUrl ?? "");
            }
            const models = modelChoices(preset, chosen.id, {
              live,
              custom: customEp,
              current,
              def,
            });

            const crumb =
              accounts.length > 1 && account
                ? `Model · ${chosen.label} · ${account.label.replace("API key · ", "key ")}`
                : `Model · ${chosen.label}`;
            process.stdout.write(`\n  ${bold(text(crumb))}\n`);
            if (chosen.local && !live) {
              process.stdout.write(
                `  ${dim(`endpoint ${row.endpoint ?? ""} not reachable — showing suggestions`)}\n`,
              );
            }
            process.stdout.write("\n");
            models.forEach((m, i) => process.stdout.write(formatModelLine(i + 1, m) + "\n"));
            process.stdout.write(`    ${warn("[m]")} ${faint("type a model id")}\n\n`);
            process.stdout.write(
              `  ${faint("number = use now · d<number> = set as default · b = back")}\n`,
            );

            const a3 = (await ask(`  ${info("›")} `)).toLowerCase();
            if (a3 === "b" || !a3) return;
            if (a3 === "m") {
              const mod = await ask(`  ${dim("model id")} ${info("›")} `);
              if (mod) applySwitch(chosen.id, mod, false);
              else process.stdout.write(`  ${dim("no change")}\n\n`);
              return;
            }
            const asDefault = a3.startsWith("d");
            const pick = models[Number(asDefault ? a3.slice(1) : a3) - 1];
            if (!pick) {
              process.stdout.write(`  ${dim("no change")}\n\n`);
              return;
            }
            applySwitch(chosen.id, pick.id, asDefault);
          } finally {
            showPrompt();
          }
        })();
        return;
      }

      if (input.startsWith("/model ")) {
        // Quick switches: `/model provider/model` (session only) and
        // `/model default [provider/model]` (persist the startup default).
        const arg = input.slice(7).trim();

        if (arg === "default" || arg.startsWith("default ")) {
          const rest = arg.slice("default".length).trim();
          if (!rest) {
            const def = loadLastModel();
            process.stdout.write(
              def
                ? `  ${accent("◆")} default: ${info(`${def.provider}/${def.model}`)} ${dim("· change: /model default <provider>/<model>")}\n\n`
                : `  ${dim("no default set — /model default <provider>/<model>, or d<n> in /model")}\n\n`,
            );
            showPrompt();
            return;
          }
          const si = rest.indexOf("/");
          const prov = si > 0 ? rest.slice(0, si) : engine.getProvider();
          const mod = si > 0 ? rest.slice(si + 1) : rest;
          engine.switchModel(mod, prov as any, sessionId);
          saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
          process.stdout.write(
            `  ${accent("◆")} default set — ${info(`${engine.getProvider()}/${engine.getModel()}`)} ${dim("(used at startup)")}\n\n`,
          );
          showPrompt();
          return;
        }

        const slashIdx = arg.indexOf("/");
        if (slashIdx > 0) {
          engine.switchModel(arg.slice(slashIdx + 1), arg.slice(0, slashIdx) as any, sessionId);
        } else {
          // Treat as model name with current provider
          engine.switchModel(arg, undefined, sessionId);
        }
        process.stdout.write(
          `  ${green("✓")} switched to ${info(`${engine.getProvider()}/${engine.getModel()}`)} ${dim("· session only — /model default to persist")}\n\n`,
        );
        showPrompt();
        return;
      }

      if (input === "/gear" || input.startsWith("/gear ")) {
        const raw = input.slice("/gear".length).trim();
        const target = configModeToPermissionMode(raw || undefined);
        if (raw && !target) {
          process.stdout.write(
            `  ${warn("Usage:")} ${info("/gear")} ${dim("[1|2|3|4|auto] — empty shifts up")}\n`,
          );
        } else if (!target) {
          process.stdout.write(permissionModeBanner(engine.cyclePermissionMode()) + "\n");
        } else {
          const res = engine.setPermissionMode(target);
          if (!res.ok && res.reason) process.stdout.write(`${res.reason}\n`);
          process.stdout.write(permissionModeBanner(engine.getPermissionMode()) + "\n");
        }
        showPrompt();
        return;
      }

      if (input === "/autonomy" || input.startsWith("/autonomy ")) {
        // Legacy alias: /autonomy I|II|III → 2nd|3rd|4th gear.
        const raw = input.slice("/autonomy".length).trim();
        const target = configModeToPermissionMode(raw ? `autonomy-${raw}` : undefined);
        if (!target) {
          process.stdout.write(
            `  ${warn("Usage:")} ${info("/autonomy")} ${dim("[I|II|III] — or use /gear 1|2|3|4|auto")}\n`,
          );
        } else {
          const res = engine.setPermissionMode(target);
          if (!res.ok && res.reason) process.stdout.write(`${res.reason}\n`);
          process.stdout.write(permissionModeBanner(engine.getPermissionMode()) + "\n");
        }
        showPrompt();
        return;
      }

      if (input === "/hands-free" || input === "/turing") {
        // Hidden compatibility aliases: toggle 4th gear.
        const target = engine.getPermissionMode() === "gear-4" ? "gear-1" : "gear-4";
        const res = engine.setPermissionMode(target);
        if (!res.ok && res.reason) process.stdout.write(`${res.reason}\n`);
        process.stdout.write(permissionModeBanner(engine.getPermissionMode()) + "\n");
        showPrompt();
        return;
      }

      if (input === "/sandbox" || input.startsWith("/sandbox ")) {
        const raw = input.slice("/sandbox".length).trim().toLowerCase();
        if (raw === "on" || raw === "off") {
          const enabled = raw === "on";
          engine.setSandboxEnabled(enabled);
          saveSandboxState(enabled); // sticks across sessions, like /theme
          process.stdout.write(sandboxModeBanner(enabled) + "\n");
        } else if (raw) {
          process.stdout.write(
            `  ${warn("Usage:")} ${info("/sandbox")} ${dim("[on|off] — empty shows the current state")}\n`,
          );
        } else {
          process.stdout.write(sandboxModeBanner(engine.isSandboxEnabled()) + "\n");
        }
        showPrompt();
        return;
      }

      if (input === "/browser" || input.startsWith("/browser ")) {
        const raw = input.slice("/browser".length).trim().toLowerCase();
        if (raw === "on" || raw === "off") {
          const enabled = raw === "on";
          await engine.setBrowserEnabled(enabled); // restarts MCP discovery when needed
          saveBrowserState(enabled); // sticks across sessions, like /sandbox
          process.stdout.write(browserModeBanner(enabled) + "\n");
        } else if (raw) {
          process.stdout.write(
            `  ${warn("Usage:")} ${info("/browser")} ${dim("[on|off] — empty shows the current state")}\n`,
          );
        } else {
          process.stdout.write(browserModeBanner(engine.isBrowserEnabled()) + "\n");
        }
        showPrompt();
        return;
      }

      if (input === "/mode" || input.startsWith("/mode ")) {
        const raw = input.slice("/mode".length).trim().toLowerCase();
        const mode = configModeToPermissionMode(raw);
        if (mode) {
          const res = engine.setPermissionMode(mode);
          if (!res.ok && res.reason) process.stdout.write(`  ${res.reason}\n`);
          process.stdout.write(permissionModeBanner(engine.getPermissionMode()) + "\n");
        } else if (raw) {
          process.stdout.write(
            `  ${warn("Usage:")} ${info("/mode")} ${dim("[1|2|3|4|auto] — empty shifts up (same as /gear)")}\n`,
          );
        } else {
          process.stdout.write(permissionModeBanner(engine.cyclePermissionMode()) + "\n");
        }
        showPrompt();
        return;
      }

      if (input === "/sessions" || input.startsWith("/sessions ")) {
        const sub = input.slice("/sessions".length).trim().toLowerCase();
        const all = sub === "archived" || sub === "all" || sub === "--all";
        const list = engine
          .listSessions(all ? { status: "all" } : undefined)
          .filter(isMeaningfulSession);
        process.stdout.write(
          `\n  ${bold(text("Sessions"))}${all ? faint("  · incl. archived") : ""}\n\n`,
        );
        if (list.length === 0) {
          process.stdout.write(`  ${dim("None yet — start chatting.")}\n\n`);
          showPrompt();
          return;
        }
        list.slice(0, 30).forEach((s, i) => {
          const cur = s.id === sessionId ? ok("●") : faint("○");
          const title = s.title?.trim() || "untitled";
          const tag = s.status !== "active" ? ` ${brass(`[${s.status}]`)}` : "";
          process.stdout.write(
            `    ${brass(String(i + 1).padStart(2))} ${cur} ${text(title)}${tag}\n` +
              `        ${faint(`${cyanotype(s.id.slice(0, 8))} · ${relTime(s.updatedAt)} · ${s.eventCount} events · ${s.model}`)}\n`,
          );
        });
        process.stdout.write(
          `\n  ${faint("resume")} ${info("/resume <n|id>")}  ${faint("rename")} ${info("/rename <title>")}  ${faint("archive")} ${info("/archive <n|id>")}  ${faint("delete")} ${info("/delete <n|id>")}\n\n`,
        );
        showPrompt();
        return;
      }

      if (input === "/resume" || input.startsWith("/resume ")) {
        const arg = input.slice("/resume".length).trim();
        if (!arg) {
          process.stdout.write(
            `  ${warn("Usage:")} ${info("/resume <n|id>")} ${faint("— see")} ${info("/sessions")}\n\n`,
          );
          showPrompt();
          return;
        }
        const target = resolveSessionArg(engine, arg);
        if (!target) {
          process.stdout.write(`  ${vermillion("✕")} no session matches ${text(arg)}\n\n`);
          showPrompt();
          return;
        }
        if (target.id === sessionId) {
          process.stdout.write(`  ${dim("Already in that session.")}\n\n`);
          showPrompt();
          return;
        }
        const previous = sessionId;
        const res = engine.resumeSession(target.id);
        sessionId = target.id;
        discardSessionIfEmpty(engine, previous);
        process.stdout.write("\n" + resumedBanner(target.title, target.id) + "\n");
        printSessionTranscript(engine, sessionId);
        if (res?.switched) {
          process.stdout.write(
            `  ${green("✓")} ${dim("model")} ${info(`${engine.getProvider()}/${engine.getModel()}`)}\n`,
          );
        }
        process.stdout.write("\n");
        showPrompt();
        return;
      }

      if (input === "/rename" || input.startsWith("/rename ")) {
        const title = input.slice("/rename".length).trim();
        if (!title) {
          process.stdout.write(`  ${warn("Usage:")} ${info("/rename <title>")}\n\n`);
          showPrompt();
          return;
        }
        engine.renameSession(sessionId, title);
        process.stdout.write(`  ${green("✓")} renamed session to ${text(title)}\n\n`);
        showPrompt();
        return;
      }

      if (input === "/archive" || input.startsWith("/archive ")) {
        const arg = input.slice("/archive".length).trim();
        const target = arg ? resolveSessionArg(engine, arg) : engine.getSessionInfo(sessionId);
        if (!target) {
          process.stdout.write(`  ${vermillion("✕")} no session matches ${text(arg)}\n\n`);
          showPrompt();
          return;
        }
        engine.archiveSession(target.id);
        process.stdout.write(
          `  ${green("✓")} archived ${text(target.title?.trim() || "untitled")}\n`,
        );
        if (target.id === sessionId) {
          sessionId = engine.createSession();
          process.stdout.write(`  ${dim("started a new session")}\n`);
        }
        process.stdout.write("\n");
        showPrompt();
        return;
      }

      if (input === "/delete" || input.startsWith("/delete ")) {
        const arg = input.slice("/delete".length).trim();
        const target = arg ? resolveSessionArg(engine, arg) : engine.getSessionInfo(sessionId);
        if (!target) {
          process.stdout.write(`  ${vermillion("✕")} no session matches ${text(arg)}\n\n`);
          showPrompt();
          return;
        }
        engine.deleteSession(target.id);
        process.stdout.write(
          `  ${green("✓")} deleted ${text(target.title?.trim() || "untitled")} ${dim("· recoverable until purged")}\n`,
        );
        if (target.id === sessionId) {
          sessionId = engine.createSession();
          process.stdout.write(`  ${dim("started a new session")}\n`);
        }
        process.stdout.write("\n");
        showPrompt();
        return;
      }

      if (input === "/rewind" || input.startsWith("/rewind ")) {
        const turns = engine.listUserTurns(sessionId);
        const arg = input.slice("/rewind".length).trim();
        if (turns.length === 0) {
          process.stdout.write(`  ${dim("Nothing to rewind — no messages yet.")}\n\n`);
          showPrompt();
          return;
        }
        if (!arg) {
          process.stdout.write(`  ${bold(text("Rewind"))}\n`);
          process.stdout.write(
            `  ${faint("Roll back to a turn — removes it and everything after.")}\n\n`,
          );
          turns.forEach((t, i) => {
            const preview = t.text.replace(/\s+/g, " ").slice(0, 60);
            process.stdout.write(`    ${warn(String(i + 1).padStart(2))}  ${muted(preview)}\n`);
          });
          process.stdout.write(`\n  ${faint("Run")} ${info("/rewind <n>")}\n\n`);
          showPrompt();
          return;
        }
        const n = parseInt(arg, 10);
        if (isNaN(n) || n < 1 || n > turns.length) {
          process.stdout.write(
            `  ${vermillion("✕")} invalid turn — use ${brass("/rewind")} to list.\n\n`,
          );
          showPrompt();
          return;
        }
        const removed = engine.rewindTo(sessionId, turns[n - 1].seq - 1);
        process.stdout.write(
          `  ${green("✓")} rewound to turn ${n} ${dim(`(removed ${removed} event${removed === 1 ? "" : "s"})`)}\n`,
        );
        process.stdout.write(`  ${dim("Note: rewinds the conversation, not files on disk.")}\n\n`);
        showPrompt();
        return;
      }

      const isDeepResearch = input === "/deepresearch" || input.startsWith("/deepresearch ");
      if (isDeepResearch || input === "/research" || input.startsWith("/research ")) {
        const cmd = isDeepResearch ? "/deepresearch" : "/research";
        const query0 = input.slice(cmd.length).trim();
        // /deepresearch forces the heavy preset; /research uses the configured default.
        const researchOpts = isDeepResearch ? ({ depth: "deep" } as const) : undefined;
        if (!query0) {
          const verb = isDeepResearch
            ? "deep, multi-round research"
            : "research with a cited report";
          process.stdout.write(
            `  ${warn("Usage:")} ${info(`${cmd} <question>`)} ${faint(`— ${verb}`)}\n\n`,
          );
          showPrompt();
          return;
        }

        busy = true;
        const ask = (q: string): Promise<string> =>
          new Promise((res) => rl.question(q, (a) => res(a)));

        try {
          let question = query0;

          // ── Phase 1: propose (asking clarifying questions if ambiguous) ──
          spinner.start("thinking");
          let proposal = await engine.proposeResearch(sessionId, question, researchOpts);
          spinner.stop();

          if (isClarification(proposal)) {
            process.stdout.write("\n" + renderClarifyingQuestions(proposal) + "\n\n");
            const answers = await ask(`  ${info("›")} ${faint("answer, or Enter to skip: ")}`);
            if (answers.trim()) question = `${question}\n\nClarifications: ${answers.trim()}`;
            spinner.start("thinking");
            proposal = await engine.proposeResearch(sessionId, question, {
              ...researchOpts,
              allowClarification: false,
            });
            spinner.stop();
          }

          let plan: ResearchPlan | null = isClarification(proposal) ? null : proposal;

          // ── Phase 2: approval gate (run / revise / cancel) ──
          let approved = false;
          while (plan) {
            process.stdout.write("\n" + renderResearchPlan(plan) + "\n\n");
            process.stdout.write(
              `  ${ok("Enter")} ${faint("run")}   ${warn("r")} ${faint("revise")}   ${accent("n")} ${faint("cancel")}\n`,
            );
            const a = (await ask(`  ${info("›")} `)).trim().toLowerCase();
            if (a === "n" || a === "no" || a === "c" || a === "cancel") {
              process.stdout.write(`  ${dim("research cancelled")}\n\n`);
              break;
            }
            if (a === "r" || a === "revise") {
              const fb = await ask(`  ${info("›")} ${faint("what should change? ")}`);
              if (fb.trim()) {
                spinner.start("thinking");
                const revised = await engine.reviseResearch(sessionId, plan, fb.trim());
                spinner.stop();
                if (!isClarification(revised)) plan = revised;
              }
              continue;
            }
            approved = true;
            break;
          }

          // ── Phase 3: execute (fan out + stream the cited report) ──
          if (approved && plan) {
            process.stdout.write(composerRule() + "\n\n");
            spinner.start("executing");
            let streaming = false;
            let report: ResearchReport | null = null;

            for await (const ev of engine.runResearch(sessionId, plan, researchOpts)) {
              if (ev.type === "research_report_delta") {
                if (!streaming) {
                  spinner.stop();
                  process.stdout.write("\n");
                  streaming = true;
                }
                process.stdout.write(ev.text);
                continue;
              }
              if (ev.type === "research_complete") report = ev.report;
              if (ev.type === "error") {
                spinner.stop();
                if (streaming) {
                  process.stdout.write("\n");
                  streaming = false;
                }
                process.stdout.write(`\n  ${vermillion(glyph("failure"))} ${text(ev.error)}\n`);
                continue;
              }
              const block = formatResearchEvent(ev);
              if (block) {
                spinner.stop();
                if (streaming) {
                  process.stdout.write("\n");
                  streaming = false;
                }
                process.stdout.write(block + "\n");
                if (ev.type !== "research_complete") spinner.start("executing");
              }
            }
            spinner.stop();
            process.stdout.write("\n");

            // Save the report to disk unless disabled in config.
            if (report && config.research?.save !== false) {
              try {
                const { writeFileSync, mkdirSync } = require("fs");
                const { join } = require("path");
                const dir =
                  config.research?.outputDir || workspaceConfigPath(workspaceRoot, "research");
                mkdirSync(dir, { recursive: true });
                const slug =
                  question
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "")
                    .slice(0, 50) || "research";
                const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
                const body = `# Research: ${plan.question}\n\n_Generated by Gear · ${new Date().toISOString()}_\n\n${report.markdown}\n`;
                writeFileSync(file, body);
                const shown = file.startsWith(workspaceRoot)
                  ? file.slice(workspaceRoot.length).replace(/^[/\\]/, "")
                  : file;
                process.stdout.write(`  ${faint("saved to")} ${info(shown)}\n\n`);
              } catch (err) {
                process.stdout.write(
                  `  ${warn("could not save report:")} ${faint(err instanceof Error ? err.message : String(err))}\n\n`,
                );
              }
            }
          }
        } catch (err) {
          spinner.stop();
          process.stdout.write(
            `  ${vermillion("✕")} ${text(err instanceof Error ? err.message : String(err))}\n\n`,
          );
        } finally {
          busy = false;
        }
        showPrompt();
        return;
      }

      // Custom slash commands from .gear/commands/*.md — render, then run as a prompt.
      if (input.startsWith("/") && !input.startsWith("/ ")) {
        const parts = input.slice(1).split(" ");
        const custom = findCommand(customCommands, parts[0]);
        if (custom) {
          input = custom.render(parts.slice(1).join(" "));
        }
      }

      // Catch unknown slash commands
      if (input.startsWith("/") && !input.startsWith("/ ")) {
        const cmd = input.split(" ")[0];
        process.stdout.write(
          `  ${vermillion("✕")} unknown command: ${cmd}. Type ${brass("/help")} for available commands.\n\n`,
        );
        showPrompt();
        return;
      }
    }

    busy = true;
    turnAborted = false;
    activeLoopId = scheduledLoop?.id ?? null;

    // Close the composer frame: a matching rule beneath the submitted input, then
    // the user's message set down as the loud block (same language as the TUI).
    process.stdout.write(composerRule() + "\n");
    if (scheduledLoop) {
      process.stdout.write(
        `  ${warn("↻")} ${bold(text("Loop"))} ${info(scheduledLoop.id)} ${faint(`· iteration ${scheduledLoop.runCount + 1} · ${scheduledLoop.cadence}`)}\n`,
      );
    }
    process.stdout.write(userBlock(scheduledLoop ? scheduledDisplayPrompt : input) + "\n\n");
    spinner.start("thinking");

    // Collapsed rendering (see ./ui/turn.ts): narration and the final answer
    // stay in the open; work is quiet on every surface. finish() sets down the
    // edit chips, the plan's final state, the record, the answer.
    const turn = new TurnRenderer(
      {
        commit: (block) => {
          const wasSpinning = spinner.isRunning();
          spinner.stop();
          process.stdout.write(block + "\n");
          if (wasSpinning) spinner.start("thinking");
        },
      },
      { model: engine.getModel(), getCost: () => engine.getCost() },
    );

    // Offer-a-dashboard bookkeeping: the answer text (for the data-density
    // heuristic) and whether the model already built/updated one this turn.
    let answerText = "";
    let dashboardTouched = false;
    let toolCalls = 0;
    let toolErrors = 0;
    let filesChanged = 0;
    let turnFailed = false;

    try {
      for await (const event of engine.chat(sessionId, input)) {
        turn.onEvent(event);
        if (event.type === "text_delta") answerText += event.text;
        if (event.type === "stream_reset") answerText = "";
        if (event.type === "tool_call_end") {
          toolCalls++;
          if (!event.output?.success) toolErrors++;
        }
        if (event.type === "tool_call_start") {
          if (!spinner.isRunning()) spinner.start("tool_call");
          spinner.setTool(event.toolName);
        }
        if (event.type === "verification_started") spinner.setActivity("verifying");
        // Real provider-reported download tokens on the spinner meta (v2 ladder).
        if (event.type === "usage" && event.outputTokens > 0) {
          spinner.addTokens(event.outputTokens);
        }
        if (event.type === "tool_call_end" && event.output?.toolName === "interactive_dashboard") {
          dashboardTouched = true;
        }
        if (
          event.type === "tool_call_end" &&
          event.output?.success &&
          (event.output.toolName === "edit_file" || event.output.toolName === "write_file") &&
          event.args?.path
        ) {
          filesEdited.add(String(event.args.path));
          filesChanged++;
        }
      }
    } catch (err) {
      spinner.stop();
      if (!turnAborted) {
        turnFailed = true;
        turn.onError(err);
      }
    }

    spinner.stop();
    turn.finish({ aborted: turnAborted });

    if (
      !turnAborted &&
      !dashboardTouched &&
      !interactiveTipShown &&
      !engine.isInteractiveAuto() &&
      shouldOfferInteractive(answerText)
    ) {
      interactiveTipShown = true;
      process.stdout.write(`  ${faint("✦ /interactive — view this as a live dashboard")}\n\n`);
    }

    if (scheduledLoop) {
      const completion = engine.completeLoopTask(sessionId, scheduledLoop.id, {
        responseText: answerText,
        toolCalls,
        toolErrors: toolErrors + (turnFailed ? 1 : 0),
        filesChanged,
        aborted: turnAborted,
      });
      process.stdout.write(renderLoopCompletion(scheduledLoop, completion));
    }

    busy = false;
    activeLoopId = null;
    showPrompt();
  }

  rl.on("close", () => {
    if (loopPoll) clearInterval(loopPoll);
    spinner.stop();
    console.log(dim("\n  Goodbye.\n"));
    discardSessionIfEmpty(engine, sessionId);
    engine.close();
    process.exit(0);
  });

  // ─── SIGINT: abort in-flight turn; exit when idle ───
  let sigintIdleCount = 0;
  process.on("SIGINT", () => {
    if (busy) {
      // Turn is in progress — cancel it without exiting
      turnAborted = true;
      if (activeLoopId) {
        const cancelled = engine.cancelLoopTask(sessionId, activeLoopId);
        if (cancelled.ok) {
          process.stdout.write(`\n  ${vermillion("✕")} ${dim(`loop ${activeLoopId} stopped`)}\n`);
        }
      }
      engine.abort();
      spinner.stop();
      process.stdout.write(`\n  ${vermillion("✕")} ${dim("aborted")}\n`);
      // busy will be reset to false once the chat loop drains
      sigintIdleCount = 0;
      return;
    }
    // Idle — first Ctrl-C clears the line, second exits
    sigintIdleCount++;
    if (sigintIdleCount === 1) {
      process.stdout.write(`\r${" ".repeat(80)}\r`); // clear input line
      process.stdout.write(`  ${dim("(Press Ctrl-C again to exit)")}\n`);
      showPrompt();
      // Reset after 2 s so a single stray Ctrl-C doesn't lock in "exit mode"
      setTimeout(() => {
        sigintIdleCount = 0;
      }, 2000);
    } else {
      console.log(dim("\n  Goodbye.\n"));
      discardSessionIfEmpty(engine, sessionId);
      engine.close();
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error(vermillion(`Fatal: ${err.message}`));
  process.exit(1);
});
