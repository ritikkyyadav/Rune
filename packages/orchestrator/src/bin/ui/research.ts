// ─── Research mode rendering ───
// Pure string builders for the /research flow, shared by the classic CLI and
// the TUI. Plan/clarification are rendered at the approval gate; the streaming
// progress events go through formatResearchEvent (mirrors events.ts).

import { bold, text, muted, faint, info, ok, accent, warn } from "./theme";
import { wrap, termWidth } from "./render";
import type {
  ResearchClarification,
  ResearchEvent,
  ResearchPlan,
  ResearchReport,
  SourceScope,
} from "../../research-types";

const NUMERALS = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
const num = (i: number): string => NUMERALS[i] ?? `${i + 1}`;

function scopeTag(scope: SourceScope): string {
  const color = scope === "local" ? ok : scope === "both" ? warn : info;
  return `${faint("[")}${color(scope)}${faint("]")}`;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

/** The proposed plan, shown at the approval gate. Wraps long lines. */
export function renderResearchPlan(plan: ResearchPlan): string {
  const w = Math.max(40, Math.min(termWidth() - 8, 92));
  const rows: string[] = [`  ${muted("•")} ${bold(text("Research plan"))}`];
  for (const ln of wrap(plan.question, w)) rows.push(`  ${faint(ln)}`);
  if (plan.clarification) {
    rows.push("");
    for (const ln of wrap(plan.clarification, w)) rows.push(`  ${muted(ln)}`);
  }
  rows.push("");
  for (const sq of plan.subQuestions) {
    const head = wrap(sq.question, w - 8);
    rows.push(
      `    ${warn(`${num(sq.index)}.`)} ${scopeTag(sq.sourceScope)} ${text(head[0] ?? "")}`,
    );
    for (const ln of head.slice(1)) rows.push(`        ${text(ln)}`);
    if (sq.rationale) {
      for (const ln of wrap(sq.rationale, w - 8)) rows.push(`        ${faint(ln)}`);
    }
  }
  const scopes = new Set(plan.subQuestions.map((s) => s.sourceScope));
  rows.push("");
  rows.push(
    `  ${faint(
      `${plan.subQuestions.length} sub-question${plan.subQuestions.length === 1 ? "" : "s"} · sources: ${[...scopes].join(", ")}`,
    )}`,
  );
  return rows.join("\n");
}

/** Clarifying questions shown before planning when the request is ambiguous. */
export function renderClarifyingQuestions(clar: ResearchClarification): string {
  const w = Math.max(40, Math.min(termWidth() - 8, 92));
  const rows: string[] = [`  ${muted("•")} ${bold(text("A few quick questions first"))}`];
  clar.questions.forEach((q, i) => {
    const lines = wrap(q, w - 6);
    rows.push(`    ${warn(`${i + 1}.`)} ${text(lines[0] ?? "")}`);
    for (const ln of lines.slice(1)) rows.push(`       ${text(ln)}`);
  });
  return rows.join("\n");
}

/** A one-line summary printed when a research run finishes. */
export function renderResearchComplete(report: ResearchReport): string {
  const parts = [
    `${report.sources.length} source${report.sources.length === 1 ? "" : "s"}`,
    `${report.completed}/${report.subResults.length} sub-questions`,
  ];
  if (report.failed > 0) parts.push(accent(`${report.failed} failed`));
  const rows = [`  ${muted("•")} ${bold(text("Report ready"))}  ${faint(parts.join(" · "))}`];
  for (const w of report.warnings) rows.push(`    ${warn("!")} ${muted(w)}`);
  return rows.join("\n");
}

/**
 * A streamed research progress event → transcript line, or null for events
 * rendered elsewhere (research_report_delta streams as raw text; research_plan
 * is drawn at the gate).
 */
export function formatResearchEvent(ev: ResearchEvent): string | null {
  switch (ev.type) {
    case "research_step_start":
      return `  ${muted("•")} ${bold(text("Investigating"))} ${warn(`${num(ev.index)}.`)} ${scopeTag(ev.sourceScope)} ${muted(ev.question)}`;

    case "research_source":
      return `    ${faint("└")} ${info(`[${ev.sourceIndex}]`)} ${text(ev.title.slice(0, 70))} ${faint(ev.fetched ? `(${host(ev.url)} ✓)` : `(${host(ev.url)})`)}`;

    case "research_step_done": {
      const mark = ev.status === "ok" ? ok("✓") : ev.status === "empty" ? faint("∅") : accent("✕");
      const label =
        ev.status === "empty"
          ? "no new sources"
          : `${ev.sourceCount} source${ev.sourceCount === 1 ? "" : "s"}`;
      return `    ${mark} ${muted(`${num(ev.index)}. ${label}`)}`;
    }

    case "research_synthesizing":
      return `  ${muted("•")} ${bold(text("Synthesizing"))} ${faint(`from ${ev.sourceCount} source${ev.sourceCount === 1 ? "" : "s"}…`)}`;

    case "research_complete":
      return renderResearchComplete(ev.report);

    case "notice":
      return `  ${warn("•")} ${muted(ev.message)}`;

    default:
      // research_plan (gate), research_report_delta (streamed), error (caller)
      return null;
  }
}
