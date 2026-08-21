// ─── Gear status line ───
// The wording is stable and phase-specific. Progress should feel predictable,
// not like a slot machine cycling through novelty verbs.

import { bold, text, faint, ok, stripAnsi } from "./ui/theme";
import { HEX } from "./ui/turn";

type ActivityType =
  | "thinking"
  | "reading"
  | "writing"
  | "executing"
  | "searching"
  | "planning"
  | "verifying"
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

  start(activity: ActivityType = "thinking"): void {
    if (this.running) this.stop();
    this.running = true;
    this.activity = activity;
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
    const labels: Record<ActivityType, string> = {
      thinking: "Understanding",
      reading: "Reading context",
      writing: "Applying changes",
      executing: "Running command",
      searching: "Searching",
      planning: "Planning",
      verifying: "Verifying",
      tool_call: "Working",
    };
    const line = `  ${ok(HEX)} ${bold(text(labels[this.activity]))} ${faint(`· ${meta}`)}`;
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
