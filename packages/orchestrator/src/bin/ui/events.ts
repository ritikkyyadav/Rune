// ─── Pure event → transcript text ───
// Maps a streamed engine event to the block of text to print. Returns null for
// events with no standalone transcript line (text_delta is streamed separately;
// tool_call_start only flips the activity word). Used by the TUI; the readline
// path keeps its own inline copy for now (same visual language).

import { bold, text, muted, faint, info, ok, accent, warn } from "./theme";
import { renderToolCall } from "./tool-call";
import { formatResearchEvent } from "./research";

const NUMERALS = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
const num = (i: number) => NUMERALS[i] ?? `${i + 1}`;

export function formatError(raw: string | undefined): string {
  let msg = raw ?? "Unknown error";
  if (msg.includes('"error"') || msg.length > 200) {
    try {
      const parsed = JSON.parse(msg.slice(msg.indexOf("{")));
      msg = parsed.error?.message?.split("\n")[0] ?? msg.slice(0, 150);
    } catch {
      msg = msg.slice(0, 150);
    }
  }
  const rateLimited =
    msg.includes("429") ||
    msg.toLowerCase().includes("rate limit") ||
    msg.toLowerCase().includes("quota");
  let out = `  ${accent("✕")} ${text(rateLimited ? msg.split("\n")[0].slice(0, 120) : msg)}`;
  if (rateLimited) {
    out += `\n  ${faint("→")} ${warn("Tip:")} ${muted("Try switching models:")} ${info("/model")}`;
  }
  return out;
}

/** A completed engine event rendered as transcript text, or null if none. */
export function formatEvent(ev: any, ctx: { cost?: number } = {}): string | null {
  switch (ev.type) {
    case "tool_call_end":
      return renderToolCall({
        toolName: ev.output.toolName,
        args: ev.args,
        result: ev.output.result,
        success: ev.output.success,
        error: ev.output.error,
        durationMs: ev.output.durationMs,
      });

    case "todo_updated": {
      const rows = [`  ${muted("•")} ${bold(text("Updated plan"))}`];
      for (const item of ev.items) {
        const marker =
          item.status === "completed" ? ok("✓") : item.status === "in_progress" ? warn("▸") : faint("□");
        const label = item.status === "in_progress" ? text(item.content) : muted(item.content);
        rows.push(`    ${marker} ${label}`);
      }
      return rows.join("\n");
    }

    case "plan_created": {
      const rows = [`  ${muted("•")} ${bold(text("Plan"))}`];
      for (const step of ev.plan.steps) {
        const deps = step.dependsOn.length > 0 ? faint(` (after ${step.dependsOn.join(",")})`) : "";
        rows.push(`    ${warn(`${num(step.index)}.`)} ${text(step.description)}${deps}`);
      }
      return rows.join("\n");
    }

    case "step_started":
      return `  ${muted("•")} ${bold(text(`Step ${num(ev.stepIndex)}`))}  ${muted(ev.description)}`;

    case "step_completed":
      return `    ${ev.result.success ? ok("✓") : accent("✕")} ${muted(ev.result.summary.slice(0, 120))}`;

    case "plan_completed": {
      const completed = ev.plan.steps.filter((s: { status: string }) => s.status === "completed").length;
      const total = ev.plan.steps.length;
      const status = ev.plan.status === "completed" ? ok("completed") : accent("failed");
      return `  ${muted("•")} ${bold(text("Result"))} ${status} ${faint(`(${completed}/${total} steps)`)}`;
    }

    case "replanning":
      return `  ${warn("•")} ${muted("Replanning after step")} ${warn(String(ev.failedStep))} ${muted("failed…")}`;

    case "plan_updated": {
      const rows = [`  ${muted("•")} ${bold(text("Revised plan"))}  ${faint(ev.reason)}`];
      for (const step of ev.plan.steps) {
        rows.push(`    ${warn(`${num(step.index)}.`)} ${text(step.description)}`);
      }
      return rows.join("\n");
    }

    case "turn_complete":
      return `  ${faint(`↳ ${ev.totalTurns} turns · $${(ctx.cost ?? 0).toFixed(4)}`)}`;

    case "notice":
    case "context_warning":
      return `  ${warn("•")} ${muted(ev.message)}`;

    case "research_step_start":
    case "research_source":
    case "research_step_done":
    case "research_synthesizing":
    case "research_complete":
      return formatResearchEvent(ev);

    case "error":
      return formatError(ev.error);

    default:
      return null; // text_delta, tool_call_start, research_report_delta, etc.
  }
}
