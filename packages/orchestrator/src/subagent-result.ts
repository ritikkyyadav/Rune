import { isAbsolute, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";

import type { LlmGateway, ProviderName, ResponseFormat } from "@rune/llm-gateway";
import type { TaskLifecycleChild, TaskLifecycleStatus } from "@rune/protocol";

/**
 * The delegation result contract.
 *
 * Both sub-agent kinds returned free text. `ToolSchema.outputSchema` was
 * declared and never populated; `ResponseFormat` existed and was used only by
 * research. What a delegating parent actually received was "the text after the
 * last `tool_call_start`", and when there was none it received nothing at all —
 * 33 of 68 recorded `task` calls. `partialReport` and `buildManifest` were
 * hand-rolled prose written to survive that, and they worked, but they were
 * substitutes for a type.
 *
 * This is the type. The two prose builders become renderers over it, which
 * means they can no longer disagree with the object the parent is handed, and
 * the doctrine paragraph telling the model how to shape its summary shrinks to
 * a schema.
 */

export interface SubagentResult {
  /** One paragraph the parent can read. Always present, even on failure. */
  summary: string;
  /** Discrete conclusions, each independently checkable. */
  findings: string[];
  /** Files the sub-agent read. Evidence for a scout; context for a worker. */
  filesExamined: string[];
  /** Files the sub-agent wrote. Empty for a read-only `task`. */
  filesChanged: string[];
  /**
   * Did the sub-agent's own checks pass?
   *
   * `not_run` is the honest default and the one that matters: before P6B.2 a
   * worker had no shell, so nothing it wrote had ever been compiled or run, and
   * saying so is the difference between a report and a claim.
   */
  checks: "passed" | "failed" | "not_run";
  /** How much the sub-agent trusts its own answer. */
  confidence: "high" | "medium" | "low";
  /** What it could not settle. A parent that reads only `summary` will re-do this. */
  unresolved: string[];
  /** Why it stopped: end_turn, max_turns, aborted, error, budget_exhausted, … */
  stopReason: string;
  /** The model that actually answered, when it differs from the one dispatched. */
  servedBy?: { provider: string; model: string };
  toolCallCount: number;
}

/**
 * The schema on the tool and in the structured-repair call. Deliberately flat:
 * every field is a scalar or an array of strings, because a nested schema is
 * where provider-side structured output starts silently degrading.
 */
export const SUBAGENT_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "findings",
    "filesExamined",
    "filesChanged",
    "checks",
    "confidence",
    "unresolved",
    "stopReason",
    "toolCallCount",
  ],
  properties: {
    summary: { type: "string", description: "One paragraph a parent agent can act on." },
    findings: {
      type: "array",
      items: { type: "string" },
      description: "Discrete, checkable conclusions.",
    },
    filesExamined: { type: "array", items: { type: "string" }, description: "Paths read." },
    filesChanged: { type: "array", items: { type: "string" }, description: "Paths written." },
    checks: { type: "string", enum: ["passed", "failed", "not_run"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    unresolved: { type: "array", items: { type: "string" }, description: "What remains open." },
    stopReason: { type: "string" },
    toolCallCount: { type: "integer" },
    integration: { type: "string", enum: ["merged", "retained", "shared"] },
    branch: { type: "string" },
    conflicts: { type: "array", items: { type: "string" } },
  },
};

export const SUBAGENT_RESPONSE_FORMAT: ResponseFormat = {
  type: "json_schema",
  jsonSchema: SUBAGENT_RESULT_SCHEMA,
};

// ─── The child summary a parent's lifecycle carries ───

/**
 * One entry of the lifecycle contract's `children[]`, produced by the child.
 *
 * A conflicted worker merge stays `success: true` — the work is retained on its
 * branch, not lost, and calling that a failed tool call would tell the model to
 * throw away a real build. But it was ONLY ever visible as the prose block
 * `[MERGE CONFLICTS — …]` inside the result text, which no machine consumer
 * reads: the headless envelope and the TUI both saw an unqualified success.
 * This is that fact as a typed field.
 *
 * It IS the protocol's `TaskLifecycleChild`, minus the two fields a child cannot
 * know about itself — `withDelegatedSessions` mints the id and knows the kind,
 * so it completes the record on the way out. Typed against the contract rather
 * than merely shaped like it, so a change there breaks this at compile time.
 */
export type ChildLifecycleStatus = TaskLifecycleStatus;

export interface ChildSummary extends Omit<TaskLifecycleChild, "id" | "kind"> {
  id?: TaskLifecycleChild["id"];
  kind?: TaskLifecycleChild["kind"];
  /** The retained branch. Not in the contract; the lead needs somewhere to look. */
  branch?: string;
}

const CHILD_STATUSES: Record<string, ChildLifecycleStatus> = {
  end_turn: "end_turn",
  aborted: "aborted",
  halted: "halted",
  max_turns: "max_turns",
  max_tokens: "max_tokens",
  provider_lost: "provider_lost",
  open_steps: "open_steps",
  stalled: "stalled",
  running: "running",
  // A budget is a deliberate stop with the work kept, which is what "halted"
  // means in the contract; neither has a member of its own.
  cost_budget: "halted",
  time_budget: "halted",
};

/**
 * The child's stop reason in the lifecycle's vocabulary.
 *
 * An unknown or missing reason becomes `stalled` rather than `end_turn`: a run
 * that cannot say how it ended did not end well, and the one direction this
 * must never guess in is "finished". A child that died on an error lands there
 * too — the contract has no `error` member, and "stalled" is what it means.
 */
export function toChildStatus(stopReason: string | undefined): ChildLifecycleStatus {
  return CHILD_STATUSES[String(stopReason ?? "").trim()] ?? "stalled";
}

/** Build the typed summary from what the run observed. */
export function buildChildSummary(observed: {
  stopReason?: string;
  integration?: "merged" | "retained" | "shared";
  conflicts?: string[];
  branch?: string;
}): ChildSummary {
  return {
    status: toChildStatus(observed.stopReason),
    ...(observed.integration ? { integration: observed.integration } : {}),
    // Always present when there is an integration to speak of, so a consumer
    // can read "no conflicts" rather than "the field is missing".
    ...(observed.integration ? { conflicts: observed.conflicts ?? [] } : {}),
    ...(observed.branch ? { branch: observed.branch } : {}),
  };
}

// ─── Parsing ───

const STRING_ARRAY_FIELDS = ["findings", "filesExamined", "filesChanged", "unresolved"] as const;

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Pull a result object out of whatever the model produced.
 *
 * Three shapes, in order: a bare JSON object, a fenced ```json block, and the
 * first balanced `{…}` in the text. Anything else returns null and the caller
 * decides whether to spend a repair call or fall back to the prose path — the
 * one thing this must never do is invent a field, because a fabricated
 * `checks: "passed"` is worse than no result at all.
 */
export function parseSubagentResult(text: string): SubagentResult | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const brace = trimmed.indexOf("{");
  if (brace >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = brace; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(trimmed.slice(brace, i + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    // A summary is the one field with no honest default. Without it this is
    // some other object that happened to be in the text.
    if (typeof obj.summary !== "string" || !obj.summary.trim()) continue;
    const result: SubagentResult = {
      summary: obj.summary.trim(),
      findings: asStringArray(obj.findings),
      filesExamined: asStringArray(obj.filesExamined),
      filesChanged: asStringArray(obj.filesChanged),
      checks: asEnum(obj.checks, ["passed", "failed", "not_run"] as const, "not_run"),
      confidence: asEnum(obj.confidence, ["high", "medium", "low"] as const, "medium"),
      unresolved: asStringArray(obj.unresolved),
      stopReason: typeof obj.stopReason === "string" ? obj.stopReason : "",
      toolCallCount: Number.isFinite(obj.toolCallCount) ? Number(obj.toolCallCount) : 0,
    };
    return result;
  }
  return null;
}

/** Structural validation for the `toolResultProcessor` hook. */
export function validateSubagentResult(value: unknown): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, problems: ["not an object"] };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.summary !== "string" || !obj.summary.trim()) problems.push("summary missing");
  for (const field of STRING_ARRAY_FIELDS) {
    if (!Array.isArray(obj[field])) problems.push(`${field} is not an array`);
  }
  if (!["passed", "failed", "not_run"].includes(String(obj.checks)))
    problems.push("checks invalid");
  if (!["high", "medium", "low"].includes(String(obj.confidence)))
    problems.push("confidence invalid");
  return { valid: problems.length === 0, problems };
}

/**
 * The subject of one tool call, for a receipt line.
 *
 * Lived in subagent.ts. It is here because `worker` needed it too and had only
 * `args.path`: a worker whose receipts were all `glob` or `grep` calls came back
 * saying it ran twelve tool calls "covering: glob", which is not a receipt.
 */
export function describeCall(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of ["path", "pattern", "query", "name", "glob"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const v = value.length > 80 ? `${value.slice(0, 79)}…` : value;
      return ` ${v}`;
    }
  }
  return "";
}

// ─── Construction from an observed run ───

export interface ObservedRun {
  finalText: string;
  toolCallCount: number;
  stopReason: string;
  loopError?: string;
  /** Deduplicated tool-call labels, in order. */
  trail: string[];
  filesChanged?: string[];
  servedBy?: { provider: string; model: string };
  checks?: "passed" | "failed" | "not_run";
}

/**
 * Build a result from what the run actually did, using the model's own object
 * when it produced one and falling back to observation when it did not.
 *
 * The fallback is not a degraded mode: `filesChanged`, `toolCallCount` and
 * `stopReason` are always taken from the harness, never from the model, because
 * those are the fields a model has an incentive to get wrong. The model
 * contributes prose and judgement; the harness contributes facts.
 */
export function buildSubagentResult(observed: ObservedRun): SubagentResult {
  const parsed = parseSubagentResult(observed.finalText);
  const changed = observed.filesChanged ?? [];
  if (parsed) {
    return {
      ...parsed,
      // Harness facts always win.
      filesChanged: changed.length > 0 ? changed : parsed.filesChanged,
      toolCallCount: observed.toolCallCount,
      stopReason: observed.stopReason || parsed.stopReason,
      servedBy: observed.servedBy,
      checks: observed.checks ?? parsed.checks,
    };
  }

  const trimmed = observed.finalText.trim();
  const incomplete = trimmed.length === 0;
  return {
    summary: incomplete ? describeIncomplete(observed) : trimmed,
    findings: [],
    filesExamined: observed.trail,
    filesChanged: changed,
    checks: observed.checks ?? "not_run",
    // A run that wrote no summary has not earned "medium".
    confidence: incomplete ? "low" : "medium",
    unresolved: incomplete ? ["The sub-agent wrote no summary; nothing here is an answer."] : [],
    stopReason: observed.stopReason || (observed.loopError ? "error" : "unknown"),
    servedBy: observed.servedBy,
    toolCallCount: observed.toolCallCount,
  };
}

function describeIncomplete(o: ObservedRun): string {
  if (o.loopError) return `The sub-agent hit an error and stopped (${o.loopError}).`;
  if (o.stopReason === "max_turns")
    return "The sub-agent ran out of turns before writing its summary.";
  if (o.stopReason === "aborted") return "The sub-agent was aborted before writing its summary.";
  return `The sub-agent ended without writing a summary (stopped: ${o.stopReason || "unknown"}).`;
}

// ─── Rendering ───

const MAX_LISTED = 40;

/**
 * The scout's report. Replaces `partialReport`: same two jobs — return the
 * ground covered, and NAME THE CAUSE, because running out of turns and
 * choosing to say nothing are different failures with different fixes — but
 * driven off the object rather than reconstructed from loop variables.
 */
export function renderTaskResult(
  result: SubagentResult,
  opts: {
    maxTurns: number;
    topBudget: number;
    effort?: string;
    /** The identity the sub-agent was DISPATCHED to, so the banner can name both. */
    dispatched?: { provider: string; model: string };
    /** Why the gateway swapped models. The parent has no other way to learn this. */
    fallbackReason?: string;
  } = { maxTurns: 0, topBudget: 0 },
): string {
  // A scout that finished on a different model is reporting SECONDHAND from
  // somewhere the caller did not choose — usually a free fallback picked up
  // after the session model hit a plan quota. It leads the result rather than
  // being buried, because it changes how much the findings are worth.
  const provenance = result.servedBy
    ? `[PROVENANCE — this sub-agent did not run on ` +
      `${opts.dispatched ? `${opts.dispatched.provider}/${opts.dispatched.model}` : "the model it was dispatched to"}. ` +
      `The gateway switched it to ${result.servedBy.provider}/${result.servedBy.model} mid-run` +
      `${opts.fallbackReason ? ` (${opts.fallbackReason})` : ""}. Treat everything below as ` +
      `UNVERIFIED: re-check any claim before you rely on it or repeat it to the user.]\n\n`
    : "";

  const incomplete = result.findings.length === 0 && result.confidence === "low";
  const lines: string[] = [];
  if (incomplete) {
    lines.push(
      `INCOMPLETE — ${result.summary} No findings were written, so what follows is only the`,
      `ground it covered. Treat nothing here as an answer.`,
      "",
    );
  } else {
    lines.push(result.summary, "");
  }

  if (result.findings.length) {
    lines.push("Findings:");
    for (const f of result.findings.slice(0, MAX_LISTED)) lines.push(`  · ${f}`);
    lines.push("");
  }

  if (result.filesExamined.length) {
    const shown = result.filesExamined.slice(0, MAX_LISTED);
    const elided = Math.max(0, result.filesExamined.length - shown.length);
    lines.push(
      `It ran ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"}, covering:`,
      ...shown.map((t) => `  · ${t}`),
      ...(elided > 0 ? [`  · … and ${elided} more`] : []),
      "",
    );
  }

  if (result.unresolved.length) {
    lines.push("Unresolved:");
    for (const u of result.unresolved.slice(0, MAX_LISTED)) lines.push(`  · ${u}`);
    lines.push("");
  }

  if (incomplete && opts.maxTurns > 0) {
    lines.push(
      result.stopReason === "max_turns"
        ? opts.effort === "thorough"
          ? `Re-dispatch a NARROWER question — this one did not fit ${opts.maxTurns} turns.`
          : `Re-dispatch with effort: "thorough" (${opts.topBudget} turns) or split it into narrower questions.`
        : "Re-dispatch with a more specific question, or read the files above yourself.",
    );
  }

  lines.push(`[confidence: ${result.confidence} · checks: ${result.checks}]`);
  return provenance + lines.join("\n").trim();
}

/**
 * The worker's report plus the manifest measured from disk.
 *
 * The measurement is the point and it survives verbatim: per-file line counts
 * and sizes read back off the filesystem, which the worker cannot inflate,
 * because a twelve-line "complete FastAPI backend" is otherwise invisible.
 * What changes is the closing warning — it now reads the result's own `checks`
 * field instead of asserting that nothing was ever run, which stopped being
 * true when workers got a shell in P6B.2.
 */
export function renderWorkerResult(
  result: SubagentResult,
  workspaceRoot: string,
  opts: { conflicts?: string[]; branch?: string } = {},
): string {
  const calls = `${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"}`;
  // A worker that wrote no report is not a worker that did nothing. It hit its
  // turn ceiling, or a budget, or ended on a tool call — and it still edited
  // files and left tool receipts. The scout's renderer has said INCOMPLETE and
  // named the cause since P6B.3; the worker's said neither, so a run that ran
  // out of turns mid-build reached the lead reading like a finished account.
  const incomplete = result.findings.length === 0 && result.confidence === "low";
  const parts: string[] = incomplete
    ? [
        `INCOMPLETE — ${result.summary} What follows is what the harness measured, not a report.`,
        ...(result.stopReason ? ["", `Stopped: ${result.stopReason}.`] : []),
      ]
    : [result.summary];

  if (result.findings.length) {
    parts.push("", "Findings:", ...result.findings.slice(0, MAX_LISTED).map((f) => `  · ${f}`));
  }
  if (result.unresolved.length) {
    parts.push("", "Unresolved:", ...result.unresolved.slice(0, MAX_LISTED).map((u) => `  · ${u}`));
  }
  // The ground covered. Only worth the parent's context when the prose did not
  // survive — a complete report already says what the worker did.
  if (incomplete && result.filesExamined.length) {
    const shown = result.filesExamined.slice(0, MAX_LISTED);
    const elided = Math.max(0, result.filesExamined.length - shown.length);
    parts.push(
      "",
      `It ran ${calls}, covering:`,
      ...shown.map((t) => `  · ${t}`),
      ...(elided > 0 ? [`  · … and ${elided} more`] : []),
    );
  }

  const paths = [...result.filesChanged].sort();
  if (paths.length === 0) {
    parts.push("", `[WORKER MANIFEST] No files were written (${calls}).`);
  } else {
    const rows: string[] = [];
    let totalLines = 0;
    let totalBytes = 0;
    for (const p of paths) {
      const full = isAbsolute(p) ? p : resolve(workspaceRoot, p);
      let detail: string;
      try {
        const bytes = statSync(full).size;
        const lines = readFileSync(full, "utf8").split("\n").length;
        totalLines += lines;
        totalBytes += bytes;
        detail = `${String(lines).padStart(5)} lines  ${humanBytes(bytes).padStart(9)}`;
      } catch {
        // Claimed but absent: a worker that says it wrote a file and did not is
        // precisely what this manifest exists to surface.
        detail = "      MISSING — claimed but not on disk";
      }
      if (rows.length < MAX_LISTED) rows.push(`  ${detail}  ${p}`);
    }
    if (paths.length > MAX_LISTED) rows.push(`  … and ${paths.length - MAX_LISTED} more`);
    parts.push(
      "",
      "[WORKER MANIFEST — measured from disk, not taken from the report above]",
      ...rows,
      `  ${paths.length} file${paths.length === 1 ? "" : "s"}, ${totalLines} lines, ` +
        `${humanBytes(totalBytes)}, ${calls}.`,
      result.checks === "passed"
        ? "CHECKS PASSED in the worker's own worktree before merge. Re-run the project's full suite " +
            "against the merged tree before you mark this step done."
        : result.checks === "failed"
          ? "CHECKS FAILED in the worker's worktree; the branch was kept for inspection and NOT merged."
          : "NOT VERIFIED: no checks were run, so nothing here was compiled or tested. Open these " +
            "files and run the project's checks yourself before you rely on the report above.",
    );
  }

  if (opts.conflicts?.length) {
    parts.push(
      "",
      `[MERGE CONFLICTS — ${opts.conflicts.length} file${opts.conflicts.length === 1 ? "" : "s"} could not be merged cleanly]`,
      ...opts.conflicts.slice(0, MAX_LISTED).map((c) => `  · ${c}`),
      opts.branch
        ? `The worker's branch ${opts.branch} was kept. Resolve these before relying on the tree.`
        : "Resolve these before relying on the tree.",
    );
  }

  parts.push("", `[confidence: ${result.confidence} · checks: ${result.checks}]`);
  return parts.join("\n");
}

function humanBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// ─── Structured repair ───

/**
 * One extra, tool-less call that converts a sub-agent's own prose into the
 * schema.
 *
 * This is where `responseFormat` belongs, and it is deliberately NOT inside the
 * agent loop's request. Setting a JSON schema on a turn that still offers tools
 * makes providers choose between structured output and tool calling, and they
 * choose differently — so the loop keeps its tools and its prose, and exactly
 * one call at the end, on the text the model already wrote, is constrained.
 *
 * It runs only when the prose did not already parse, so a sub-agent that
 * answers in the schema costs nothing extra. It is best-effort: a failure
 * returns null and the observation-based fallback stands, because a delegation
 * that produced real work must never fail on its report's shape.
 */
export async function repairToSchema(opts: {
  gateway: LlmGateway;
  provider: ProviderName;
  model: string;
  text: string;
  signal?: AbortSignal;
}): Promise<SubagentResult | null> {
  if (!opts.text.trim()) return null;
  try {
    const response = await opts.gateway.infer({
      provider: opts.provider,
      model: opts.model,
      maxTokens: 1200,
      temperature: 0,
      stream: false,
      role: "repair",
      responseFormat: SUBAGENT_RESPONSE_FORMAT,
      ...(opts.signal ? { signal: opts.signal } : {}),
      system:
        "Convert the sub-agent report below into the required JSON object. Use ONLY what the " +
        "report says. Do not add findings, do not infer that checks passed, and do not invent " +
        "file paths. If the report does not state something, leave that field empty.",
      messages: [{ role: "user", content: [{ type: "text", text: opts.text.slice(0, 20_000) }] }],
    });
    const text = response.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    return parseSubagentResult(text);
  } catch {
    return null;
  }
}
