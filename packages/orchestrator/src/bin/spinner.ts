// ─── Alan Status Spinner ───
// The live status line: "⬢ Cooking… (12s · ctrl+c to interrupt)". The hexagon
// stays steady; the working word is drawn per run and slowly rotates
// (Claude-style) so a long turn reads as alive — and a little fun.

import { bold, text, faint, ok, stripAnsi } from "./ui/theme";
import { HEX, cookingVerb } from "./ui/turn";

type ActivityType =
  | "thinking"
  | "reading"
  | "writing"
  | "executing"
  | "searching"
  | "planning"
  | "tool_call";

// Map tool names to activity types (kept for callers that drive the spinner).
function toolToActivity(toolName: string): ActivityType {
  switch (toolName) {
    case "read_file":
    case "list_dir":
      return "reading";
    case "grep":
      return "searching";
    case "write_file":
    case "edit_file":
      return "writing";
    case "bash":
      return "executing";
    default:
      return "tool_call";
  }
}

function formatTime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m${secs % 60}s`;
}

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private tokens = 0;
  private lastLineLen = 0;
  private running = false;
  private activity: ActivityType = "thinking";
  private seed = Math.floor(Math.random() * 1000);

  start(activity: ActivityType = "thinking"): void {
    if (this.running) this.stop();
    this.running = true;
    this.activity = activity;
    // Keep the SAME working word across the stop/start churn of one turn: the
    // seed is time-stable, so restarting a second later doesn't reroll it.
    this.seed = Math.floor(Date.now() / 120_000);
    this.startTime = Date.now();
    this.tokens = 0;
    this.render();
    // Re-render once per second to advance the elapsed timer.
    this.interval = setInterval(() => this.render(), 250);
  }

  setActivity(activity: ActivityType): void {
    this.activity = activity;
  }

  setTool(toolName: string): void {
    this.activity = toolToActivity(toolName);
  }

  addTokens(count: number): void {
    this.tokens += count;
  }

  isRunning(): boolean {
    return this.running;
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.clearLine();
  }

  private render(): void {
    if (!this.running) return;
    const ms = Date.now() - this.startTime;
    const elapsed = formatTime(ms);
    const tokenPart = this.tokens > 0 ? ` · ${this.tokens} tokens` : "";
    const meta = `${elapsed}${tokenPart} · ctrl+c to interrupt`;
    const verb = cookingVerb(this.seed, ms);
    const line = `  ${ok(HEX)} ${bold(text(`${verb}…`))} ${faint(`(${meta})`)}`;
    this.clearLine();
    process.stderr.write(line);
    this.lastLineLen = stripAnsi(line).length;
  }

  private clearLine(): void {
    if (this.lastLineLen > 0) {
      process.stderr.write(`\r${" ".repeat(this.lastLineLen)}\r`);
      this.lastLineLen = 0;
    }
  }
}

export { toolToActivity, type ActivityType };
