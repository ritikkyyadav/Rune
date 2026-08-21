// ─── Pure event → transcript text ───
// Maps a streamed engine event to the block of text to print. Returns null for
// events with no standalone transcript line (text_delta is streamed separately;
// tool_call_start only flips the activity word). Used by the TUI; the readline
// path keeps its own inline copy for now (same visual language).

import { bold, text, muted, faint, info, ok, accent, warn, tintSurface } from "./theme";
import { meterGlyphs, railCard, termWidth, visLen, wrap } from "./render";
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

/**
 * Render an engine notice. Provider-fallback notices ("X unavailable — Y. Switching to Z…")
 * are the noisy, repeated case: collapse them to a compact `↻ from → to · reason` line so a
 * chain of retries stays scannable instead of stacking up as full-width sentences. Anything
 * else keeps the plain bullet.
 */
export function formatNotice(message: string): string {
  const m = message.match(/^(.+?) unavailable(?: — (.+?))?\.\s*Switching to (.+?)…?$/);
  if (m) {
    const [, from, reason, to] = m;
    const why = reason ? `  ${faint("· " + reason)}` : "";
    return `  ${faint("↻")} ${muted(from)} ${faint("→")} ${info(to)}${why}`;
  }
  return `  ${warn("•")} ${muted(message)}`;
}

export const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

/** Reading measure shared by the fallback card and compaction receipt. */
function cardWidth(): number {
  return Math.max(16, Math.min(100, termWidth() - 3));
}

/**
 * The v2 provider-fallback card (`.fallback-card`): a red-railed, red-washed
 * block stating what degraded, the chain the gateway walked, where the stream
 * resumed, and the honest promise that the turn continues. Built from the
 * gateway's structured event, never from regex-parsed prose.
 */
export function formatFallback(ev: {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  status?: number;
  reason?: string;
  chain?: string[];
}): string {
  const status = ev.status === 429 ? "429 (rate limited)" : ev.status ? String(ev.status) : "";
  // Skip the reason when the status text already says the same thing
  // ("429 (rate limited) — rate limited" reads like a stutter).
  const reason =
    ev.reason && !status.toLowerCase().includes(ev.reason.toLowerCase().slice(0, 12))
      ? ev.reason
      : "";
  const from = `${ev.from.provider}/${ev.from.model}`;
  const to = `${ev.to.provider}/${ev.to.model}`;
  const what = status
    ? `${from} returned ${status}${reason ? ` — ${reason}` : ""}.`
    : reason
      ? `${from} failed — ${reason}.`
      : `${from} is unavailable.`;
  const rest = (ev.chain ?? []).filter((p) => p !== ev.to.provider && p !== ev.from.provider);
  const chain = [ev.from.provider, ev.to.provider, ...rest].join(" → ");
  const width = cardWidth();
  const inner = width - 3;
  // Rows wrap rather than truncate: every clause of the card is a promise the
  // user should be able to read in full, even at 80 columns.
  const rows = [
    `${accent("◆")} ${bold(accent("Provider degraded — gateway fallback engaged"))}`,
    ...wrap(`${what} Falling back per provider chain.`, inner).map((line) => muted(line)),
    ...packRow(
      [
        `${faint("chain:")} ${muted(chain)}`,
        `${ok("✓")} ${bold(ok(`resumed on ${to}`))}`,
        faint("turn continues · nothing lost"),
      ],
      inner,
    ),
  ];
  return railCard(rows, {
    rail: accent,
    surface: (value) => tintSurface("accent", value),
    width,
  }).join("\n");
}

/** Pack painted clauses onto as few rows as fit, three cells apart. */
function packRow(parts: string[], width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const part of parts) {
    const candidate = row ? `${row}   ${part}` : part;
    if (row && visLen(candidate) > width) {
      rows.push(row);
      row = part;
    } else {
      row = candidate;
    }
  }
  if (row) rows.push(row);
  return rows;
}

/**
 * The v2 compaction receipt (`.ctx-compact`, settled state): one accent-washed
 * row per compaction — what was summarized, the before/after occupancy, the
 * five-cell meter at the new level, and the tokens recovered. Percentages
 * derive from the same budget the engine compacts against.
 */
export function formatCompaction(ev: {
  beforeTokens: number;
  afterTokens: number;
  limitTokens: number;
  summarizedCount?: number;
  forced?: boolean;
}): string {
  const pct = (tokens: number): string =>
    ev.limitTokens > 0
      ? `${Math.round((tokens / ev.limitTokens) * 100)}%`
      : `~${fmtTokens(tokens)}`;
  const saved = Math.max(0, ev.beforeTokens - ev.afterTokens);
  const scope =
    ev.summarizedCount && ev.summarizedCount > 0
      ? `${ev.summarizedCount} older ${ev.summarizedCount === 1 ? "message" : "messages"} summarized`
      : "older messages summarized";
  const label = ev.forced ? "compacted (window exceeded)" : "compacted";
  const afterPct = ev.limitTokens > 0 ? (ev.afterTokens / ev.limitTokens) * 100 : 0;
  const width = cardWidth();
  const delta = faint(`−${fmtTokens(saved)} tokens`);
  const range = `context ${pct(ev.beforeTokens)} → ${pct(ev.afterTokens)}`;
  // Degrade gracefully on narrow terminals: drop the meter, then the scope —
  // the occupancy change and the tokens recovered are the facts that matter.
  const candidates = [
    `${ok("✓")} ${bold(ok(label))}  ${muted(`${scope} · ${range}`)}${ev.limitTokens > 0 ? `  ${info(meterGlyphs(afterPct))}` : ""}  ${delta}`,
    `${ok("✓")} ${bold(ok(label))}  ${muted(`${scope} · ${range}`)}  ${delta}`,
    `${ok("✓")} ${bold(ok(label))}  ${muted(range)}  ${delta}`,
  ];
  const row = candidates.find((candidate) => visLen(candidate) <= width - 2) ?? candidates.at(-1)!;
  const fill = " ".repeat(Math.max(0, width - 2 - visLen(row)));
  return `  ${tintSurface("brand", ` ${row}${fill} `)}`;
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
          item.status === "completed"
            ? ok("✓")
            : item.status === "in_progress"
              ? warn("▸")
              : faint("□");
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
      const completed = ev.plan.steps.filter(
        (s: { status: string }) => s.status === "completed",
      ).length;
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
      return formatNotice(ev.message);

    case "fallback":
      return formatFallback(ev);

    case "compaction":
      return formatCompaction(ev);

    case "usage":
    case "checkpoint_saved":
      return null; // live meters / summary strip, not transcript lines

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
