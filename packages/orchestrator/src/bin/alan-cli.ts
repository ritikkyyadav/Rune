#!/usr/bin/env bun
import { Engine } from "../engine";
import type { PermissionHandler, UserPermissionDecision } from "../engine";
import { loadConfig } from "@alan/shared";
import { parseArgs } from "util";
import * as readline from "readline";
import { Spinner } from "./spinner";
import { renderWelcome } from "./welcome";
import { renderEditResult, renderWriteResult } from "./diff-render";
import { exportSession } from "../session-export";
import { loadCommands, findCommand } from "../commands";

// ─── CLI Argument Parsing ───

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    model: { type: "string", short: "m" },
    provider: { type: "string", short: "p" },
    workspace: { type: "string", short: "w" },
    yolo: { type: "boolean", default: false },
    planner: { type: "boolean", default: false },
    "planner-model": { type: "string" },
    "executor-model": { type: "string" },
    resume: { type: "string", short: "r" },
    list: { type: "boolean", short: "l", default: false },
    format: { type: "string", default: "md" },
    sign: { type: "boolean", default: false },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
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
      `    -p, --provider <provider>    LLM provider (anthropic|openai|openrouter|google)\n` +
      `    -w, --workspace <path>       Workspace root directory\n` +
      `    -r, --resume <sessionId>     Resume an existing session\n` +
      `    --yolo                       Skip permission prompts\n` +
      `    --planner                    Enable planner+executor mode\n` +
      `    -h, --help                   Show this help\n\n`,
  );
  process.exit(0);
}

type CliProvider = "anthropic" | "openai" | "openrouter" | "google";

const DEFAULT_MODELS: Record<CliProvider, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  openrouter: "deepseek/deepseek-v4-flash:free",
  google: "gemini-2.5-flash",
};

function isCliProvider(provider: string): provider is CliProvider {
  return (
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "openrouter" ||
    provider === "google"
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

import { bold, paper, dim, vermillion, brass, cyanotype, green, stripAnsi } from "./colors";

// ─── Main ───

async function main() {
  const dataDir = ensureDataDir();
  const toolsBinary = await findToolsBinary();
  const workspaceRoot = (values.workspace as string | undefined) ?? process.cwd();

  const config = loadConfig(workspaceRoot);

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

  // Use CLI arg first, then config (only if that provider has a key), then auto-detect
  let provider: CliProvider;
  if (cliProvider && isCliProvider(cliProvider)) {
    provider = cliProvider;
  } else if (configProvider && isCliProvider(configProvider)) {
    // Verify the configured default provider actually has credentials
    const cfgSection = config.llm[configProvider] as { apiKey?: string } | undefined;
    const envVarMap: Record<CliProvider, string> = {
      google: "GOOGLE_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    };
    if (process.env[envVarMap[configProvider]] || cfgSection?.apiKey) {
      provider = configProvider;
    } else {
      provider = detectBestProvider();
    }
  } else {
    provider = detectBestProvider();
  }
  const model =
    (values.model as string | undefined) ??
    configuredModelForProvider(config, provider) ??
    DEFAULT_MODELS[provider];

  const plannerMode = values.planner as boolean;
  const engine = new Engine({
    model,
    provider: provider as "anthropic" | "openai" | "openrouter" | "google",
    workspaceRoot,
    dbPath: config.engine.dbPath,
    toolsBinaryPath: toolsBinary,
    yoloMode: values.yolo as boolean,
    plannerMode,
    routing: plannerMode
      ? {
          planner: (values["planner-model"] as string) ?? config.llm.planner?.model ?? model,
          executor: (values["executor-model"] as string) ?? config.llm.executor?.model ?? model,
          plannerProvider: config.llm.planner?.provider ?? provider,
          executorProvider: config.llm.executor?.provider ?? provider,
        }
      : undefined,
    anthropicApiKey: config.llm.anthropic?.apiKey,
    openaiApiKey: config.llm.openai?.apiKey,
    openrouterApiKey: config.llm.openrouter?.apiKey,
    googleApiKey: config.llm.google?.apiKey,
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

  // ─── Welcome Screen ───
  const recentSessions = engine.listSessions().filter((s) => s.id !== sessionId);

  process.stdout.write(
    "\n" +
      renderWelcome({
        model: engine.getModel(),
        provider: engine.getProvider(),
        sessionId,
        workspace: workspaceRoot,
        version: "0.1.0",
        sandbox: config.sandbox?.enabled ?? false,
        recentSessions,
      }) +
      "\n",
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
            `  ${vermillion("\u203A")} ${dim("alan")} ${dim(`[Pasted text #${pasteCount} +${lineCount} lines]`)}\n`,
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
    prompt: `  ${vermillion("\u203A")} ${dim("alan")} `,
  });

  // ─── Permission Handler ───

  const permissionHandler: PermissionHandler = (prompt) =>
    new Promise<UserPermissionDecision>((resolve) => {
      const wasSpinning = spinner.isRunning?.() ?? false;
      spinner.stop();

      const w = process.stdout.columns ?? 80;
      const ruleW = Math.min(w - 4, 56);
      process.stdout.write(`\n  ${dim("┌")}${dim("─".repeat(ruleW))}${dim("┐")}\n`);
      process.stdout.write(
        `  ${dim("│")} ${vermillion("§ PERMISSION REQUIRED")}${" ".repeat(Math.max(0, ruleW - 24))}${dim("│")}\n`,
      );
      process.stdout.write(`  ${dim("├")}${dim("─".repeat(ruleW))}${dim("┤")}\n`);
      process.stdout.write(
        `  ${dim("│")} ${dim("tool")}  ${cyanotype(prompt.toolName)}${" ".repeat(Math.max(0, ruleW - 8 - prompt.toolName.length))}${dim("│")}\n`,
      );
      process.stdout.write(
        `  ${dim("│")} ${dim("args")}  ${prompt.argsSummary.slice(0, ruleW - 9)}${" ".repeat(Math.max(0, ruleW - 8 - prompt.argsSummary.slice(0, ruleW - 9).length))}${dim("│")}\n`,
      );
      process.stdout.write(`  ${dim("└")}${dim("─".repeat(ruleW))}${dim("┘")}\n`);
      process.stdout.write(
        `  ${brass("[a]")} allow once  ${brass("[s]")} allow session  ${vermillion("[d]")} deny ${dim("(default)")}\n`,
      );

      rl.question(`  ${vermillion("\u203A")} `, (answer) => {
        const a = answer.trim().toLowerCase();
        let decision: UserPermissionDecision;
        if (a === "s" || a === "session") decision = { kind: "allow_session" };
        else if (a === "a" || a === "allow" || a === "y" || a === "yes")
          decision = { kind: "allow_once" };
        else decision = { kind: "deny" };

        if (decision.kind === "deny") {
          process.stdout.write(`  ${vermillion("✕")} ${dim("denied")}\n`);
        } else if (decision.kind === "allow_session") {
          process.stdout.write(`  ${green("✓")} ${dim("granted for session")}\n`);
        } else {
          process.stdout.write(`  ${green("✓")} ${dim("granted once")}\n`);
        }

        if (wasSpinning) spinner.start("tool_call");
        resolve(decision);
      });
    });

  if (!yoloMode) {
    engine.setPermissionHandler(permissionHandler);
  }

  // ─── Slash Command Definitions ───

  const SLASH_CMDS: [string, string][] = [
    ["/model", "Switch model/provider"],
    ["/effort", "Set reasoning effort"],
    ["/status", "Session status"],
    ["/providers", "List providers"],
    ["/cost", "Session cost"],
    ["/compact", "Toggle compact mode"],
    ["/plan", "Toggle plan mode"],
    ["/rewind", "Roll back the conversation"],
    ["/help", "Show all commands"],
    ["/quit", "Exit Alan"],
  ];

  function showPrompt() {
    const w = process.stdout.columns ?? 80;
    const ruleW = Math.min(w - 4, 76);

    // ── confirm · google/gemini-2.5-flash ─────────────
    const modeLabel = yoloMode ? green("yolo") : dim("confirm");
    const provModel = `${engine.getProvider()}/${engine.getModel()}`;
    const infoPart = `${modeLabel} ${dim("·")} ${dim(provModel)}`;
    const infoVisLen = stripAnsi(infoPart).length;
    const padRight = Math.max(0, ruleW - infoVisLen - 4);
    const topRule = `  ${dim("──")} ${infoPart} ${dim("─".repeat(padRight))}`;

    process.stdout.write("\n" + topRule + "\n\n");
    rl.prompt();
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
      process.stdout.write(`  ${dim("§ Commands")}\n\n`);
      for (const [cmd, desc] of SLASH_CMDS) {
        process.stdout.write(`    ${brass(cmd.padEnd(14))}${dim(desc)}\n`);
      }
      if (customCommands.length) {
        process.stdout.write(`\n  ${dim("§ Custom")}\n\n`);
        for (const c of customCommands) {
          process.stdout.write(`    ${brass(("/" + c.name).padEnd(14))}${dim(c.description ?? "")}\n`);
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
      const w = process.stdout.columns ?? 80;
      const ruleW = Math.min(w - 4, 62);
      process.stdout.write(`  ${dim("┌")}${dim("─".repeat(ruleW))}${dim("┐")}\n`);
      process.stdout.write(
        `  ${dim("│")} ${dim("§ 01 — Commands")}${" ".repeat(Math.max(0, ruleW - 18))}${dim("│")}\n`,
      );
      process.stdout.write(`  ${dim("├")}${dim("─".repeat(ruleW))}${dim("┤")}\n`);
      const cmds: [string, string][] = [
        ["/model", "Switch model/provider"],
        ["/effort", "Set reasoning effort"],
        ["/status", "Session status"],
        ["/providers", "List providers"],
        ["/cost", "Session cost"],
        ["/compact", "Toggle compact mode"],
        ["/plan", "Toggle plan mode"],
        ["/rewind", "Roll back the conversation"],
        ["/help", "This reference"],
        ["/quit", "Exit"],
      ];
      for (const [cmd, desc] of cmds) {
        const line = `${brass(cmd.padEnd(14))}${dim(desc)}`;
        const visLen = cmd.length + desc.length + (14 - cmd.length);
        process.stdout.write(
          `  ${dim("│")} ${line}${" ".repeat(Math.max(0, ruleW - visLen - 3))}${dim("│")}\n`,
        );
      }
      process.stdout.write(`  ${dim("└")}${dim("─".repeat(ruleW))}${dim("┘")}\n\n`);
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
      const w = process.stdout.columns ?? 80;
      const ruleW = Math.min(w - 4, 56);
      process.stdout.write(`  ${dim("┌")}${dim("─".repeat(ruleW))}${dim("┐")}\n`);
      process.stdout.write(
        `  ${dim("│")} ${dim("§ 02 — Status")}${" ".repeat(Math.max(0, ruleW - 16))}${dim("│")}\n`,
      );
      process.stdout.write(`  ${dim("├")}${dim("─".repeat(ruleW))}${dim("┤")}\n`);
      const rows: [string, string][] = [
        ["model", `${status.provider}/${status.model}`],
        ["effort", `${status.effort} (${status.effortLabel})`],
        ["workspace", status.workspace],
        ["session", sessionId.slice(0, 8)],
        ["mode", `${status.plannerMode ? "planner" : "react"}${status.yoloMode ? " · yolo" : ""}`],
        ["providers", status.registeredProviders.join(", ")],
        ["cost", `$${status.cost.toFixed(4)}`],
      ];
      for (const [label, value] of rows) {
        const visLen = label.length + 3 + value.length;
        process.stdout.write(
          `  ${dim("│")} ${dim(label.padEnd(12))}${brass(value)}${" ".repeat(Math.max(0, ruleW - visLen - 10))}${dim("│")}\n`,
        );
      }
      process.stdout.write(`  ${dim("└")}${dim("─".repeat(ruleW))}${dim("┘")}\n\n`);
      showPrompt();
      return;
    }

    if (input === "/providers") {
      const registered = engine.getRegisteredProviders();
      const currentProvider = engine.getProvider();
      const w = process.stdout.columns ?? 80;
      const ruleW = Math.min(w - 4, 56);
      process.stdout.write(`  ${dim("┌")}${dim("─".repeat(ruleW))}${dim("┐")}\n`);
      process.stdout.write(
        `  ${dim("│")} ${dim("§ 03 — Providers")}${" ".repeat(Math.max(0, ruleW - 19))}${dim("│")}\n`,
      );
      process.stdout.write(`  ${dim("├")}${dim("─".repeat(ruleW))}${dim("┤")}\n`);

      const allProviders: { name: string; envVar: string }[] = [
        { name: "google", envVar: "GOOGLE_API_KEY" },
        { name: "anthropic", envVar: "ANTHROPIC_API_KEY" },
        { name: "openai", envVar: "OPENAI_API_KEY" },
        { name: "openrouter", envVar: "OPENROUTER_API_KEY" },
      ];
      for (const { name, envVar } of allProviders) {
        const isRegistered = registered.includes(name as any);
        const isActive = name === currentProvider;
        const indicator = isActive ? green("●") : isRegistered ? brass("●") : dim("○");
        const label = isActive ? green(name) : isRegistered ? brass(name) : dim(name);
        const statusText = isActive
          ? green("active")
          : isRegistered
            ? dim("ready")
            : vermillion("no key");
        const visLen = 4 + name.length + statusText.length - (isActive || isRegistered ? 0 : 0);
        process.stdout.write(
          `  ${dim("│")} ${indicator} ${label.padEnd(14)} ${statusText}${" ".repeat(Math.max(0, ruleW - name.length - 22))}${dim("│")}\n`,
        );
      }
      process.stdout.write(`  ${dim("└")}${dim("─".repeat(ruleW))}${dim("┘")}\n\n`);
      showPrompt();
      return;
    }

    if (input === "/effort") {
      const current = engine.getEffort();
      const w = process.stdout.columns ?? 80;
      const ruleW = Math.min(w - 4, 56);
      process.stdout.write(`  ${dim("┌")}${dim("─".repeat(ruleW))}${dim("┐")}\n`);
      process.stdout.write(
        `  ${dim("│")} ${dim("§ 04 — Effort")}${" ".repeat(Math.max(0, ruleW - 16))}${dim("│")}\n`,
      );
      process.stdout.write(`  ${dim("├")}${dim("─".repeat(ruleW))}${dim("┤")}\n`);
      const levels: { key: string; level: "low" | "medium" | "high" | "max"; label: string }[] = [
        { key: "1", level: "low", label: "Quick, minimal reasoning" },
        { key: "2", level: "medium", label: "Balanced (default)" },
        { key: "3", level: "high", label: "Thorough analysis" },
        { key: "4", level: "max", label: "Maximum capability" },
      ];
      for (const l of levels) {
        const active = l.level === current ? ` ${green("◂")}` : "";
        const visLen = 5 + l.level.length + l.label.length;
        process.stdout.write(
          `  ${dim("│")} ${brass(`[${l.key}]`)} ${l.level.padEnd(8)} ${dim(l.label)}${active}${" ".repeat(Math.max(0, ruleW - visLen - (active ? 4 : 2)))}${dim("│")}\n`,
        );
      }
      process.stdout.write(`  ${dim("└")}${dim("─".repeat(ruleW))}${dim("┘")}\n\n`);

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

    if (input === "/compact") {
      // Toggle compact mode (future: affects output verbosity)
      process.stdout.write(`  ${green("✓")} ${dim("compact mode toggled")}\n\n`);
      showPrompt();
      return;
    }

    if (input === "/model") {
      // Show current model and interactive picker
      const current = engine.getModel();
      const currentProvider = engine.getProvider();
      const registered = engine.getRegisteredProviders();

      process.stdout.write(
        `  ${dim("current")}  ${cyanotype(currentProvider)}${dim("/")}${brass(current)}\n\n`,
      );

      const presets: { key: string; provider: string; model: string; label: string }[] = [];

      if (registered.includes("google")) {
        presets.push(
          { key: "1", provider: "google", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
          { key: "2", provider: "google", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
          { key: "3", provider: "google", model: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
        );
      }
      if (registered.includes("anthropic")) {
        presets.push(
          {
            key: `${presets.length + 1}`,
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            label: "Claude Sonnet 4",
          },
          {
            key: `${presets.length + 2}`,
            provider: "anthropic",
            model: "claude-opus-4-20250514",
            label: "Claude Opus 4",
          },
        );
      }
      if (registered.includes("openai")) {
        presets.push(
          { key: `${presets.length + 1}`, provider: "openai", model: "gpt-4o", label: "GPT-4o" },
          { key: `${presets.length + 2}`, provider: "openai", model: "o3", label: "o3" },
        );
      }
      if (registered.includes("openrouter")) {
        presets.push(
          {
            key: `${presets.length + 1}`,
            provider: "openrouter",
            model: "deepseek/deepseek-v4-flash:free",
            label: "DeepSeek V4 Flash (free)",
          },
          {
            key: `${presets.length + 2}`,
            provider: "openrouter",
            model: "deepseek/deepseek-r1:free",
            label: "DeepSeek R1 (free)",
          },
        );
      }

      for (const p of presets) {
        const active = p.provider === currentProvider && p.model === current ? green(" ◂") : "";
        process.stdout.write(
          `  ${brass(`[${p.key}]`)} ${cyanotype(p.provider)}${dim("/")}${p.label}${active}\n`,
        );
      }
      process.stdout.write(`  ${brass("[c]")} ${dim("custom provider/model")}\n\n`);

      rl.question(`  ${vermillion("\u203A")} `, (answer) => {
        const a = answer.trim().toLowerCase();

        if (a === "c") {
          rl.question(`  ${dim("provider")} ${vermillion("\u203A")} `, (provAnswer) => {
            const prov = provAnswer.trim();
            rl.question(`  ${dim("model")}    ${vermillion("\u203A")} `, (modAnswer) => {
              const mod = modAnswer.trim();
              if (prov && mod) {
                engine.switchModel(mod, prov as any, sessionId);
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
        process.stdout.write(
          `  ${green("✓")} switched to ${cyanotype(prov)}${dim("/")}${brass(mod)}\n\n`,
        );
      } else {
        // Treat as model name with current provider
        engine.switchModel(arg, undefined, sessionId);
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

    if (input === "/rewind" || input.startsWith("/rewind ")) {
      const turns = engine.listUserTurns(sessionId);
      const arg = input.slice("/rewind".length).trim();
      if (turns.length === 0) {
        process.stdout.write(`  ${dim("Nothing to rewind — no messages yet.")}\n\n`);
        showPrompt();
        return;
      }
      if (!arg) {
        process.stdout.write(
          `  ${dim("§ Rewind — roll back to a turn (removes it and everything after):")}\n\n`,
        );
        turns.forEach((t, i) => {
          const preview = t.text.replace(/\s+/g, " ").slice(0, 60);
          process.stdout.write(`    ${brass(String(i + 1).padStart(2))}  ${dim(preview)}\n`);
        });
        process.stdout.write(`\n  ${dim("Run")} ${brass("/rewind <n>")}\n\n`);
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

    // Bottom rule closing the input area (matching top rule indent)
    const bw = Math.min((process.stdout.columns ?? 80) - 4, 76);
    process.stdout.write(`  ${dim("─".repeat(bw))}\n\n`);

    spinner.start("thinking");
    let isStreaming = false;
    let totalTokens = 0;

    try {
      for await (const event of engine.chat(sessionId, input)) {
        switch (event.type) {
          case "text_delta": {
            if (!isStreaming) {
              spinner.stop();
              isStreaming = true;
            }
            process.stdout.write(event.text);
            totalTokens++;
            break;
          }

          case "tool_call_start": {
            spinner.stop();
            if (isStreaming) {
              process.stdout.write("\n");
              isStreaming = false;
            }
            process.stdout.write(
              `\n  ${dim("┌─")} ${cyanotype(event.toolName)} ${dim("─".repeat(Math.max(1, 40 - event.toolName.length)))}${dim("┐")}\n`,
            );
            spinner.start("tool_call");
            spinner.setTool(event.toolName);
            break;
          }

          case "tool_call_end": {
            spinner.stop();
            if (event.output.success) {
              process.stdout.write(
                `  ${dim("└──")} ${green("✓")} ${dim(`${event.output.durationMs}ms`)}${dim(" ─┘")}\n`,
              );

              const toolName = event.output.toolName;
              if (toolName === "edit_file" || toolName === "write_file") {
                try {
                  const parsed = JSON.parse(event.output.result);
                  const rendered =
                    toolName === "edit_file"
                      ? renderEditResult(parsed, "      ")
                      : renderWriteResult(parsed, "      ");
                  if (rendered) process.stdout.write(rendered + "\n");
                } catch {
                  // result was not JSON — leave as-is
                }
              }
            } else {
              process.stdout.write(
                `  ${dim("└──")} ${vermillion("✕")} ${vermillion(event.output.error ?? "failed")}${dim(" ─┘")}\n`,
              );
            }
            spinner.start("thinking");
            break;
          }

          case "todo_updated": {
            spinner.stop();
            if (isStreaming) {
              process.stdout.write("\n");
              isStreaming = false;
            }
            const todoW = Math.min((process.stdout.columns ?? 80) - 4, 62);
            process.stdout.write(`\n  ${dim("┌")}${dim("─".repeat(todoW))}${dim("┐")}\n`);
            process.stdout.write(
              `  ${dim("│")} ${dim("§ TODO")}${" ".repeat(Math.max(0, todoW - 9))}${dim("│")}\n`,
            );
            process.stdout.write(`  ${dim("├")}${dim("─".repeat(todoW))}${dim("┤")}\n`);
            for (const item of event.items) {
              const marker =
                item.status === "completed"
                  ? green("✓")
                  : item.status === "in_progress"
                    ? brass("▸")
                    : dim("·");
              const itemText = item.content.slice(0, todoW - 6);
              const padLen = Math.max(0, todoW - stripAnsi(itemText).length - 5);
              process.stdout.write(
                `  ${dim("│")} ${marker} ${itemText}${" ".repeat(padLen)}${dim("│")}\n`,
              );
            }
            process.stdout.write(`  ${dim("└")}${dim("─".repeat(todoW))}${dim("┘")}\n\n`);
            spinner.start("thinking");
            break;
          }

          case "plan_created": {
            spinner.stop();
            if (isStreaming) {
              process.stdout.write("\n");
              isStreaming = false;
            }
            const planW = Math.min((process.stdout.columns ?? 80) - 4, 62);
            process.stdout.write(`\n  ${dim("┌")}${dim("─".repeat(planW))}${dim("┐")}\n`);
            process.stdout.write(
              `  ${dim("│")} ${dim("§ PLAN")}${" ".repeat(Math.max(0, planW - 9))}${dim("│")}\n`,
            );
            process.stdout.write(`  ${dim("├")}${dim("─".repeat(planW))}${dim("┤")}\n`);
            const numerals = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
            for (const step of event.plan.steps) {
              const num = numerals[step.index] ?? `${step.index + 1}`;
              const deps = step.dependsOn.length > 0 ? ` (after ${step.dependsOn.join(",")})` : "";
              const stepText = `${num}. ${step.description}${deps}`;
              const truncStep = stepText.slice(0, planW - 4);
              process.stdout.write(
                `  ${dim("│")} ${vermillion(`${num}.`)} ${step.description.slice(0, planW - num.length - 7)}${deps}${" ".repeat(Math.max(0, planW - truncStep.length - 3))}${dim("│")}\n`,
              );
            }
            process.stdout.write(`  ${dim("└")}${dim("─".repeat(planW))}${dim("┘")}\n\n`);
            spinner.start("executing");
            break;
          }

          case "step_started": {
            spinner.stop();
            const numerals = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
            const num = numerals[event.stepIndex] ?? `${event.stepIndex + 1}`;
            process.stdout.write(
              `\n  ${brass("\u203A")} ${bold(`Step ${num}:`)} ${event.description}\n`,
            );
            spinner.start("executing");
            break;
          }

          case "step_completed": {
            spinner.stop();
            const mark = event.result.success ? green("✓") : vermillion("✕");
            process.stdout.write(`  ${mark} ${dim(event.result.summary.slice(0, 120))}\n`);
            break;
          }

          case "plan_completed": {
            spinner.stop();
            const completed = event.plan.steps.filter(
              (s: { status: string }) => s.status === "completed",
            ).length;
            const total = event.plan.steps.length;
            const status =
              event.plan.status === "completed" ? green("completed") : vermillion("failed");
            process.stdout.write(
              `\n  ${dim("§ RESULT")} ${status} ${dim(`(${completed}/${total} steps)`)}\n`,
            );
            break;
          }

          case "replanning": {
            spinner.stop();
            process.stdout.write(
              `\n  ${brass("↻")} ${dim("replanning after step")} ${event.failedStep} ${dim("failed…")}\n`,
            );
            spinner.start("planning");
            break;
          }

          case "plan_updated": {
            spinner.stop();
            process.stdout.write(`\n  ${dim("§ REVISED PLAN")} ${dim(event.reason)}\n`);
            const numerals = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
            for (const step of event.plan.steps) {
              const num = numerals[step.index] ?? `${step.index + 1}`;
              process.stdout.write(`  ${vermillion(`${num}.`)} ${step.description}\n`);
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
              `\n  ${dim(`↳ ${event.totalTurns} turns · $${cost.toFixed(4)}`)}\n\n`,
            );
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
            const isRateLimit = rawErr.includes("429") || rawErr.toLowerCase().includes("rate limit") || rawErr.toLowerCase().includes("quota");
            if (isRateLimit) {
              errDisplay = errDisplay.split("\n")[0].slice(0, 120);
            }
            process.stdout.write(`\n  ${vermillion("✕")} ${errDisplay}\n`);
            if (isRateLimit) {
              process.stdout.write(`  ${dim("→")} ${brass("Tip:")} ${dim("Try switching models:")} ${cyanotype("/model")}\n`);
              process.stdout.write(`  ${dim("  or use:")} ${brass("alan --model gemini-2.5-flash")}\n`);
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
