#!/usr/bin/env bun
import { Engine } from "../engine";
import type { PermissionHandler, UserPermissionDecision } from "../engine";
import {
  loadConfig,
  loadSecrets,
  setProviderKey as persistKey,
  clearProviderKey as persistClearKey,
  setCustomEndpoint as persistCustom,
  clearCustomEndpoint as persistClearCustom,
  setProviderDisabled as persistDisabled,
  getPreset,
  PROVIDER_PRESETS,
  CUSTOM_PROVIDER_ID,
  applySearchKeysToEnv,
  searchKeyStatus,
  SEARCH_KEY_PRESETS,
  loadLastModel,
  saveLastModel,
} from "@alan/shared";
import { parseArgs } from "util";
import * as readline from "readline";
import { Spinner } from "./spinner";
import { renderWelcome } from "./welcome";
import { renderToolCall } from "./ui/tool-call";
import { renderStatus } from "./ui/status";
import { promptString, statusLine, composerRule, permissionModeBanner } from "./ui/composer";
import { runTui } from "./ui/tui";
import { exportSession } from "../session-export";
import { loadCommands, findCommand } from "../commands";
import { isClarification } from "../research-types";
import type { ResearchPlan, ResearchReport } from "../research-types";
import {
  renderResearchPlan,
  renderClarifyingQuestions,
  formatResearchEvent,
} from "./ui/research";

// ─── CLI Argument Parsing ───

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    model: { type: "string", short: "m" },
    provider: { type: "string", short: "p" },
    workspace: { type: "string", short: "w" },
    yolo: { type: "boolean", default: false },
    trust: { type: "boolean", default: false },
    planner: { type: "boolean", default: false },
    "planner-model": { type: "string" },
    "executor-model": { type: "string" },
    resume: { type: "string", short: "r" },
    list: { type: "boolean", short: "l", default: false },
    format: { type: "string", default: "md" },
    sign: { type: "boolean", default: false },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
    tui: { type: "boolean", default: false },
    classic: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0] ?? "chat";

// ─── Top-level --help ───

if (values.help) {
  process.stdout.write(
    `\n  alan — AI coding agent\n\n` +
      `  Usage:\n` +
      `    alan [chat]                  Start an interactive chat session\n` +
      `    alan list                    List all stored sessions\n` +
      `    alan export <sessionId>      Export a session transcript\n\n` +
      `  Export options:\n` +
      `    --format md|json             Output format (default: md)\n` +
      `    --sign                       Sign the export with Ed25519\n` +
      `    --out <path>                 Write output to file instead of stdout\n\n` +
      `  Global options:\n` +
      `    -m, --model <model>          LLM model to use\n` +
      `    -p, --provider <provider>    LLM provider (anthropic|openai|openrouter|google|ollama-turbo)\n` +
      `    -w, --workspace <path>       Workspace root directory\n` +
      `    -r, --resume <sessionId>     Resume an existing session\n` +
      `    --yolo                       Start in Turing (bypass) mode — skip all permission prompts\n` +
      `    --trust                      Start in auto mode — approve in-workspace edits & bash (outside still prompts)\n` +
      `                                 (Shift+Tab cycles confirm → auto → Turing live; also /mode, /turing)\n` +
      `    --planner                    Enable planner+executor mode\n` +
      `    --classic                    Plain readline prompt (default is the pinned composer)\n` +
      `    --tui                        Force the Codex-style pinned composer\n` +
      `    -h, --help                   Show this help\n\n`,
  );
  process.exit(0);
}

type CliProvider = "anthropic" | "openai" | "openrouter" | "google" | "ollama-turbo";

const DEFAULT_MODELS: Record<CliProvider, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  openrouter: "qwen/qwen3-coder:free",
  google: "gemini-2.5-flash",
  "ollama-turbo": "qwen3-coder:480b",
};

function isCliProvider(provider: string): provider is CliProvider {
  return (
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "openrouter" ||
    provider === "google" ||
    provider === "ollama-turbo"
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
    case "ollama-turbo":
      // No dedicated config.llm section; fall back to DEFAULT_MODELS / --model.
      return undefined;
  }
}

// ─── Resolve Tool Binary ───

async function findToolsBinary(): Promise<string> {
  const envPath = process.env.ALAN_TOOLS_BIN;
  if (envPath) {
    const envFile = Bun.file(envPath);
    if (await envFile.exists()) return envPath;
  }

  const devPath = new URL("../../../../target/release/alan-tools", import.meta.url).pathname;
  const debugPath = new URL("../../../../target/debug/alan-tools", import.meta.url).pathname;

  const file1 = Bun.file(devPath);
  if (await file1.exists()) return devPath;
  const file2 = Bun.file(debugPath);
  if (await file2.exists()) return debugPath;

  return "alan-tools";
}

// ─── Ensure Data Directory ───

function ensureDataDir(): string {
  const dir = `${process.env.HOME}/.alan`;
  const fs = require("fs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
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
  getTheme,
  listThemes,
  swatch,
  terminalThemeSeq,
  TERMINAL_THEME_RESET,
} from "./colors";
import { loadSavedTheme, resolveInitialTheme, saveTheme } from "./ui/theme-store";

/** Recolour the whole terminal (fg+bg) to the active theme — only on a real TTY. */
function applyTerminalTheme(): void {
  if (process.stdout.isTTY) process.stdout.write(terminalThemeSeq());
}

// ─── Main ───

async function main() {
  const dataDir = ensureDataDir();
  const toolsBinary = await findToolsBinary();
  const workspaceRoot = (values.workspace as string | undefined) ?? process.cwd();

  const config = loadConfig(workspaceRoot);
  const secrets = loadSecrets();

  // Apply the persisted / configured color theme before anything renders.
  // Precedence: ALAN_THEME env > ~/.alan/theme.json (last /theme choice) > [ui].theme > default.
  setTheme(
    resolveInitialTheme({
      env: process.env.ALAN_THEME,
      saved: loadSavedTheme(),
      configured: config.ui?.theme,
    }),
  );
  // The TUI paints its own background edge-to-edge in the alternate screen, so OSC terminal
  // recolouring is applied only on the classic readline path (set up after the TUI branch).

  // ─── Smart Provider Detection ───
  // Priority: CLI arg > config > auto-detect from available API keys
  function detectBestProvider(): CliProvider {
    // Prefer providers with API keys, in order of free-tier friendliness
    const providerKeys: {
      provider: CliProvider;
      envVar: string;
      configKey: keyof typeof config.llm;
    }[] = [
      { provider: "google", envVar: "GOOGLE_API_KEY", configKey: "google" },
      { provider: "anthropic", envVar: "ANTHROPIC_API_KEY", configKey: "anthropic" },
      { provider: "openai", envVar: "OPENAI_API_KEY", configKey: "openai" },
      { provider: "openrouter", envVar: "OPENROUTER_API_KEY", configKey: "openrouter" },
    ];
    for (const { provider, envVar, configKey } of providerKeys) {
      const cfgSection = config.llm[configKey] as { apiKey?: string } | undefined;
      if (process.env[envVar] || cfgSection?.apiKey) return provider;
    }
    return "openrouter"; // last resort
  }

  const cliProvider = values.provider as string | undefined;
  const configProvider = config.llm.defaultProvider;

  // Does a provider have working credentials — an env var, an [llm.*].apiKey, or a /keys secret?
  // ollama-turbo carries no [llm.*] section (its key lives in secrets.json / OLLAMA_API_KEY).
  const providerEnvVar: Record<CliProvider, string> = {
    google: "GOOGLE_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "ollama-turbo": "OLLAMA_API_KEY",
  };
  const hasCreds = (p: CliProvider): boolean =>
    !!process.env[providerEnvVar[p]] ||
    !!(p !== "ollama-turbo" && (config.llm[p] as { apiKey?: string } | undefined)?.apiKey) ||
    !!secrets.keys[p];

  // The model the user last picked sticks across sessions: it wins over the config default (but not
  // over an explicit --model/--provider) as long as its provider still has credentials — otherwise
  // we fall through rather than boot a keyless provider. This is why a fresh session resumes e.g.
  // ollama-turbo/qwen3-coder:480b instead of resetting to the built-in google/gemini-2.5-flash.
  const lastUsed = !cliProvider && !values.model ? loadLastModel() : null;
  const sticky =
    lastUsed && isCliProvider(lastUsed.provider) && hasCreds(lastUsed.provider) ? lastUsed : null;

  let provider: CliProvider;
  let model: string;
  if (sticky) {
    provider = sticky.provider as CliProvider;
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

  const plannerMode = values.planner as boolean;
  // Workspace trust: --trust flag OR permissions.trustWorkspace in .alan/config.toml.
  const trustWorkspace = (values.trust as boolean) || (config.permissions?.trustWorkspace ?? false);
  // Make the [search].provider config visible to the env-based backend selector
  // used by the web_search tool (keys themselves already come from the env).
  if (
    config.search?.provider &&
    config.search.provider !== "auto" &&
    !process.env.ALAN_SEARCH_BACKEND
  ) {
    process.env.ALAN_SEARCH_BACKEND = config.search.provider;
  }
  // Copy saved Tavily/Brave keys into the env so the web_search backends (used
  // by /research) pick them up; keyless DuckDuckGo remains the fallback.
  applySearchKeysToEnv();
  const engine = new Engine({
    model,
    provider,
    workspaceRoot,
    dbPath: config.engine.dbPath,
    toolsBinaryPath: toolsBinary,
    yoloMode: values.yolo as boolean,
    trustWorkspace,
    plannerMode,
    routing: plannerMode
      ? {
          planner: (values["planner-model"] as string) ?? config.llm.planner?.model ?? model,
          executor: (values["executor-model"] as string) ?? config.llm.executor?.model ?? model,
          plannerProvider: config.llm.planner?.provider ?? provider,
          executorProvider: config.llm.executor?.provider ?? provider,
        }
      : undefined,
    // Pass config-file keys as "saved" — but NOT when they merely echo an env
    // var (loadConfig folds env into config.llm.*), so an env-only key is
    // reported as "env" by the gateway's env fallback instead of "saved".
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ? undefined : config.llm.anthropic?.apiKey,
    openaiApiKey: process.env.OPENAI_API_KEY ? undefined : config.llm.openai?.apiKey,
    openrouterApiKey: process.env.OPENROUTER_API_KEY ? undefined : config.llm.openrouter?.apiKey,
    googleApiKey: process.env.GOOGLE_API_KEY ? undefined : config.llm.google?.apiKey,
    // BYOK keys + custom endpoint + toggles from ~/.alan/secrets.json (win over config.toml).
    providerKeys: secrets.keys,
    customEndpoint: secrets.custom,
    disabledProviders: secrets.disabled,
    search: config.search,
    research: config.research,
  });

  // ─── DB-only commands — run before provider validation ───

  if (command === "list" || values.list) {
    const sessions = engine.listSessions();
    if (sessions.length === 0) {
      console.log(dim("  No sessions found."));
    } else {
      console.log(`\n  ${dim("§ SESSIONS")}\n`);
      for (const s of sessions) {
        console.log(
          `  ${cyanotype(s.id.slice(0, 8))}  ${s.workspaceRoot}  ${dim(`${s.eventCount} events`)}  ${dim(s.model)}`,
        );
      }
      console.log("");
    }
    engine.close();
    return;
  }

  if (command === "export") {
    const sessionId = positionals[1];
    if (!sessionId) {
      process.stderr.write(
        `  ${vermillion("✕")} Usage: alan export <sessionId> [--format md|json] [--sign] [--out <path>]\n`,
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
        `  ${dim("Or add apiKey to ~/.alan/config.toml")}\n\n`,
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

  // Create or resume session
  const sessionId = (values.resume as string) ?? engine.createSession();
  const customCommands = await loadCommands(workspaceRoot);

  // ─── Composer mode ───
  // The themed full-screen TUI — a live banner, a scrollable transcript window, and a
  // pinned composer, repainted in the active theme on the alternate screen — is the
  // default on interactive terminals. It owns the screen so it can paint the theme
  // background edge-to-edge (which Warp won't do via OSC), and brings its own scrollback:
  // mouse wheel or PageUp/PageDown. Piped/non-TTY stdin and `--classic` / ALAN_CLASSIC
  // fall back to the plain readline prompt (native terminal scrollback); `--tui` /
  // ALAN_TUI force the TUI even past `--classic`.
  const classicForced = (values.classic as boolean) || !!process.env.ALAN_CLASSIC;
  const tuiForced = (values.tui as boolean) || !!process.env.ALAN_TUI;
  const useTui = !!process.stdin.isTTY && (tuiForced || !classicForced);
  if (useTui) {
    await runTui({
      engine,
      sessionId,
      workspaceRoot,
      version: "0.1.0",
      yoloMode: values.yolo as boolean,
      trustWorkspace,
      customCommands,
    });
    return;
  }

  // ─── Classic readline path: OSC terminal recolour (TUI handles its own bg) ───
  // Paint the terminal in the theme's bg/fg, and restore it on any exit so we never leave
  // the user's terminal recoloured after Alan quits.
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
    process.on("SIGINT", () => {
      restore();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      restore();
      process.exit(143);
    });
  }

  // ─── Welcome Screen ───
  const recentSessions = engine.listSessions().filter((s) => s.id !== sessionId);

  process.stdout.write(
    renderWelcome({
      model: engine.getModel(),
      provider: engine.getProvider(),
      effort: engine.getEffort(),
      sessionId,
      workspace: workspaceRoot,
      version: "0.1.0",
      sandbox: config.sandbox?.enabled ?? false,
      recentSessions,
    }) + "\n",
  );

  const spinner = new Spinner();
  const yoloMode = values.yolo as boolean;

  // ─── Paste Interception ───
  // Intercept stdin BEFORE readline to prevent echo flood on large pastes.
  // readline echoes every line as it processes — by the time 'line' events fire,
  // 1000+ lines are already printed. This catches paste at the data level.

  const PASTE_LINE_THRESHOLD = 5;
  let pasteCount = 0;
  let pasteAccum = "";
  let pasteFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

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
            `  ${accent("\u203A")} ${faint(`[pasted #${pasteCount} \u00B7 +${lineCount} lines]`)}\n`,
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

  const permissionHandler: PermissionHandler = (prompt) =>
    new Promise<UserPermissionDecision>((resolve) => {
      const wasSpinning = spinner.isRunning?.() ?? false;
      spinner.stop();

      const argPreview = prompt.argsSummary.slice(0, 100);
      process.stdout.write("\n");
      process.stdout.write(
        `  ${warn("?")} ${text("Allow")} ${info(prompt.toolName)}${argPreview ? faint(" \u2014 " + argPreview) : ""}${text("?")}\n`,
      );
      process.stdout.write(
        `  ${ok("Enter")} ${faint("allow")}   ${warn("s")} ${faint("session")}   ${accent("n")} ${faint("deny")}\n`,
      );

      rl.question(`  ${accent("\u203a")} `, (answer) => {
        const a = answer.trim().toLowerCase();
        let decision: UserPermissionDecision;
        if (a === "n" || a === "no" || a === "d" || a === "deny") {
          decision = { kind: "deny" };
        } else if (a === "s" || a === "session") {
          decision = { kind: "allow_session" };
        } else {
          // Default (Enter / y / yes / anything) = allow once
          decision = { kind: "allow_once" };
        }

        if (decision.kind === "deny") {
          process.stdout.write(`  ${accent("\u2715")} ${muted("denied")}\n`);
        } else if (decision.kind === "allow_session") {
          process.stdout.write(`  ${ok("\u2713")} ${muted("allowed for session")}\n`);
        } else {
          process.stdout.write(`  ${ok("\u2713")} ${muted("allowed")}\n`);
        }

        if (wasSpinning) spinner.start("tool_call");
        resolve(decision);
      });
    });

  // Register in every mode. The broker short-circuits to "allowed" under Turing, so the
  // handler is simply never called there — but stays wired so cycling back to confirm/auto
  // (Shift+Tab, /mode, /turing) restores prompts without re-registration.
  engine.setPermissionHandler(permissionHandler);

  // ─── Slash Command Definitions ───

  const SLASH_CMDS: [string, string][] = [
    ["/model", "Switch model/provider"],
    ["/effort", "Set reasoning effort"],
    ["/theme", "Themes — switch color theme"],
    ["/status", "Session status"],
    ["/providers", "List providers"],
    ["/keys", "Manage API keys"],
    ["/mcp", "List MCP servers"],
    ["/skills", "Browse & search skills"],
    ["/research", "Research — propose a plan, then a cited report"],
    ["/deepresearch", "Deep research — multi-round, long-form"],
    ["/cost", "Session cost"],
    ["/compress", "Summarize & shrink context"],
    ["/plan", "Toggle plan mode"],
    ["/turing", "Turing — toggle bypass mode (shift+tab)"],
    ["/mode", "Cycle permission mode (confirm/auto/turing)"],
    ["/rewind", "Roll back the conversation"],
    ["/help", "Show all commands"],
    ["/quit", "Exit Alan"],
  ];

  function showPrompt() {
    process.stdout.write(
      "\n" +
        statusLine({
          model: engine.getModel(),
          effort: engine.getEffort(),
          workspace: workspaceRoot,
          mode: engine.getPermissionMode(),
        }) +
        "\n" +
        composerRule() +
        "\n",
    );
    rl.prompt();
  }

  /**
   * Switch the permission mode and re-render the prompt (Shift+Tab / /turing / /mode).
   * The buffer the user is mid-typing is preserved across the reprint.
   */
  function cycleMode(target?: ReturnType<typeof engine.getPermissionMode>) {
    let next: ReturnType<typeof engine.getPermissionMode>;
    if (target) {
      engine.setPermissionMode(target);
      next = target;
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
  // swallow it can fall back to /mode or /turing.
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", (_str: string, key: { name?: string; shift?: boolean } | undefined) => {
      if (!busy && key?.name === "tab" && key.shift) cycleMode();
    });
  }

  // ─── Line Handler ───
  // Small inputs (< PASTE_LINE_THRESHOLD) come through readline normally.
  // Large pastes are intercepted at stdin level above and never reach here.

  let pasteBuffer: string[] = [];
  let pasteTimer: ReturnType<typeof setTimeout> | null = null;

  showPrompt();

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

  async function handleInput(input: string) {
    if (!input) {
      showPrompt();
      return;
    }

    process.stdout.write("\n");

    // ─── Slash Commands ───

    if (input === "/") {
      // Bare slash — show all available commands
      process.stdout.write(`  ${bold(text("Commands"))}\n\n`);
      for (const [cmd, desc] of SLASH_CMDS) {
        process.stdout.write(`    ${info(cmd.padEnd(14))}${muted(desc)}\n`);
      }
      if (customCommands.length) {
        process.stdout.write(`\n  ${bold(text("Custom"))}\n\n`);
        for (const c of customCommands) {
          process.stdout.write(
            `    ${info(("/" + c.name).padEnd(14))}${muted(c.description ?? "")}\n`,
          );
        }
      }
      process.stdout.write("\n");
      showPrompt();
      return;
    }

    if (input === "/quit" || input === "/exit") {
      console.log(dim("  Goodbye.\n"));
      engine.close();
      process.exit(0);
    }

    if (input === "/help") {
      const cmds: [string, string][] = [
        ["/model", "Switch model/provider"],
        ["/effort", "Set reasoning effort"],
        ["/theme", "Themes — switch color theme"],
        ["/status", "Session status"],
        ["/providers", "List providers"],
        ["/keys", "Manage API keys"],
        ["/mcp", "List MCP servers"],
        ["/skills", "Browse & search skills"],
        ["/research", "Research — propose a plan, then a cited report"],
        ["/deepresearch", "Deep research — multi-round, long-form"],
        ["/cost", "Session cost"],
        ["/compress", "Summarize & shrink context"],
        ["/plan", "Toggle plan mode"],
        ["/turing", "Turing — toggle bypass mode (shift+tab)"],
        ["/mode", "Cycle permission mode (confirm/auto/turing)"],
        ["/rewind", "Roll back the conversation"],
        ["/help", "This reference"],
        ["/quit", "Exit"],
      ];
      process.stdout.write(`  ${bold(text("Commands"))}\n\n`);
      for (const [cmd, desc] of cmds) {
        process.stdout.write(`    ${info(cmd.padEnd(14))}${muted(desc)}\n`);
      }
      process.stdout.write("\n");
      showPrompt();
      return;
    }

    if (input === "/cost") {
      console.log(dim(`  $${engine.getCost().toFixed(4)}\n`));
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
            effort: status.effort,
            workspace: status.workspace,
            sessionId,
            cost: status.cost,
            plannerMode: status.plannerMode,
            yoloMode: status.yoloMode,
            trustWorkspace: status.trustWorkspace,
            permissionMode: status.permissionMode,
            registeredProviders: status.registeredProviders,
            version: "0.1.0",
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
      showPrompt();
      return;
    }

    if (input === "/mcp") {
      const servers = await engine.listMcpServers();
      process.stdout.write(`  ${bold(text("MCP Servers"))}\n\n`);
      if (servers.length === 0) {
        process.stdout.write(
          `    ${muted("None configured. Add servers in ")}${info(".alan/mcp.json")}${muted(".")}\n\n`,
        );
      } else {
        for (const s of servers) {
          const dot =
            s.health === "healthy" ? ok("●") : s.health === "degraded" ? warn("●") : faint("○");
          process.stdout.write(
            `    ${dot} ${text(s.name)} ${muted(`(${s.kind}, ${s.toolCount} tools)`)}\n`,
          );
          if (s.tools.length) {
            process.stdout.write(`      ${faint(s.tools.join(", "))}\n`);
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
          `    ${muted("None found. Add skills under ")}${info("skills/")}${muted(" or ")}${info(".alan/skills/")}${muted(".")}\n\n`,
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

    if (input === "/providers") {
      const registered = engine.getRegisteredProviders();
      const currentProvider = engine.getProvider();
      const allProviders = ["google", "anthropic", "openai", "openrouter"];

      process.stdout.write(`  ${bold(text("Providers"))}\n\n`);
      for (const name of allProviders) {
        const isRegistered = registered.includes(name as any);
        const isActive = name === currentProvider;
        const indicator = isActive ? ok("●") : isRegistered ? warn("●") : faint("○");
        const colorName = isActive ? ok : isRegistered ? text : faint;
        const statusText = isActive
          ? ok("active")
          : isRegistered
            ? muted("ready")
            : faint("no key");
        process.stdout.write(`    ${indicator} ${colorName(name.padEnd(14))} ${statusText}\n`);
      }
      process.stdout.write("\n");
      showPrompt();
      return;
    }

    if (input === "/theme" || input.startsWith("/theme ")) {
      const themes = listThemes();
      const arg = input.slice("/theme".length).trim().toLowerCase();
      if (arg) {
        if (setTheme(arg)) {
          saveTheme(arg);
          applyTerminalTheme();
          process.stdout.write(`  ${green("✓")} theme set to ${brass(getTheme().label)}\n\n`);
        } else {
          process.stdout.write(`  ${vermillion("✕")} unknown theme: ${arg}\n\n`);
        }
        showPrompt();
        return;
      }
      const current = getTheme().name;
      process.stdout.write(`  ${bold(text("Themes"))}\n\n`);
      themes.forEach((t, i) => {
        const isCurrent = t.name === current;
        const marker = isCurrent ? ` ${ok("◂ current")}` : "";
        process.stdout.write(
          `    ${warn(`[${String(i + 1).padStart(2)}]`)} ${(isCurrent ? text : muted)(t.label.padEnd(18))} ${swatch(t.name)}  ${faint(t.appearance)}${marker}\n`,
        );
      });
      process.stdout.write("\n");
      rl.question(`  ${vermillion("›")} `, (answer) => {
        const a = answer.trim().toLowerCase();
        const pick =
          themes.find((_, i) => String(i + 1) === a) ??
          themes.find((t) => t.name === a || t.label.toLowerCase() === a);
        if (pick) {
          setTheme(pick.name);
          saveTheme(pick.name);
          applyTerminalTheme();
          process.stdout.write(`  ${green("✓")} theme set to ${brass(getTheme().label)}\n\n`);
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
          `  ${bold(text("API keys"))} ${faint("· saved to ~/.alan/secrets.json, applied live")}\n\n`,
        );
        for (const r of engine.getProviderStatus()) {
          const hasKey = r.source !== "none";
          const dot = r.disabled
            ? faint("○")
            : r.active
              ? ok("●")
              : hasKey
                ? info("●")
                : faint("○");
          const name = (r.active ? ok : hasKey ? text : faint)(r.id.padEnd(12));
          const keyCol =
            r.source === "none"
              ? faint("not set".padEnd(14))
              : text((r.masked || "set").padEnd(14));
          const src = r.disabled ? warn("off") : r.source === "none" ? faint("—") : faint(r.source);
          process.stdout.write(`    ${dot} ${name} ${keyCol} ${src}\n`);
        }
        process.stdout.write(
          `\n  ${muted("Set ")}${info("/keys set <provider> <key>")}${muted(" · ")}${info("/keys clear <provider>")}${muted(" · ")}${info("/keys off|on <provider>")}\n`,
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
        if (id === CUSTOM_PROVIDER_ID) {
          persistClearCustom();
          engine.setCustomEndpoint(null);
        } else {
          persistClearKey(id);
          engine.setProviderKey(id, null);
        }
        process.stdout.write(`  ${ok("✓")} ${muted("cleared")} ${info(id)}\n`);
        showPrompt();
        return;
      }
      if ((sub === "off" || sub === "on") && parts[1]) {
        const id = parts[1].toLowerCase();
        const disabled = sub === "off";
        persistDisabled(id, disabled);
        engine.setProviderDisabled(id, disabled);
        process.stdout.write(
          `  ${ok("✓")} ${info(id)} ${muted(disabled ? "disabled" : "enabled")}\n`,
        );
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
      process.stdout.write(
        `  ${warn("Usage:")} ${info("/keys")}${muted(" · ")}${info("set <p> <key>")}${muted(" · ")}${info("clear <p>")}${muted(" · ")}${info("off|on <p>")}${muted(" · ")}${info("custom <url> <model> <key>")}\n`,
      );
      showPrompt();
      return;
    }

    if (input === "/effort") {
      const current = engine.getEffort();
      const levels: { key: string; level: "low" | "medium" | "high" | "max"; label: string }[] = [
        { key: "1", level: "low", label: "Quick, minimal reasoning" },
        { key: "2", level: "medium", label: "Balanced (default)" },
        { key: "3", level: "high", label: "Thorough analysis" },
        { key: "4", level: "max", label: "Maximum capability" },
      ];
      process.stdout.write(`  ${bold(text("Reasoning effort"))}\n\n`);
      for (const l of levels) {
        const isCurrent = l.level === current;
        const active = isCurrent ? ` ${ok("◂ current")}` : "";
        process.stdout.write(
          `    ${warn(`[${l.key}]`)} ${(isCurrent ? text : muted)(l.level.padEnd(8))} ${faint(l.label)}${active}\n`,
        );
      }
      process.stdout.write("\n");

      rl.question(`  ${vermillion("\u203A")} `, (answer) => {
        const a = answer.trim().toLowerCase();
        const selected = levels.find((l) => l.key === a || l.level === a);
        if (selected) {
          engine.setEffort(selected.level);
          process.stdout.write(`  ${green("✓")} effort set to ${brass(selected.level)}\n\n`);
        } else {
          process.stdout.write(`  ${dim("no change")}\n\n`);
        }
        showPrompt();
      });
      return;
    }

    if (input.startsWith("/effort ")) {
      const arg = input.slice(8).trim().toLowerCase();
      const validLevels = ["low", "medium", "high", "max"] as const;
      const level = validLevels.find((l) => l === arg);
      if (level) {
        engine.setEffort(level);
        const settings = engine.getEffortSettings();
        process.stdout.write(
          `  ${green("✓")} effort set to ${brass(level)} ${dim(`(${settings.label})`)}\n\n`,
        );
      } else {
        process.stdout.write(
          `  ${vermillion("✕")} invalid level. Use: ${validLevels.join(", ")}\n\n`,
        );
      }
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

    if (input === "/model") {
      // Show current model and interactive picker
      const current = engine.getModel();
      const currentProvider = engine.getProvider();
      const registered = engine.getRegisteredProviders();

      process.stdout.write(
        `  ${bold(text("Model"))}  ${faint("current:")} ${info(currentProvider + "/" + current)}\n\n`,
      );

      // Data-driven from the provider presets: every registered provider with a
      // curated `models` list contributes its models, so adding a provider is a
      // one-line preset edit. Free-form `/model <provider>/<id>` still works.
      const presets: { key: string; provider: string; model: string; label: string }[] = [];
      for (const id of registered) {
        const preset = getPreset(id);
        if (!preset?.models?.length) continue;
        for (const m of preset.models) {
          presets.push({
            key: `${presets.length + 1}`,
            provider: id,
            model: m.id,
            label: m.label,
          });
        }
      }

      for (const p of presets) {
        const isCurrent = p.provider === currentProvider && p.model === current;
        const active = isCurrent ? ` ${ok("◂ current")}` : "";
        process.stdout.write(
          `    ${warn(`[${p.key}]`)} ${info(p.provider)}${faint("/")}${text(p.label)}${active}\n`,
        );
      }
      process.stdout.write(`    ${warn("[c]")} ${faint("custom provider/model")}\n\n`);

      rl.question(`  ${vermillion("\u203A")} `, (answer) => {
        const a = answer.trim().toLowerCase();

        if (a === "c") {
          rl.question(`  ${dim("provider")} ${vermillion("\u203A")} `, (provAnswer) => {
            const prov = provAnswer.trim();
            rl.question(`  ${dim("model")}    ${vermillion("\u203A")} `, (modAnswer) => {
              const mod = modAnswer.trim();
              if (prov && mod) {
                engine.switchModel(mod, prov as any, sessionId);
                saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
                process.stdout.write(
                  `  ${green("✓")} switched to ${cyanotype(prov)}${dim("/")}${brass(mod)}\n\n`,
                );
              } else {
                process.stdout.write(`  ${vermillion("✕")} ${dim("cancelled")}\n\n`);
              }
              showPrompt();
            });
          });
          return;
        }

        const preset = presets.find((p) => p.key === a);
        if (preset) {
          engine.switchModel(preset.model, preset.provider as any, sessionId);
          saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
          process.stdout.write(
            `  ${green("✓")} switched to ${cyanotype(preset.provider)}${dim("/")}${brass(preset.label)}\n\n`,
          );
        } else {
          process.stdout.write(`  ${dim("no change")}\n\n`);
        }
        showPrompt();
      });
      return;
    }

    if (input.startsWith("/model ")) {
      // Quick switch: /model provider/model
      const arg = input.slice(7).trim();
      const slashIdx = arg.indexOf("/");
      if (slashIdx > 0) {
        const prov = arg.slice(0, slashIdx);
        const mod = arg.slice(slashIdx + 1);
        engine.switchModel(mod, prov as any, sessionId);
        saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
        process.stdout.write(
          `  ${green("✓")} switched to ${cyanotype(prov)}${dim("/")}${brass(mod)}\n\n`,
        );
      } else {
        // Treat as model name with current provider
        engine.switchModel(arg, undefined, sessionId);
        saveLastModel({ provider: engine.getProvider(), model: engine.getModel() });
        process.stdout.write(`  ${green("✓")} switched to ${brass(arg)}\n\n`);
      }
      showPrompt();
      return;
    }

    if (input === "/plan") {
      const on = !engine.isPlannerMode();
      engine.setPlannerMode(on);
      process.stdout.write(
        `  ${green("✓")} plan mode ${on ? "on" : "off"} ${dim(
          on ? "— Alan drafts a step plan before executing" : "— flat agent loop",
        )}\n\n`,
      );
      showPrompt();
      return;
    }

    if (input === "/turing") {
      // Explicit toggle into the bypass mode, or back out to confirm.
      const target = engine.getPermissionMode() === "turing" ? "confirm" : "turing";
      engine.setPermissionMode(target);
      process.stdout.write(permissionModeBanner(target) + "\n");
      showPrompt();
      return;
    }

    if (input === "/mode" || input.startsWith("/mode ")) {
      const arg = input.slice("/mode".length).trim().toLowerCase();
      const valid = ["confirm", "auto", "turing"] as const;
      if (arg && (valid as readonly string[]).includes(arg)) {
        engine.setPermissionMode(arg as (typeof valid)[number]);
        process.stdout.write(permissionModeBanner(arg) + "\n");
      } else if (arg) {
        process.stdout.write(
          `  ${warn("Usage:")} ${info("/mode")} ${dim("[confirm|auto|turing] — empty cycles")}\n`,
        );
      } else {
        process.stdout.write(permissionModeBanner(engine.cyclePermissionMode()) + "\n");
      }
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
        const verb = isDeepResearch ? "deep, multi-round research" : "research with a cited report";
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
          const answers = await ask(`  ${accent("›")} ${faint("answer, or Enter to skip: ")}`);
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
          const a = (await ask(`  ${accent("›")} `)).trim().toLowerCase();
          if (a === "n" || a === "no" || a === "c" || a === "cancel") {
            process.stdout.write(`  ${dim("research cancelled")}\n\n`);
            break;
          }
          if (a === "r" || a === "revise") {
            const fb = await ask(`  ${accent("›")} ${faint("what should change? ")}`);
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
              process.stdout.write(`\n  ${accent("✕")} ${text(ev.error)}\n`);
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
              const dir = config.research?.outputDir || join(workspaceRoot, ".alan", "research");
              mkdirSync(dir, { recursive: true });
              const slug =
                question
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 50) || "research";
              const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
              const body = `# Research: ${plan.question}\n\n_Generated by Alan · ${new Date().toISOString()}_\n\n${report.markdown}\n`;
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

    // Custom slash commands from .alan/commands/*.md — render, then run as a prompt.
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

    busy = true;

    // Close the composer frame: a matching rule beneath the submitted input.
    process.stdout.write(composerRule() + "\n\n");
    spinner.start("thinking");
    let isStreaming = false;
    let isThinking = false;
    let totalTokens = 0;

    try {
      for await (const event of engine.chat(sessionId, input)) {
        switch (event.type) {
          case "thinking_delta": {
            // Reasoning models' chain-of-thought — dimmed and kept visually
            // separate from the answer (and never persisted as part of it).
            if (!isStreaming) {
              spinner.stop();
              isStreaming = true;
            }
            isThinking = true;
            process.stdout.write(faint(event.text));
            break;
          }

          case "text_delta": {
            if (!isStreaming) {
              spinner.stop();
              isStreaming = true;
            }
            if (isThinking) {
              process.stdout.write("\n"); // separate reasoning from the answer
              isThinking = false;
            }
            process.stdout.write(event.text);
            totalTokens++;
            break;
          }

          case "tool_call_start": {
            if (isStreaming) {
              process.stdout.write("\n");
              isStreaming = false;
            }
            if (!spinner.isRunning()) spinner.start("tool_call");
            spinner.setTool(event.toolName);
            break;
          }

          case "tool_call_end": {
            spinner.stop();
            process.stdout.write(
              "\n" +
                renderToolCall({
                  toolName: event.output.toolName,
                  args: event.args,
                  result: event.output.result,
                  success: event.output.success,
                  error: event.output.error,
                  durationMs: event.output.durationMs,
                }) +
                "\n",
            );
            spinner.start("thinking");
            break;
          }

          case "todo_updated": {
            spinner.stop();
            if (isStreaming) {
              process.stdout.write("\n");
              isStreaming = false;
            }
            process.stdout.write(`\n  ${muted("•")} ${bold(text("Updated plan"))}\n`);
            for (const item of event.items) {
              const marker =
                item.status === "completed"
                  ? ok("✓")
                  : item.status === "in_progress"
                    ? warn("▸")
                    : faint("□");
              const label =
                item.status === "in_progress" ? text(item.content) : muted(item.content);
              process.stdout.write(`    ${marker} ${label}\n`);
            }
            process.stdout.write("\n");
            spinner.start("thinking");
            break;
          }

          case "plan_created": {
            spinner.stop();
            if (isStreaming) {
              process.stdout.write("\n");
              isStreaming = false;
            }
            process.stdout.write(`\n  ${muted("•")} ${bold(text("Plan"))}\n`);
            const numerals = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
            for (const step of event.plan.steps) {
              const num = numerals[step.index] ?? `${step.index + 1}`;
              const deps =
                step.dependsOn.length > 0 ? faint(` (after ${step.dependsOn.join(",")})`) : "";
              process.stdout.write(`    ${warn(`${num}.`)} ${text(step.description)}${deps}\n`);
            }
            process.stdout.write("\n");
            spinner.start("executing");
            break;
          }

          case "step_started": {
            spinner.stop();
            const numerals = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
            const num = numerals[event.stepIndex] ?? `${event.stepIndex + 1}`;
            process.stdout.write(
              `\n  ${muted("\u2022")} ${bold(text(`Step ${num}`))}  ${muted(event.description)}\n`,
            );
            spinner.start("executing");
            break;
          }

          case "step_completed": {
            spinner.stop();
            const mark = event.result.success ? ok("✓") : accent("✕");
            process.stdout.write(`    ${mark} ${muted(event.result.summary.slice(0, 120))}\n`);
            break;
          }

          case "plan_completed": {
            spinner.stop();
            const completed = event.plan.steps.filter(
              (s: { status: string }) => s.status === "completed",
            ).length;
            const total = event.plan.steps.length;
            const status = event.plan.status === "completed" ? ok("completed") : accent("failed");
            process.stdout.write(
              `\n  ${muted("•")} ${bold(text("Result"))} ${status} ${faint(`(${completed}/${total} steps)`)}\n`,
            );
            break;
          }

          case "replanning": {
            spinner.stop();
            process.stdout.write(
              `\n  ${warn("•")} ${muted("Replanning after step")} ${warn(String(event.failedStep))} ${muted("failed…")}\n`,
            );
            spinner.start("planning");
            break;
          }

          case "plan_updated": {
            spinner.stop();
            process.stdout.write(
              `\n  ${muted("•")} ${bold(text("Revised plan"))}  ${faint(event.reason)}\n`,
            );
            const numerals = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
            for (const step of event.plan.steps) {
              const num = numerals[step.index] ?? `${step.index + 1}`;
              process.stdout.write(`    ${warn(`${num}.`)} ${text(step.description)}\n`);
            }
            process.stdout.write("\n");
            spinner.start("executing");
            break;
          }

          case "turn_complete": {
            spinner.stop();
            if (isStreaming) {
              process.stdout.write("\n");
              isStreaming = false;
            }
            const cost = engine.getCost();
            process.stdout.write(
              `\n  ${faint(`↳ ${event.totalTurns} turns · $${cost.toFixed(4)}`)}\n\n`,
            );
            break;
          }

          case "notice": {
            spinner.stop();
            if (isStreaming) {
              process.stdout.write("\n");
              isStreaming = false;
            }
            process.stdout.write(`\n  ${warn("•")} ${muted(event.message)}\n`);
            spinner.start("thinking");
            break;
          }

          case "error": {
            spinner.stop();
            isStreaming = false;
            const rawErr = event.error ?? "Unknown error";
            // Extract clean message — strip raw JSON, limit length
            let errDisplay = rawErr;
            if (rawErr.includes('"error"') || rawErr.length > 200) {
              // Try to extract just the message from JSON errors
              try {
                const parsed = JSON.parse(rawErr.slice(rawErr.indexOf("{")));
                errDisplay = parsed.error?.message?.split("\n")[0] ?? rawErr.slice(0, 150);
              } catch {
                errDisplay = rawErr.slice(0, 150);
              }
            }
            // Detect rate limit and add suggestion
            const isRateLimit =
              rawErr.includes("429") ||
              rawErr.toLowerCase().includes("rate limit") ||
              rawErr.toLowerCase().includes("quota");
            if (isRateLimit) {
              errDisplay = errDisplay.split("\n")[0].slice(0, 120);
            }
            process.stdout.write(`\n  ${accent("✕")} ${text(errDisplay)}\n`);
            if (isRateLimit) {
              process.stdout.write(
                `  ${faint("→")} ${warn("Tip:")} ${muted("Try switching models:")} ${info("/model")}\n`,
              );
              process.stdout.write(
                `  ${faint("  or use:")} ${warn("alan --model gemini-2.5-flash")}\n`,
              );
            }
            process.stdout.write("\n");
            break;
          }
        }
      }
    } catch (err) {
      spinner.stop();
      console.error(vermillion(`\n  Error: ${err instanceof Error ? err.message : err}\n`));
    }

    busy = false;
    showPrompt();
  }

  rl.on("close", () => {
    spinner.stop();
    console.log(dim("\n  Goodbye.\n"));
    engine.close();
    process.exit(0);
  });

  // ─── SIGINT: abort in-flight turn; exit when idle ───
  let sigintIdleCount = 0;
  process.on("SIGINT", () => {
    if (busy) {
      // Turn is in progress — cancel it without exiting
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
      engine.close();
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error(vermillion(`Fatal: ${err.message}`));
  process.exit(1);
});
