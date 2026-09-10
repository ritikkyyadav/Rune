// --- Pure event -> transcript text ---
// Maps a streamed engine event to the block of text to print. Returns null for
// events with no standalone transcript line (text_delta is streamed separately;
// tool_call_start only flips the activity word). Used by the TUI; the readline
// path keeps its own inline copy for now (same visual language).

import type { AgentTurnEvent, ResearchEvent } from "@rune/protocol";
import { assertNever } from "@rune/protocol";
import { text, muted, faint, info, warn } from "./theme";
import { glyph } from "./glyphs";
import { visLen, wrap } from "./render";
import * as F from "./flow";
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
  // A failure states itself, then the one command that resolves it -- never a
  // warning without a way out.
  return F.note(
    rateLimited ? msg.split("\n")[0].slice(0, 120) : msg,
    undefined,
    rateLimited
      ? { verb: "try", command: "/model  to switch to a provider with headroom" }
      : undefined,
    "fail",
  ).join("\n");
}

/**
 * Render an engine notice. Provider-fallback notices ("X unavailable -- Y. Switching to Z...")
 * are the noisy, repeated case: collapse them to a compact `r from -> to | reason` line so a
 * chain of retries stays scannable instead of stacking up as full-width sentences. Anything
 * else keeps the plain bullet.
 */
export function formatNotice(message: string): string {
  const m = message.match(
    /^(.+?) unavailable(?:\s*(?:--|\u2014)\s*(.+?))?\.\s*Switching to\s+(.+?)(?:\.\.\.|\u2026)?$/,
  );
  if (m) {
    const [, from, reason, to] = m;
    const why = reason ? `  ${faint("| " + reason)}` : "";
    return `${F.BODY}${faint(glyph("retry"))} ${muted(from)} ${faint("->")} ${info(to)}${why}`;
  }
  return wrap(message, F.proseWidth())
    .map((line, index) => `${F.MARK}${index === 0 ? warn("!") : " "} ${muted(line)}`)
    .join("\n");
}

export const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

/**
 * A provider reroute: what degraded, the chain the gateway walked, where the
 * stream resumed, and the honest promise that the turn continues. Built from
 * the gateway's structured event, never from regex-parsed prose.
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
  // ("429 (rate limited) -- rate limited" reads like a stutter).
  const reason =
    ev.reason && !status.toLowerCase().includes(ev.reason.toLowerCase().slice(0, 12))
      ? ev.reason
      : "";
  const from = `${ev.from.provider}/${ev.from.model}`;
  const to = `${ev.to.provider}/${ev.to.model}`;
  const what = status
    ? `${from} returned ${status}${reason ? ` -- ${reason}` : ""}.`
    : reason
      ? `${from} failed -- ${reason}.`
      : `${from} is unavailable.`;
  const rest = (ev.chain ?? []).filter((p) => p !== ev.to.provider && p !== ev.from.provider);
  const chain = [ev.from.provider, ev.to.provider, ...rest].join(" -> ");
  // A reroute is a note, not an alarm: state what degraded, where the stream
  // resumed, and the promise that the turn is intact. Nothing is truncated --
  // every clause here is something the reader is owed in full.
  return F.note(
    "provider degraded -- rerouted mid-turn",
    `${what} Falling back per the provider chain: ${chain}. Resumed on ${to}; the turn continues and nothing was lost.`,
    undefined,
    "warn",
  ).join("\n");
}

export function formatCompaction(ev: {
  beforeTokens: number;
  afterTokens: number;
  limitTokens: number;
  summarizedCount?: number;
  forced?: boolean;
  failed?: boolean;
  failureReason?: string;
}): string {
  const pct = (tokens: number): string =>
    ev.limitTokens > 0
      ? `${Math.round((tokens / ev.limitTokens) * 100)}%`
      : `~${fmtTokens(tokens)}`;
  const saved = Math.max(0, ev.beforeTokens - ev.afterTokens);
  // The compaction did not happen. It is the row that precedes a run dying of
  // an over-limit prompt, and it used to render as an ordinary "compacted"
  // line reporting a saving of zero.
  if (ev.failed === true) {
    return F.flowRow(
      `${F.BODY}${warn("!")} ${text("compaction failed")}  ${muted(ev.failureReason || "the summarizer did not answer")}`,
      muted(`${pct(ev.beforeTokens)} | context unchanged`),
    );
  }
  const scope =
    ev.summarizedCount && ev.summarizedCount > 0
      ? `${ev.summarizedCount} older ${ev.summarizedCount === 1 ? "message" : "messages"} summarized`
      : "older messages summarized";
  const label = ev.forced ? "compacted (window exceeded)" : "compacted";
  // A rescue: the summarizer broke and the deterministic tier carried it. The
  // set really did shrink, so this is a compaction — but saying only that hid
  // a down summarizer behind a healthy-looking row (S-2).
  if (ev.failureReason) {
    // The REASON is the receipt here, not the token delta: flowRow cuts the
    // left side first and keeps the receipt whole, and on this row the news is
    // why no summarizer ran, not how many tokens went.
    return F.flowRow(
      `${F.BODY}${warn("!")} ${text("compacted without a summary")}  ${muted(`${pct(ev.beforeTokens)} -> ${pct(ev.afterTokens)} | -${fmtTokens(saved)} tokens`)}`,
      muted(ev.failureReason),
    );
  }
  // One row, and only facts the engine actually measured.
  return F.flowRow(
    `${F.BODY}${faint(glyph("observed"))} ${text(label)}  ${muted(scope)}`,
    muted(`${pct(ev.beforeTokens)} -> ${pct(ev.afterTokens)} | -${fmtTokens(saved)} tokens`),
  );
}

/** A completed engine event rendered as transcript text, or null if none. */
/**
 * A completed engine event rendered as transcript text, or null when the event
 * has no standalone line.
 *
 * Every member of BOTH unions is named below, including the ones this reducer
 * deliberately renders nothing for, and the switch ends in `assertNever`. That
 * is the point: before Phase 2 this took `any`, so adding a member to
 * `AgentTurnEvent` compiled clean here and printed nothing forever.
 */
export function formatEvent(ev: AgentTurnEvent | ResearchEvent): string | null {
  switch (ev.type) {
    case "replanning":
      // New shape: { reason, trigger } (verification kept failing, or a
      // struggle signal). The legacy PlanRunner { failedStep } shape is gone.
      return F.railRow(
        `${warn("!")} ${muted(`re-planning -- ${ev.reason ?? "changing approach"}`)}`,
      );

    case "handoff": {
      // A run that ended BEFORE finishing: render the honest state-of-work so
      // "ran out of turns" never again looks identical to "done". The reason
      // names the shape: steps left open on purpose, or a run that stalled.
      const label =
        ev.reason === "open_steps"
          ? "ended with planned steps still open"
          : ev.reason === "stalled"
            ? "stopped -- nothing new was happening"
            : "paused before finishing";
      // The state block arrives as prose the spine composed for a model (see
      // task-state.handoffState): a goal that can be a whole paragraph, one
      // line per step, and a `Files touched:` line that is every path joined
      // with commas. It was set down verbatim, and verbatim meant 346 columns
      // on an 80-column window -- the fixed frame clips rather than reflows,
      // so the one block a run that DIED owes the reader was the one block
      // guaranteed to be cut off mid-sentence. It wraps to the measure now,
      // and a step's continuation hangs under the step rather than back at
      // the margin, so the list still reads as a list.
      const lines: string[] = [];
      for (const raw of String(ev.state ?? "").split("\n")) {
        if (!raw.trim()) {
          lines.push("");
          continue;
        }
        const lead = raw.match(/^\s*/)![0];
        // An indented single-character marker and a space is a step line
        // (`  <tick> Audit the repository`); its continuation hangs under the
        // text rather than under the marker. Matched structurally -- the
        // markers themselves are closed-set glyphs and never literals here.
        const hang = lead + (/^\s+\S\s/.test(raw) ? "  " : "");
        const body = raw.slice(lead.length);
        const wrapped = wrap(body, Math.max(16, F.measure() - F.BODY.length - lead.length));
        lines.push(`${F.BODY}${lead}${faint(wrapped[0] ?? "")}`);
        for (const rest of wrapped.slice(1)) lines.push(`${F.BODY}${hang}${faint(rest)}`);
      }
      return [F.railRow(`${warn("!")} ${text(label)}`), ...lines].join("\n");
    }

    // ── The narrative ──
    // A hypothesis is named before it is tested and folded to one line with
    // its reason once it is settled. That fold is the point: a run that tried
    // three things and reports only the one that worked has hidden the part a
    // reader needs to trust the answer.
    case "hypothesis":
      return F.railRow(
        F.flowRow(
          `${faint(glyph("observed"))} ${text(ev.hypothesis.text.slice(0, 100))}`,
          faint(ev.hypothesis.status),
        ),
      );

    case "hypothesis_updated": {
      const mark =
        ev.status === "confirmed"
          ? info(glyph("verified"))
          : ev.status === "refuted"
            ? muted(glyph("failure"))
            : faint(glyph("observed"));
      return F.railRow(
        F.flowRow(
          `${mark} ${muted(`hypothesis ${ev.id}`)} ${text(ev.status)}`,
          ev.reason ? faint(ev.reason.slice(0, 70)) : "",
        ),
      );
    }

    case "decision":
      return F.railRow(
        F.flowRow(
          `${info(glyph("phase"))} ${text(ev.decision.text.slice(0, 100))}`,
          faint(
            ev.decision.basedOn.length > 0
              ? `on ${ev.decision.basedOn.length} piece${ev.decision.basedOn.length === 1 ? "" : "s"} of evidence`
              : "no evidence cited",
          ),
        ),
      );

    case "task_kind":
    case "artifact":
    case "pending_decision":
    case "decision_resolved":
    case "decision_record":
      // The task's shape and the artifact ledger drive the composed surface
      // and `rune audit`, not a transcript line; the pending-decision list is
      // the held-step panel's material, which already draws it; and the record
      // is a document the close offers rather than a row in the scrollback.
      return null;

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

    // ── Named and deliberately not rendered here ──
    // Streamed live by the TUI (turn.ts) rather than committed as a block, or
    // folded into the status rung / live meters. Listed rather than defaulted
    // so a member added upstream cannot slip past this reducer unnoticed.
    //
    // `tool_call_end`, `todo_updated` and `turn_complete` are in this group
    // because turn.ts renders all three ITSELF and never routes them here.
    // Each had a full branch of its own until Phase 2 — three renderers for
    // rows nothing could reach, quietly claiming coverage in the drift law.
    // The labels stay (the law counts labels, and a member that stops being
    // handled anywhere must still be named); the dead renderers are gone.
    //
    // `lifecycle` is a projection, not a row: the TUI reads it into the
    // header, the task bar and the closing summary rather than printing the
    // whole run's state back into the scrollback at every boundary.
    case "tool_call_end":
    case "todo_updated":
    case "turn_complete":
    case "lifecycle":
    case "text_delta":
    case "thinking_delta":
    case "stream_reset":
    case "tool_call_start":
    case "tool_call_args_delta":
    case "tool_progress":
    case "retry":
    case "step_check":
    case "verification_started":
    case "verification_completed":
    case "research_plan":
    case "research_report_delta":
      return null;

    default:
      // Compile-time exhaustiveness. A new union member is a type error here
      // until it is named above; at runtime an event from a NEWER host is
      // ignored rather than thrown, per the additive-minor contract.
      return assertNeverEvent(ev);
  }
}

/** `assertNever` at compile time, a no-op at runtime. See the comment above. */
function assertNeverEvent(ev: never): string | null {
  void (ev as unknown);
  void assertNever;
  return null;
}
