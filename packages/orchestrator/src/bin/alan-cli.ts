#!/usr/bin/env bun
import { Engine } from "../engine";
import type { PermissionHandler, UserPermissionDecision } from "../engine";
import { loadConfig } from "@alan/shared";
import { parseArgs } from "util";
import * as readline from "readline";
import { Spinner } from "./spinner";
import { renderWelcome } from "./welcome";
import { renderEditResult, renderWriteResult } from "./diff-render";

// ─── CLI Argument Parsing ───

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    model: { type: "string", short: "m", default: "deepseek/deepseek-v4-flash:free" },
    provider: { type: "string", short: "p", default: "openrouter" },
    workspace: { type: "string", short: "w" },
    yolo: { type: "boolean", default: false },
    planner: { type: "boolean", default: false },
    "planner-model": { type: "string" },
    "executor-model": { type: "string" },
    resume: { type: "string", short: "r" },
    list: { type: "boolean", short: "l", default: false },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0] ?? "chat";

// ─── Resolve Tool Binary ───

async function findToolsBinary(): Promise<string> {
  // 1. Check env var (set by bin/alan launcher)
  const envPath = process.env.ALAN_TOOLS_BIN;
  if (envPath) {
    const envFile = Bun.file(envPath);
    if (await envFile.exists()) return envPath;
  }

  // 2. Check relative paths from source tree
  const devPath = new URL(
    "../../../../target/release/alan-tools",
    import.meta.url,
  ).pathname;
  const debugPath = new URL(
    "../../../../target/debug/alan-tools",
    import.meta.url,
  ).pathname;

  const file1 = Bun.file(devPath);
  if (await file1.exists()) return devPath;
  const file2 = Bun.file(debugPath);
  if (await file2.exists()) return debugPath;

  // 3. Hope it's on PATH
  return "alan-tools";
}

// ─── Ensure Data Directory ───

function ensureDataDir(): string {
  const dir = `${process.env.HOME}/.alan`;
  const fs = require("fs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Colors ───

const esc = (code: string) => `\x1b[${code}m`;
const reset = esc("0");
const dim = (s: string) => `${esc("2")}${s}${reset}`;
const bold = (s: string) => `${esc("1")}${s}${reset}`;
const green = (s: string) => `${esc("32")}${s}${reset}`;
const yellow = (s: string) => `${esc("33")}${s}${reset}`;
const red = (s: string) => `${esc("31")}${s}${reset}`;
const cyan = (s: string) => `${esc("36")}${s}${reset}`;
const indigo = (s: string) => `${esc("38;5;105")}${s}${reset}`;

// ─── Main ───

async function main() {
  const dataDir = ensureDataDir();
  const toolsBinary = await findToolsBinary();
  const workspaceRoot = (values.workspace as string | undefined) ?? process.cwd();

  // Load config from ~/.alan/config.toml + .alan/config.toml + env vars
  const config = loadConfig(workspaceRoot);

  // CLI flags override config file values
  const model = (values.model as string | undefined) ?? config.llm.anthropic?.model ?? "deepseek/deepseek-v4-flash:free";
  const provider = (values.provider as string | undefined) ?? config.llm.defaultProvider ?? "openrouter";

  const plannerMode = values.planner as boolean;
  const engine = new Engine({
    model,
    provider: provider as "anthropic" | "openai" | "openrouter",
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
  });

  if (command === "list" || values.list) {
    const sessions = engine.listSessions();
    if (sessions.length === 0) {
      console.log(dim("No sessions found."));
    } else {
      console.log(bold("Sessions:\n"));
      for (const s of sessions) {
        console.log(
          `  ${cyan(s.id.slice(0, 8))}  ${s.workspaceRoot}  ${dim(`${s.eventCount} events`)}  ${dim(s.model)}`,
        );
      }
    }
    engine.close();
    return;
  }

  // Create or resume session
  const sessionId = values.resume as string ?? engine.createSession();

  // ─── Welcome Screen ───
  const recentSessions = engine
    .listSessions()
    .filter((s) => s.id !== sessionId);

  process.stdout.write(
    "\n" +
      renderWelcome({
        model: values.model as string,
        sessionId,
        workspace: workspaceRoot,
        version: "0.1.0",
        recentSessions,
      }) +
      "\n\n",
  );

  const spinner = new Spinner();
  const yoloMode = values.yolo as boolean;

  // ─── Input Panel ───
  // Draws top ─── line, prompt, bottom ─── line, and status bar.
  // Cursor sits on the prompt line between the two dividers.

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: ` ${indigo("\u276F")} `,
  });

  // \u2500\u2500\u2500 Permission Handler \u2500\u2500\u2500
  // Pauses the agent and asks the user before any confirm/sandbox tool runs.
  // Default on unknown / empty input is DENY (safer).

  const permissionHandler: PermissionHandler = (prompt) =>
    new Promise<UserPermissionDecision>((resolve) => {
      const wasSpinning = spinner.isRunning?.() ?? false;
      spinner.stop();

      const header = `\n  ${yellow("\u25C6")} ${bold("Permission required")}`;
      const toolLine = `  ${dim("tool")}  ${cyan(prompt.toolName)}`;
      const argsLine = `  ${dim("args")}  ${prompt.argsSummary}`;
      const opts = `  ${green("[a]")} Allow once    ${green("[s]")} Allow for session    ${red("[d]")} Deny  ${dim("(default)")}`;
      process.stdout.write(`${header}\n${toolLine}\n${argsLine}\n\n${opts}\n`);

      rl.question(`  ${indigo("\u203A")} `, (answer) => {
        const a = answer.trim().toLowerCase();
        let decision: UserPermissionDecision;
        if (a === "s" || a === "session") decision = { kind: "allow_session" };
        else if (a === "a" || a === "allow" || a === "y" || a === "yes")
          decision = { kind: "allow_once" };
        else decision = { kind: "deny" };

        if (decision.kind === "deny") {
          process.stdout.write(`  ${red("\u2717")} denied\n`);
        } else if (decision.kind === "allow_session") {
          process.stdout.write(
            `  ${green("\u2713")} ${dim("granted for this session")}\n`,
          );
        } else {
          process.stdout.write(`  ${green("\u2713")} ${dim("granted once")}\n`);
        }

        if (wasSpinning) spinner.start("tool_call");
        resolve(decision);
      });
    });

  if (!yoloMode) {
    engine.setPermissionHandler(permissionHandler);
  }

  function showPrompt() {
    const w = process.stdout.columns ?? 80;
    const line = dim("\u2500".repeat(w));
    const mode = yoloMode
      ? "  " + green("\u25B8\u25B8") + " " + green("yolo mode")
      : "  " + dim("\u25B8\u25B8") + " " + dim("permissions: ask");

    // Draw:  top line → [prompt line] → bottom line → status
    process.stdout.write(line + "\n");        // top divider
    process.stdout.write("\n");               // skip prompt line
    process.stdout.write(line + "\n");        // bottom divider
    process.stdout.write(mode);               // status (no trailing \n)
    process.stdout.write("\x1b[2A\r");        // cursor up 2 → prompt line col 0
    rl.prompt();
  }

  // ─── Paste Detection ───
  // Accumulates rapid lines (< 50ms apart) as a single multi-line input

  let pasteBuffer: string[] = [];
  let pasteTimer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

  showPrompt();

  rl.on("line", (line: string) => {
    if (busy) return;

    pasteBuffer.push(line);
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
      const input = pasteBuffer.join("\n").trim();
      pasteBuffer = [];
      pasteTimer = null;
      handleInput(input).catch((err) => {
        console.error(red(`\n  Fatal: ${err instanceof Error ? err.message : err}\n`));
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

    // After Enter, cursor is on the bottom divider line.
    // Move past bottom divider + status line before writing output.
    process.stdout.write("\n\n");

    if (input === "/quit" || input === "/exit") {
      console.log(dim("  Goodbye.\n"));
      engine.close();
      process.exit(0);
    }

    if (input === "/cost") {
      console.log(dim(`  Total cost: $${engine.getCost().toFixed(4)}\n`));
      showPrompt();
      return;
    }

    busy = true;

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
              `\n  ${dim("\u250c\u2500\u2500")} ${yellow(event.toolName)} ${dim("\u2500".repeat(Math.max(1, 40 - event.toolName.length)))}\n`,
            );
            spinner.start("tool_call");
            spinner.setTool(event.toolName);
            break;
          }

          case "tool_call_end": {
            spinner.stop();
            if (event.output.success) {
              process.stdout.write(
                `  ${dim("\u2514\u2500\u2500")} ${green("\u2713")} ${dim(`done in ${event.output.durationMs}ms`)}\n`,
              );

              // Pretty-print diffs for edit_file / write_file
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
                  // result was not JSON \u2014 leave as-is
                }
              }
            } else {
              process.stdout.write(
                `  ${dim("\u2514\u2500\u2500")} ${red("\u2717")} ${red(event.output.error ?? "failed")}\n`,
              );
            }
            spinner.start("thinking");
            break;
          }

          case "plan_created": {
            spinner.stop();
            if (isStreaming) {
              process.stdout.write("\n");
              isStreaming = false;
            }
            process.stdout.write(`\n  ${bold(cyan("Plan:"))}\n`);
            for (const step of event.plan.steps) {
              const deps = step.dependsOn.length > 0 ? dim(` (after ${step.dependsOn.join(",")})`) : "";
              process.stdout.write(
                `  ${dim(`${step.index}.`)} \u2610 ${step.description}${deps}\n`,
              );
            }
            process.stdout.write("\n");
            spinner.start("executing");
            break;
          }

          case "step_started": {
            spinner.stop();
            process.stdout.write(
              `\n  ${yellow("\u25B6")} ${bold(`Step ${event.stepIndex}:`)} ${event.description}\n`,
            );
            spinner.start("executing");
            break;
          }

          case "step_completed": {
            spinner.stop();
            const mark = event.result.success ? green("\u2713") : red("\u2717");
            process.stdout.write(
              `  ${mark} ${dim(event.result.summary.slice(0, 120))}\n`,
            );
            break;
          }

          case "plan_completed": {
            spinner.stop();
            const completed = event.plan.steps.filter((s: { status: string }) => s.status === "completed").length;
            const total = event.plan.steps.length;
            const status = event.plan.status === "completed" ? green("completed") : red("failed");
            process.stdout.write(
              `\n  ${bold("Plan")} ${status} ${dim(`(${completed}/${total} steps)`)}\n`,
            );
            break;
          }

          case "replanning": {
            spinner.stop();
            process.stdout.write(
              `\n  ${yellow("\u21BB")} ${dim("Replanning after step")} ${event.failedStep} ${dim("failed...")}\n`,
            );
            spinner.start("planning");
            break;
          }

          case "plan_updated": {
            spinner.stop();
            process.stdout.write(`\n  ${bold(cyan("Revised Plan:"))} ${dim(event.reason)}\n`);
            for (const step of event.plan.steps) {
              process.stdout.write(
                `  ${dim(`${step.index}.`)} \u2610 ${step.description}\n`,
              );
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
              `\n  ${dim(`\u2500\u2500\u2500 ${event.totalTurns} turns \u00b7 $${cost.toFixed(4)}`)}\n\n`,
            );
            break;
          }

          case "error": {
            spinner.stop();
            isStreaming = false;
            process.stdout.write(red(`\n  Error: ${event.error}`) + "\n\n");
            break;
          }
        }
      }
    } catch (err) {
      spinner.stop();
      console.error(red(`\n  Fatal: ${err instanceof Error ? err.message : err}\n`));
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
}

main().catch((err) => {
  console.error(red(`Fatal error: ${err.message}`));
  process.exit(1);
});
