// ─── The Decision Record ───
//
// The one artifact a person reads top to bottom when they want to know whether
// to believe the answer. Six sections, in the order a reader needs them:
//
//   Objective       what was asked, verbatim
//   Decision        what the run committed to, and the evidence under it
//   How we got here every hypothesis in order, refuted ones KEPT with reasons
//   What changed    the artifacts
//   Checks          the evidence ledger — which command, exit code, duration
//   What remains    open steps and decisions still waiting on a person
//
// Generated deterministically from `TaskState`. No model call, no summary, no
// paraphrase: every line is something the run recorded while it was running,
// which is what makes the record checkable rather than a second account of the
// work written by the same model that did it.
//
// The refuted branches are the section that does not exist anywhere else. A
// run that tried three things and reports only the one that worked has hidden
// the two that make the third believable — and hidden the cost of the answer.

import type {
  CheckRecord,
  DecisionRecord,
  Hypothesis,
  PendingDecision,
  TaskArtifact,
  TaskDecision,
  TaskKind,
} from "@rune/protocol";
import type { TaskState } from "./task-state";

/** The record for one task, from its state. Pure. */
export function buildDecisionRecord(
  taskId: string,
  state: TaskState,
  now: Date = new Date(),
): DecisionRecord {
  const decisions: TaskDecision[] = state.narrative?.decisions ?? [];
  const hypotheses: Hypothesis[] = state.narrative?.hypotheses ?? [];
  const artifacts: TaskArtifact[] = state.artifacts ?? [];
  const checks: CheckRecord[] = state.checks ?? [];
  const pending: PendingDecision[] = (state.pendingDecisions ?? []).filter((p) => !p.resolution);
  const openSteps = state.todos.filter((t) => t.status !== "completed").map((t) => t.content);

  return {
    taskId,
    objective: state.goal,
    ...(state.kind ? { kind: state.kind as TaskKind } : {}),
    // The LAST decision is the one the run committed to: a long task can commit
    // more than once, and the later commitment supersedes the earlier. Both are
    // kept below, in order, so a reader can see it change its mind.
    decision: decisions.length > 0 ? decisions[decisions.length - 1] : null,
    decisions,
    hypotheses,
    artifacts,
    checks,
    remains: { openSteps, pending },
    ...(state.progress != null ? { progress: state.progress } : {}),
    generatedAt: now.toISOString(),
  };
}

/** True when there is enough on the record to be worth showing. */
export function hasRecord(record: DecisionRecord): boolean {
  return (
    record.decisions.length > 0 ||
    record.hypotheses.length > 0 ||
    record.artifacts.length > 0 ||
    record.checks.length > 0
  );
}

const KIND_LABEL: Record<TaskKind, string> = {
  investigate: "Investigation",
  build: "Build",
  analyze: "Analysis",
  research: "Research",
  operate: "Operation",
  write: "Writing",
};

function evidenceLine(refs: DecisionRecord["decisions"][number]["basedOn"]): string {
  if (refs.length === 0) return "_no evidence cited_";
  return refs.map((e) => `\`${e.kind}: ${e.ref}\`${e.detail ? ` — ${e.detail}` : ""}`).join("; ");
}

/**
 * The record as Markdown. `rune audit --record` prints it, the session export
 * embeds it, and both get the same bytes — one rendering, so a person reading
 * an export and a person reading the terminal are reading the same document.
 */
export function renderDecisionRecordMarkdown(record: DecisionRecord): string {
  const lines: string[] = [];
  const kind = record.kind ? KIND_LABEL[record.kind] : "Task";
  lines.push(`# Decision record — ${kind.toLowerCase()}`, "");

  lines.push("## Objective", "");
  lines.push(record.objective.trim() || "_(no goal recorded)_", "");

  lines.push("## Decision", "");
  if (record.decision) {
    lines.push(record.decision.text, "");
    lines.push(`Evidence: ${evidenceLine(record.decision.basedOn)}`, "");
    if (record.decisions.length > 1) {
      lines.push("Earlier decisions this task:", "");
      for (const d of record.decisions.slice(0, -1)) {
        lines.push(`- ${d.text} — ${evidenceLine(d.basedOn)}`);
      }
      lines.push("");
    }
  } else {
    // Never a blank section and never an invented one: the absence IS the
    // finding, and a reader should see that no commitment was recorded.
    lines.push("_No decision was recorded for this task._", "");
  }

  lines.push("## How we got here", "");
  if (record.hypotheses.length === 0) {
    lines.push("_No hypotheses were recorded._", "");
  } else {
    record.hypotheses.forEach((h, i) => {
      const verdict = h.status === "confirmed" ? "**confirmed**" : h.status;
      lines.push(
        `${i + 1}. ${h.text} — ${verdict}${h.reason ? `: ${h.reason}` : ""}` +
          (h.evidence.length > 0
            ? ` (${h.evidence.map((e) => `${e.kind}: ${e.ref}`).join("; ")})`
            : ""),
      );
    });
    lines.push("");
  }

  lines.push("## What changed", "");
  if (record.artifacts.length === 0) {
    lines.push("_Nothing was produced._", "");
  } else {
    for (const a of record.artifacts) lines.push(`- ${a.kind}: \`${a.ref}\``);
    lines.push("");
  }

  lines.push("## Checks", "");
  if (record.checks.length === 0) {
    lines.push("_No verification-shaped command ran._", "");
  } else {
    lines.push("| command | verdict | exit | duration | ran by |");
    lines.push("| ------- | ------- | ---- | -------- | ------ |");
    for (const c of record.checks) {
      lines.push(
        `| \`${c.command}\` | ${c.passed ? "passed" : "FAILED"} | ${c.exitCode ?? "—"} | ` +
          `${c.durationMs != null ? `${(c.durationMs / 1000).toFixed(1)}s` : "—"} | ${c.source} |`,
      );
    }
    lines.push("");
  }

  lines.push("## What remains", "");
  const nothing = record.remains.openSteps.length === 0 && record.remains.pending.length === 0;
  if (nothing) {
    lines.push("_Nothing: every planned step closed and no decision is waiting._", "");
  } else {
    for (const step of record.remains.openSteps) lines.push(`- step: ${step}`);
    for (const p of record.remains.pending) lines.push(`- ${p.kind}: ${p.summary}`);
    lines.push("");
  }

  if (record.progress != null) {
    lines.push(
      `_${Math.round(record.progress * 100)}% of planned steps closed on evidence · ` +
        `generated ${record.generatedAt}_`,
      "",
    );
  } else {
    lines.push(`_Generated ${record.generatedAt}_`, "");
  }

  return lines.join("\n");
}
