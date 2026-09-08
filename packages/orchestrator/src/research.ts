// ─── Research Mode orchestration ───
// Deep-research ("DeepSearch") core. Three phases, with a human gate in between
// driven by the caller (CLI/TUI):
//
//   1. planResearch()  — one structured LLM call → ResearchPlan (or a request
//                        for clarification). The caller proposes it to the user.
//   2. runResearch()   — after approval: fan out one bounded sub-agent
//                        (AgentLoop) per sub-question against a curated
//                        web-enabled READ-ONLY tool set, capturing sources from
//                        the investigators' tool I/O as ground truth.
//   3. synthesis       — one streamed LLM call → a cohesive markdown report with
//                        inline [n] citations mapped to the deduped sources.
//
// Pure-function style (mirrors subagent.ts). The Engine wraps these with session
// persistence; nothing here touches the DB.

import type { InferenceRequest, ProviderName } from "@rune/llm-gateway";
import { LlmGateway } from "@rune/llm-gateway";
import { ToolRegistry, registerBuiltinTools } from "@rune/tool-registry";
import { AgentLoop } from "./agent-loop";
import type { PermissionCheck, ToolResultProcessor } from "./agent-loop";
import type {
  ResearchClarification,
  ResearchEvent,
  ResearchOptions,
  ResearchPlan,
  ResearchReport,
  ResearchSource,
  ResearchSubQuestion,
  SourceScope,
  SubQuestionResult,
} from "./research-types";
import { runWorkflow, type WorkflowDefinition } from "./workflow";

// ─── Dependencies ───

export interface ResearchDeps {
  gateway: LlmGateway;
  /** Path to the compiled rune-tools binary (for built-in read tools). */
  binaryPath: string;
  model: string;
  provider: ProviderName;
  workspaceRoot: string;
  sessionId: string;
  /** Same tool-result prompt-injection boundary used by every other agent loop. */
  toolResultProcessor?: ToolResultProcessor;
}

export interface PlanResearchOpts extends ResearchOptions {
  /** Revise the prior plan using this feedback instead of asking to clarify. */
  feedback?: string;
  priorPlan?: ResearchPlan;
  /** When false, never return a clarification request. Default true. */
  allowClarification?: boolean;
}

// ─── Depth presets ───
//
// Depth here is iterative, not single-pass: a run does up to `maxRounds`
// investigate→reflect cycles. Round 1 investigates the approved plan; each later
// round investigates follow-up sub-questions the supervisor proposes to close
// gaps. The budgets below bound that loop so it goes deep without going
// unbounded (the project's "bounded fan-out, not thousands" stance).

interface DepthPreset {
  /** Investigate→reflect cycles. Round 1 = the plan; later rounds fill gaps. */
  maxRounds: number;
  /** Sub-questions in the INITIAL plan. */
  maxSubQuestions: number;
  /** New follow-up sub-questions a single reflection may add. */
  maxFollowupsPerRound: number;
  /** Hard ceiling on sub-questions across ALL rounds (safety bound). */
  maxTotalSubQuestions: number;
  maxParallel: number;
  maxSourcesPerStep: number;
  maxTurns: number;
  maxTotalSources: number;
  /** Per-source body chars fed to synthesis (~⌊chars/4⌋ tokens). */
  charsPerSource: number;
  /** Total source-body chars fed to synthesis (protects small-context models). */
  maxSynthesisChars: number;
  /** Token budget for each investigator's findings brief. */
  investigatorMaxTokens: number;
  /** Token budget for the single-call (quick) synthesis path. */
  synthesisMaxTokens: number;
  /**
   * Report sections for the long-form synthesis. >1 ⇒ outline-then-write-each-
   * section so total length scales past a single call's output ceiling; ≤1 ⇒
   * one synthesis call (fast, used by `quick`).
   */
  maxSections: number;
  /** Token budget per section in long-form synthesis. */
  sectionMaxTokens: number;
}

const DEPTH_PRESETS: Record<NonNullable<ResearchOptions["depth"]>, DepthPreset> = {
  // Fast, single-pass. For quick lookups where iteration isn't worth the latency.
  quick: {
    maxRounds: 1,
    maxSubQuestions: 4,
    maxFollowupsPerRound: 0,
    maxTotalSubQuestions: 4,
    maxParallel: 3,
    maxSourcesPerStep: 3,
    maxTurns: 5,
    maxTotalSources: 12,
    charsPerSource: 6000,
    maxSynthesisChars: 32000,
    investigatorMaxTokens: 3072,
    synthesisMaxTokens: 6144,
    maxSections: 1,
    sectionMaxTokens: 6144,
  },
  // Default: one reflection round, richer sourcing, multi-section long-form report.
  standard: {
    maxRounds: 2,
    maxSubQuestions: 6,
    maxFollowupsPerRound: 3,
    maxTotalSubQuestions: 12,
    maxParallel: 4,
    maxSourcesPerStep: 5,
    maxTurns: 7,
    maxTotalSources: 24,
    charsPerSource: 9000,
    maxSynthesisChars: 72000,
    investigatorMaxTokens: 4096,
    synthesisMaxTokens: 10240,
    maxSections: 7,
    sectionMaxTokens: 3584,
  },
  // Heavy: up to two reflection rounds, broad sourcing, book-length sectioned report.
  deep: {
    maxRounds: 3,
    maxSubQuestions: 9,
    maxFollowupsPerRound: 4,
    maxTotalSubQuestions: 20,
    maxParallel: 5,
    maxSourcesPerStep: 7,
    maxTurns: 10,
    maxTotalSources: 40,
    charsPerSource: 12000,
    maxSynthesisChars: 130000,
    investigatorMaxTokens: 6144,
    synthesisMaxTokens: 16384,
    maxSections: 12,
    sectionMaxTokens: 4096,
  },
};

interface Settings extends DepthPreset {
  depth: NonNullable<ResearchOptions["depth"]>;
}

export function resolveSettings(opts?: ResearchOptions): Settings {
  const depth = opts?.depth ?? "standard";
  const p = DEPTH_PRESETS[depth];
  return {
    ...p,
    depth,
    maxRounds: Math.max(1, opts?.maxRounds ?? p.maxRounds),
    maxSubQuestions: opts?.maxSubQuestions ?? p.maxSubQuestions,
    maxParallel: opts?.maxParallel ?? p.maxParallel,
    maxSourcesPerStep: opts?.maxSourcesPerStep ?? p.maxSourcesPerStep,
    maxTotalSources: opts?.maxTotalSources ?? p.maxTotalSources,
    charsPerSource: opts?.charsPerSource ?? p.charsPerSource,
    synthesisMaxTokens: opts?.synthesisMaxTokens ?? p.synthesisMaxTokens,
  };
}

// ─── Curated registry + permission gate ───

const READ_TOOLS = ["read_file", "list_dir", "grep", "glob", "symbol_search"];
const WEB_TOOLS = ["web_search", "web_fetch"];
// Anything that can mutate state or shell out is never available to an investigator.
const FORBIDDEN_TOOLS = [
  "write_file",
  "edit_file",
  "multi_edit",
  "bash",
  "n8n_trigger",
  "todo_write",
];

/**
 * A curated registry for a research investigator. Starts from the built-ins,
 * strips every mutating/escaping tool, then narrows to the sub-question's scope
 * so the model is only offered the tools it should use (web, local, or both).
 */
export function createResearchRegistry(binaryPath: string, scope: SourceScope): ToolRegistry {
  const reg = new ToolRegistry();
  registerBuiltinTools(reg, binaryPath);
  for (const n of FORBIDDEN_TOOLS) reg.unregister(n);
  if (scope === "web") {
    for (const n of READ_TOOLS) reg.unregister(n);
  } else if (scope === "local") {
    for (const n of WEB_TOOLS) reg.unregister(n);
  }
  return reg;
}

/**
 * Permission gate for investigators: auto-allow read tools and the two web
 * tools, deny everything else. Defense-in-depth on top of the curated registry
 * so an investigator can never write, execute, or recurse — and so the run is
 * unattended after the single up-front approval (no per-call prompts).
 */
export function createResearchPermissionCheck(registry: ToolRegistry): PermissionCheck {
  return async ({ toolName }) => {
    const handler = registry.get(toolName);
    if (!handler) return { allowed: false, reason: `Unknown tool: ${toolName}` };
    const cat = handler.schema.category;
    if (cat === "read" || toolName === "web_search" || toolName === "web_fetch") {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Research investigator may not use "${toolName}" (category "${cat}")`,
    };
  };
}

// ─── Planning ───

const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    needsClarification: { type: "boolean" },
    questions: { type: "array", items: { type: "string" } },
    clarification: { type: "string" },
    outputFormat: { type: "string" },
    subQuestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          rationale: { type: "string" },
          sourceScope: { type: "string", enum: ["web", "local", "both"] },
        },
        required: ["question"],
      },
    },
  },
};

function plannerSystemPrompt(maxSubQuestions: number, allowClarify: boolean): string {
  const clarifyBranch = allowClarify
    ? `1) If the request is genuinely ambiguous or under-specified (audience, timeframe, scope, or which sources to use), ask 1-3 short clarifying questions:
   {"needsClarification": true, "questions": ["...", "..."]}

2) Otherwise, a research plan:`
    : `A research plan (do NOT ask clarifying questions):`;

  return `You are a meticulous research planner for an agentic CLI that can search the web AND read the user's local project files.

Given a RESEARCH REQUEST, respond with ONLY a single JSON object — no prose, no code fences — in this shape:

${clarifyBranch}
   {"clarification": "<one-line restatement of what you will research>",
    "outputFormat": "report" | "comparison" | "brief" | "timeline",
    "subQuestions": [
      {"question": "<focused sub-question>", "rationale": "<why it matters>", "sourceScope": "web" | "local" | "both"}
    ]}

Rules:
- Decompose into at most ${maxSubQuestions} focused, non-overlapping sub-questions that together fully answer the request.
- For analytical or evaluative topics (markets, trends, decisions, comparisons, "should…", "why…", "what happens if…"), make ONE sub-question adversarial: aim it at the strongest disconfirming evidence ("what is the best case that X is wrong, overstated, or about to change?"). Skip this for purely factual lookups.
- sourceScope defaults to "web". Use "local" ONLY when a sub-question is about the user's OWN project/codebase/files; use "both" when it needs the project AND external information. For purely external topics (markets, news, products, science, history), always use "web".
- Prefer "web". Never invent a reason to read local files for a purely external topic.`;
}

function plannerUserPrompt(question: string, opts?: PlanResearchOpts): string {
  let p = `RESEARCH REQUEST:\n${question}`;
  if (opts?.priorPlan && opts.feedback) {
    const prior = opts.priorPlan.subQuestions
      .map((s) => `  ${s.index + 1}. [${s.sourceScope}] ${s.question}`)
      .join("\n");
    p += `\n\nYou previously proposed this plan:\n${prior}\n\nThe user reviewed it and asked you to revise it with this feedback:\n${opts.feedback}\n\nProduce a REVISED plan that incorporates the feedback.`;
  }
  return p;
}

/**
 * Generate a research plan (or a clarification request) from a question. Uses a
 * single structured LLM call with a JSON response format, plus a defensive
 * parser for providers that ignore the schema.
 */
export async function planResearch(
  deps: Pick<ResearchDeps, "gateway" | "model" | "provider">,
  question: string,
  opts?: PlanResearchOpts,
  signal?: AbortSignal,
): Promise<ResearchPlan | ResearchClarification> {
  const s = resolveSettings(opts);
  const allowClarify = opts?.allowClarification !== false && !opts?.feedback;

  const request: InferenceRequest = {
    messages: [
      { role: "user", content: [{ type: "text", text: plannerUserPrompt(question, opts) }] },
    ],
    system: plannerSystemPrompt(s.maxSubQuestions, allowClarify),
    model: opts?.model ?? deps.model,
    provider: opts?.provider ?? deps.provider,
    maxTokens: 2048,
    responseFormat: { type: "json_schema", jsonSchema: PLAN_JSON_SCHEMA },
    stream: true,
  };

  const text = await collectText(deps.gateway, request, signal);
  const obj = extractJson(text);

  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (
      allowClarify &&
      o.needsClarification === true &&
      Array.isArray(o.questions) &&
      o.questions.length > 0
    ) {
      return {
        needsClarification: true,
        question,
        questions: (o.questions as unknown[])
          .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
          .slice(0, 3),
      };
    }
    const plan = buildPlan(question, o, s.maxSubQuestions);
    if (plan.subQuestions.length > 0) return plan;
  }

  // Total parse failure → a minimal single-question web plan so the run can proceed.
  return fallbackPlan(question);
}

function buildPlan(
  question: string,
  obj: Record<string, unknown>,
  maxSubQuestions: number,
): ResearchPlan {
  const raw = Array.isArray(obj.subQuestions) ? (obj.subQuestions as unknown[]) : [];
  const subQuestions: ResearchSubQuestion[] = raw
    .filter(
      (x): x is Record<string, unknown> =>
        !!x && typeof x === "object" && typeof (x as Record<string, unknown>).question === "string",
    )
    .map((x) => ({
      question: String(x.question).trim(),
      rationale: typeof x.rationale === "string" ? x.rationale.trim() : "",
      sourceScope: normalizeScope(x.sourceScope),
    }))
    .filter((x) => x.question.length > 0)
    .slice(0, Math.max(1, maxSubQuestions))
    .map((x, i) => ({ index: i, ...x }));

  return {
    id: newPlanId(),
    question,
    clarification: typeof obj.clarification === "string" ? obj.clarification.trim() : undefined,
    subQuestions,
    outputFormat: typeof obj.outputFormat === "string" ? obj.outputFormat.trim() : undefined,
    createdAt: new Date().toISOString(),
  };
}

function fallbackPlan(question: string): ResearchPlan {
  return {
    id: newPlanId(),
    question,
    subQuestions: [{ index: 0, question, rationale: "Direct investigation", sourceScope: "web" }],
    createdAt: new Date().toISOString(),
  };
}

function normalizeScope(v: unknown): SourceScope {
  return v === "local" || v === "both" ? v : "web";
}

function newPlanId(): string {
  return `research-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Execution (fan-out + synthesis) ───

/**
 * Execute an approved plan: fan out investigators (bounded concurrency),
 * capture sources from their tool I/O, then stream a cited synthesis.
 */
export async function* runResearch(
  deps: ResearchDeps,
  plan: ResearchPlan,
  opts?: ResearchOptions,
  signal?: AbortSignal,
): AsyncGenerator<ResearchEvent> {
  const s = resolveSettings(opts);

  yield { type: "research_plan", plan };
  if (signal?.aborted) {
    yield { type: "error", error: "Research aborted.", recoverable: false };
    return;
  }

  // Global deduped source map shared across ALL rounds (insertion order ==
  // citation index), so later rounds extend and dedup against earlier findings.
  // Sub-questions are appended round to round; `subResults.length` is the next
  // free sub-question index.
  const sources = new Map<string, ResearchSource>();
  const subResults: SubQuestionResult[] = [];
  const asked = new Set(plan.subQuestions.map((q) => q.question.toLowerCase()));

  // ── One round, on the workflow executor ──
  //
  // This fan-out is the DAG `workflow.ts` was extracted FROM: plan → approve →
  // investigate in parallel → reflect → iterate → synthesize, written as
  // control flow around `mapWithConcurrency`. Running it on the executor is the
  // point of having extracted it — there is one execution path, so a fix to its
  // bounded concurrency, its failure isolation or its reporting reaches
  // research and every written-down workflow at once, instead of drifting apart
  // the way two parallel implementations of the same thing always do.
  //
  // A round is one wave of independent nodes: the sub-questions of a round do
  // not depend on each other, and the dependency between ROUNDS is the reflect
  // step, which is not a node because its follow-ups are what decide whether
  // there is a next round at all. Nothing is persisted — research has never
  // been resumable, and giving it a state file here would be a new feature
  // wearing a refactor's clothes.
  //
  // Each investigator pushes events to the queue and mutates the shared
  // (single-threaded) source map; failures are isolated per node. Shared
  // closures (sources/subResults) accumulate across rounds.
  async function* runBatch(
    batch: ResearchSubQuestion[],
    round: number,
  ): AsyncGenerator<ResearchEvent> {
    const byId = new Map(batch.map((sq) => [`sq${sq.index}`, sq]));
    const definition: WorkflowDefinition = {
      name: `research round ${round}`,
      maxParallel: s.maxParallel,
      nodes: batch.map((sq) => ({
        id: `sq${sq.index}`,
        kind: "task" as const,
        // The executor renders this prompt and hands it back; the investigator
        // builds its own from the sub-question, so this is the node's identity
        // for the reader, not an instruction anything obeys.
        prompt: sq.question,
        dependsOn: [],
        retry: 1,
        label: sq.question,
      })),
    };

    const queue = new AsyncEventQueue<ResearchEvent>();
    const fanout = (async () => {
      try {
        await runWorkflow(definition, {
          maxParallel: s.maxParallel,
          ...(signal ? { signal } : {}),
          runNode: async (node) => {
            const sq = byId.get(node.id)!;
            queue.push({
              type: "research_step_start",
              index: sq.index,
              question: sq.question,
              sourceScope: sq.sourceScope,
            });
            let result: SubQuestionResult;
            try {
              result = await investigate(deps, sq, s, sources, queue, signal);
            } catch (err) {
              result = {
                index: sq.index,
                question: sq.question,
                status: "failed",
                findings: "",
                sourceCount: 0,
                error: err instanceof Error ? err.message : String(err),
              };
            }
            subResults.push(result);
            queue.push({
              type: "research_step_done",
              index: sq.index,
              status: result.status,
              sourceCount: result.sourceCount,
            });
            // The node's status mirrors the sub-question's: a failed
            // investigator is a failed node, which is what the executor's
            // per-node isolation is for. Nothing downstream depends on it, so
            // nothing is skipped — one dead sub-question must not stop a round.
            return {
              output: result.findings,
              ...(result.status === "failed"
                ? { error: result.error ?? "investigator failed" }
                : {}),
            };
          },
        });
      } finally {
        queue.close();
      }
    })();
    for await (const ev of queue.drain()) yield ev;
    await fanout; // surface any unexpected rejection from the wrapper itself
  }

  // ── Iterative deepening: investigate → reflect on gaps → investigate again ──
  // This loop is what makes the research "deep" rather than a single pass: after
  // each round a supervisor LLM reviews the evidence and proposes targeted
  // follow-up sub-questions, until coverage is sufficient or a budget is hit.
  let batch = plan.subQuestions;
  for (let round = 1; ; round++) {
    if (round > 1) {
      yield {
        type: "notice",
        message: `Round ${round}/${s.maxRounds} — digging into ${batch.length} follow-up question${batch.length === 1 ? "" : "s"} to close gaps…`,
      };
    }
    yield* runBatch(batch, round);

    if (signal?.aborted) {
      yield { type: "error", error: "Research aborted.", recoverable: false };
      return;
    }

    // Stop unless another round is both allowed and likely to help.
    if (
      round >= s.maxRounds ||
      sources.size === 0 ||
      sources.size >= s.maxTotalSources ||
      subResults.length >= s.maxTotalSubQuestions
    ) {
      break;
    }

    yield { type: "notice", message: "Reviewing the evidence for gaps…" };
    const followUps = await reflect(deps, plan, subResults, s, asked, signal);
    if (followUps.length === 0) break; // supervisor judged coverage sufficient
    batch = followUps;
  }

  const allSources = [...sources.values()].sort((a, b) => a.index - b.index);
  if (allSources.length === 0) {
    yield {
      type: "error",
      error:
        "No sources found. DuckDuckGo may be throttling — add a Tavily or Brave key via /keys for reliable results, or rephrase the question.",
      recoverable: false,
    };
    return;
  }

  const model = opts?.model ?? deps.model;
  const provider = opts?.provider ?? deps.provider;

  // The analyst stage: one judgment call between evidence and prose. Failure
  // degrades the report (no analysis layer), never kills it.
  yield {
    type: "notice",
    message: "Forming the analyst's read — thesis, counter-case, implications…",
  };
  const analysis = await analyze(deps, plan, subResults, model, provider, signal);
  if (signal?.aborted) {
    yield { type: "error", error: "Research aborted.", recoverable: false };
    return;
  }

  yield { type: "research_synthesizing", sourceCount: allSources.length };

  // Long-form synthesis: for standard/deep this outlines the report then writes
  // each section in its own streamed call, so total length scales with section
  // count instead of a single call's output ceiling. Quick uses one call.
  let report = "";
  for await (const ev of synthesizeReport(
    deps,
    plan,
    subResults,
    allSources,
    s,
    model,
    provider,
    analysis,
    signal,
  )) {
    if (ev.type === "research_report_delta") report += ev.text;
    yield ev;
    if (ev.type === "error") return;
  }

  // Validate citations and append a canonical, always-correct Sources section.
  const warnings = collectWarnings(report, allSources, subResults);
  const sourcesMd =
    "\n\n## Sources\n" +
    allSources.map((src) => `${src.index}. [${src.title || src.url}](${src.url})`).join("\n") +
    "\n";
  yield { type: "research_report_delta", text: sourcesMd };
  report += sourcesMd;

  const report_: ResearchReport = {
    question: plan.question,
    markdown: report,
    sources: allSources,
    subResults,
    completed: subResults.filter((r) => r.status === "ok").length,
    failed: subResults.filter((r) => r.status === "failed").length,
    warnings,
  };
  yield { type: "research_complete", report: report_ };
}

// ─── Investigator ───

async function investigate(
  deps: ResearchDeps,
  sq: ResearchSubQuestion,
  s: Settings,
  sources: Map<string, ResearchSource>,
  queue: AsyncEventQueue<ResearchEvent>,
  signal?: AbortSignal,
): Promise<SubQuestionResult> {
  const registry = createResearchRegistry(deps.binaryPath, sq.sourceScope);
  const permission = createResearchPermissionCheck(registry);
  const loop = new AgentLoop(
    {
      model: deps.model,
      provider: deps.provider,
      maxTokens: s.investigatorMaxTokens,
      maxTurns: s.maxTurns,
      systemPrompt: investigatorSystemPrompt(sq, s.maxSourcesPerStep),
      // Force the explicit web tools (never provider-native grounding) so we can
      // capture sources from tool I/O — and so it works on every provider.
      nativeGrounding: false,
      toolResultProcessor: deps.toolResultProcessor,
    },
    deps.gateway,
    registry,
    permission,
  );

  const task = `Research this sub-question and report your findings:\n\n${sq.question}`;
  let findings = "";
  let newSourceCount = 0;
  let fatal: string | undefined;
  let warnedThrottle = false;

  for await (const ev of loop.run(task, deps.sessionId, deps.workspaceRoot, signal)) {
    if (ev.type === "text_delta") {
      findings += ev.text;
    } else if (ev.type === "tool_call_end") {
      if (ev.output.success) {
        const added = captureSources(
          ev.output.toolName,
          ev.output.result,
          sq.index,
          sources,
          s.maxTotalSources,
        );
        for (const src of added) {
          newSourceCount++;
          queue.push({
            type: "research_source",
            sourceIndex: src.index,
            subQuestion: sq.index,
            url: src.url,
            title: src.title,
            fetched: src.fetched,
          });
        }
      } else if (ev.output.toolName === "web_search" && !warnedThrottle) {
        warnedThrottle = true;
        queue.push({
          type: "notice",
          message:
            "A web search returned no results (DuckDuckGo may be throttling). Connect a search engine with /login → Web search (Tavily, Exa, Brave, …) for reliable research.",
        });
      }
    } else if (ev.type === "error" && !ev.recoverable) {
      fatal = ev.error;
    } else if (ev.type === "turn_complete") {
      break;
    }
  }

  const trimmed = findings.trim();
  if (fatal && !trimmed && newSourceCount === 0) {
    return {
      index: sq.index,
      question: sq.question,
      status: "failed",
      findings: "",
      sourceCount: 0,
      error: fatal,
    };
  }
  const status: SubQuestionResult["status"] = newSourceCount === 0 ? "empty" : "ok";
  return {
    index: sq.index,
    question: sq.question,
    status,
    findings: trimmed,
    sourceCount: newSourceCount,
  };
}

function investigatorSystemPrompt(sq: ResearchSubQuestion, maxSources: number): string {
  const localLine =
    sq.sourceScope === "local"
      ? "- Use the read-only file tools to find and read the relevant local project files."
      : sq.sourceScope === "both"
        ? `- Use web_search/web_fetch for external information, AND the read-only file tools to ground your answer in the local project.`
        : `- Use web_search to find credible, relevant, recent sources, then web_fetch to actually READ the ~${maxSources} most promising pages. Do not rely on search snippets alone — the page bodies are what feed the report.`;

  return `You are a focused research investigator. Your job is to thoroughly answer ONE sub-question by gathering evidence with the available tools, then write a detailed findings brief.

${localLine}
- Investigate deeply: try multiple search queries from different angles, and follow the most authoritative results. A single search is rarely enough.
- Prefer primary or authoritative sources. Note dates for time-sensitive facts, and capture concrete figures, named entities, and specifics — not vague generalities.
- Do NOT fabricate. If the evidence is thin or sources conflict, say so plainly and note what's missing.

When you have gathered enough, STOP calling tools and write a thorough, well-organized findings brief (several substantive paragraphs or structured bullet points) capturing the specific facts, figures, dates, mechanisms, and any conflicting evidence relevant to the sub-question. Be the raw material for a rigorous final report — detail beats brevity here. Do not write a numbered citation list — sources are tracked automatically.`;
}

// ─── Reflection (iterative gap-filling) ───

const REFLECT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sufficient: { type: "boolean" },
    gaps: { type: "array", items: { type: "string" } },
    followUps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          rationale: { type: "string" },
          sourceScope: { type: "string", enum: ["web", "local", "both"] },
        },
        required: ["question"],
      },
    },
  },
};

function reflectionSystemPrompt(maxFollowUps: number): string {
  return `You are the supervisor of an iterative deep-research loop. You have just received the findings from one round of investigation into a research question.

Your job: decide whether the evidence gathered so far is enough to write a thorough, well-supported report that fully answers the ORIGINAL QUESTION — or whether targeted follow-up investigation would materially improve it.

Respond with ONLY a single JSON object — no prose, no code fences:
- If coverage is already strong and a good report could be written now: {"sufficient": true}
- Otherwise: {"sufficient": false, "followUps": [{"question": "<new focused sub-question>", "rationale": "<the specific gap it closes>", "sourceScope": "web" | "local" | "both"}]}

Rules:
- Propose at most ${maxFollowUps} NEW, non-overlapping follow-up sub-questions. Fewer is better — only ask what genuinely deepens or completes the report.
- Target REAL gaps: missing sub-topics, unresolved contradictions, claims that need verification, missing recent data, or areas that came back thin or empty.
- Do NOT repeat or lightly reword a sub-question already investigated. Go deeper or wider, not sideways.
- sourceScope defaults to "web"; use "local" only for the user's own project/files, "both" when a question needs both.`;
}

function reflectionUserPrompt(plan: ResearchPlan, subResults: SubQuestionResult[]): string {
  const findings = [...subResults]
    .sort((a, b) => a.index - b.index)
    .map((r) => {
      const body = (r.findings || "(no findings gathered)").slice(0, 1500);
      return `### ${r.index + 1}. ${r.question} [${r.status}]\n${body}`;
    })
    .join("\n\n");

  return `ORIGINAL RESEARCH QUESTION:
${plan.question}

SUB-QUESTIONS INVESTIGATED SO FAR AND THEIR FINDINGS:
${findings}

Decide whether this is enough for a thorough report, or name the most valuable follow-up sub-questions to close the remaining gaps.`;
}

/**
 * One supervisor LLM call between rounds → the next batch of follow-up
 * sub-questions (or none, when coverage is deemed sufficient). Best-effort: any
 * failure or unparseable output returns no follow-ups so the run still finishes.
 */
async function reflect(
  deps: Pick<ResearchDeps, "gateway" | "model" | "provider">,
  plan: ResearchPlan,
  subResults: SubQuestionResult[],
  s: Settings,
  asked: Set<string>,
  signal?: AbortSignal,
): Promise<ResearchSubQuestion[]> {
  const remaining = s.maxTotalSubQuestions - subResults.length;
  const budget = Math.min(s.maxFollowupsPerRound, Math.max(0, remaining));
  if (budget <= 0) return [];

  const request: InferenceRequest = {
    messages: [
      { role: "user", content: [{ type: "text", text: reflectionUserPrompt(plan, subResults) }] },
    ],
    system: reflectionSystemPrompt(budget),
    model: deps.model,
    provider: deps.provider,
    maxTokens: 1024,
    responseFormat: { type: "json_schema", jsonSchema: REFLECT_JSON_SCHEMA },
    stream: true,
  };

  let text: string;
  try {
    text = await collectText(deps.gateway, request, signal);
  } catch {
    return []; // reflection is an optimization; never let it fail the whole run
  }
  return parseFollowUps(extractJson(text), subResults.length, budget, asked);
}

/**
 * Parse a reflection response into the next batch of sub-questions. Pure and
 * defensive: returns [] when the supervisor says "sufficient", when nothing
 * parses, or when every candidate duplicates an already-asked question.
 * Mutates `asked` so the same question can't be re-proposed in a later round.
 */
export function parseFollowUps(
  obj: unknown,
  startIndex: number,
  maxFollowUps: number,
  asked: Set<string>,
): ResearchSubQuestion[] {
  if (maxFollowUps <= 0 || !obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  if (o.sufficient === true) return [];
  const raw = Array.isArray(o.followUps)
    ? (o.followUps as unknown[])
    : Array.isArray(o.subQuestions)
      ? (o.subQuestions as unknown[])
      : [];

  const out: ResearchSubQuestion[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const rec = x as Record<string, unknown>;
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    if (!question) continue;
    const key = question.toLowerCase();
    if (asked.has(key)) continue; // never re-investigate the same question
    asked.add(key);
    out.push({
      index: startIndex + out.length,
      question,
      rationale: typeof rec.rationale === "string" ? rec.rationale.trim() : "",
      sourceScope: normalizeScope(rec.sourceScope),
    });
    if (out.length >= maxFollowUps) break;
  }
  return out;
}

// ─── Source capture / dedup ───

export function captureSources(
  toolName: string,
  result: string,
  subIndex: number,
  sources: Map<string, ResearchSource>,
  maxTotal: number,
): ResearchSource[] {
  const added: ResearchSource[] = [];
  try {
    if (toolName === "web_search") {
      const parsed = JSON.parse(result) as {
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
      };
      for (const r of parsed.results ?? []) {
        if (!r.url) continue;
        const src = upsertSource(
          sources,
          r.url,
          { title: r.title, snippet: r.snippet },
          subIndex,
          false,
          maxTotal,
        );
        if (src) added.push(src);
      }
    } else if (toolName === "web_fetch") {
      const parsed = JSON.parse(result) as { url?: string; title?: string; markdown?: string };
      if (parsed.url) {
        const src = upsertSource(
          sources,
          parsed.url,
          { title: parsed.title, text: parsed.markdown },
          subIndex,
          true,
          maxTotal,
        );
        if (src) added.push(src);
      }
    }
  } catch {
    // Non-JSON tool output (rare with the DDG fallback) — skip silently.
  }
  return added;
}

/**
 * Insert a source if new (returns it), or enrich the existing entry in place
 * (returns null). A later web_fetch of a URL first seen via web_search upgrades
 * that entry to fetched=true with body text rather than duplicating it.
 */
function upsertSource(
  sources: Map<string, ResearchSource>,
  rawUrl: string,
  data: { title?: string; snippet?: string; text?: string },
  subIndex: number,
  fetched: boolean,
  maxTotal: number,
): ResearchSource | null {
  const key = normalizeUrl(rawUrl);
  const existing = sources.get(key);
  if (existing) {
    if (fetched) existing.fetched = true;
    if (data.text && !existing.text) existing.text = data.text;
    if (data.snippet && !existing.snippet) existing.snippet = data.snippet;
    if (data.title && (!existing.title || existing.title === existing.url))
      existing.title = data.title;
    return null;
  }
  if (sources.size >= maxTotal) return null;
  const src: ResearchSource = {
    index: sources.size + 1,
    title: data.title || rawUrl,
    url: rawUrl,
    snippet: data.snippet,
    text: data.text,
    fetched,
    fromSubQuestion: subIndex,
  };
  sources.set(key, src);
  return src;
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k) || k === "ref" || k === "fbclid" || k === "gclid")
        u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

// ─── Synthesis ───
// Two modes (chosen by `maxSections`):
//   • Single-call (quick): one streamed call writes the whole report.
//   • Long-form (standard/deep): an outline call plans N sections, then each
//     section is written in its own streamed call and concatenated. This is the
//     key to genuinely long, comprehensive ("20-30 page") reports — total length
//     scales with section count instead of one call's output-token ceiling, and
//     each focused section reliably fills more than a single "write it all" call.

/** A planned report section: a heading plus what it must cover. */
export interface ReportSection {
  title: string;
  focus: string;
}

/** Cap on source chars fed to EACH section call (the prefix repeats per section). */
const SECTION_SOURCE_CHAR_CAP = 48000;

const SYNTHESIS_SYSTEM_PROMPT = `You are a senior research analyst. Write a comprehensive, well-structured report that fully answers the user's research question. Facts come ONLY from the numbered SOURCES provided; judgment comes from the ANALYST NOTES and is presented AS judgment.

Requirements:
- Open with a 3-5 sentence executive summary that TAKES A POSITION, then develop the answer in depth with markdown headings, subheadings, and bullet points or tables where they aid clarity.
- Cover every sub-question. Compare and reconcile what different sources say; surface disagreements, caveats, and dates for time-sensitive facts rather than flattening them into a single bland claim.
- The report must carry an ANALYSIS LAYER, not just organized findings: the thesis, the strongest disconfirming case, implications and second-order effects, and concrete signals to watch. Draw these from the ANALYST NOTES when provided (deepen them, don't copy); state them as reasoned judgment ("the evidence points to…", "the strongest case against this is…"), never as sourced fact.
- Be thorough and specific: prefer concrete figures, dates, names, and mechanisms over generalities. Depth means substantive detail, not repetition or filler.
- Cite every non-obvious factual claim with an inline marker like [3], referring to the numbered sources. Cite multiple where relevant, e.g. [2][5]. Judgments and projections carry no [n] — their support is the argument itself.
- Do NOT invent facts, figures, or URLs. If the sources are insufficient or conflict, say so explicitly.
- Do NOT write a "Sources" or "References" section — it is appended automatically. Just use the [n] markers inline.`;

const OUTLINE_SYSTEM_PROMPT_TMPL = (maxSections: number) =>
  `You are a senior research analyst planning the structure of a COMPREHENSIVE, long-form report — think 20-30 pages of polished documentation. Given the research question and the findings gathered, design a detailed section outline.

Respond with ONLY a single JSON object — no prose, no code fences:
{"sections": [{"title": "<section heading>", "focus": "<1-2 sentences naming exactly what this section must cover and which findings it draws on>"}]}

Rules:
- Produce ${maxSections} sections that together cover the topic EXHAUSTIVELY, with NO overlap.
- Begin with an "Executive Summary" and end with a "Conclusion"; include background/context, comparisons, and mechanism sections where they fit the topic.
- ALWAYS include at least one ANALYSIS section (implications and risks, the case against the emerging thesis, what to watch) — a report that only organizes findings is incomplete; the judgment layer is what the reader is paying for.
- Make every section substantive and specific to THIS topic (not generic boilerplate) — each should be worth 1-3 pages of detail.
- Order the sections so the report reads as one coherent document.`;

const SECTION_SYSTEM_PROMPT = `You are a senior research analyst writing ONE section of a larger, comprehensive report. Write ONLY the body of the assigned section.

Requirements:
- Documentation-grade depth: develop the section fully with multiple substantive paragraphs, \`###\` subheadings, bullet lists, and tables where they add clarity. Do NOT summarize tersely — go deep.
- Use specific facts, figures, dates, names, examples, and mechanisms drawn from the SOURCES. Compare and reconcile conflicting evidence; note caveats and dates.
- Cite every non-obvious claim inline with [n] referring to the numbered sources (e.g. [3] or [2][5]). Use ONLY the provided sources; never invent facts or URLs.
- Stay strictly within THIS section's focus; do not duplicate what other sections cover.
- When the section is analytical (implications, risks, the disconfirming case, outlook), draw on the ANALYST NOTES if provided and go beyond them: state judgments as judgments ("the evidence points to…"), argue them from the cited facts, and never dress a projection up as a sourced claim.
- Do NOT repeat the section heading (it is added for you) and do NOT write a "Sources"/"References" list — sources are appended once at the very end.`;

// ─── The analyst stage ───
//
// The stage between evidence and prose that the pipeline used to lack. The
// investigators gather, the reflector checks COVERAGE, and synthesis was
// bound to "ONLY the numbered SOURCES" — which is exactly why reports read as
// the internet organized rather than analyzed: the pipeline had no step whose
// job was judgment. This one call produces the thesis, the strongest case
// against it, implications, and signals to watch; synthesis then presents
// that layer AS judgment, kept distinct from sourced fact. Best-effort: any
// failure returns null and the report ships without it.

const ANALYST_SYSTEM_PROMPT = `You are the ANALYST in a deep-research pipeline. The evidence has already been gathered; your job is the one thing evidence cannot provide: judgment. Write compact analyst notes with exactly these five parts, in this order, as short markdown sections:

1. THESIS — the strongest defensible answer to the research question, in 2-4 sentences. Take a position; hedged mush is a failed thesis.
2. THE DISCONFIRMING CASE — the best honest argument that the thesis is wrong or overstated, built from the evidence's genuinely weakest points, not a strawman.
3. IMPLICATIONS — what follows if the thesis holds: consequences, second-order effects, who is affected and how.
4. SIGNALS TO WATCH — concrete, observable events or numbers that would confirm or break the thesis.
5. CONFIDENCE AND GAPS — where the evidence is thin or conflicting, and what specific information would settle it.

Ground every judgment in the findings (name the specific facts you rely on); label speculation as speculation. No preamble, no extra sections, under 700 words.`;

function analystUserPrompt(plan: ResearchPlan, subResults: SubQuestionResult[]): string {
  return `RESEARCH QUESTION:
${plan.question}

FINDINGS FROM INVESTIGATION (per sub-question):
${findingsBlock(subResults, 1_500)}

Write the analyst notes now.`;
}

/**
 * One judgment call over the gathered findings → analyst notes for synthesis,
 * or null when the call fails or returns nothing usable (the report still
 * ships, merely without its analysis layer — degraded, never dead).
 */
export async function analyze(
  deps: Pick<ResearchDeps, "gateway">,
  plan: ResearchPlan,
  subResults: SubQuestionResult[],
  model: string,
  provider: ProviderName,
  signal?: AbortSignal,
): Promise<string | null> {
  const request: InferenceRequest = {
    messages: [
      { role: "user", content: [{ type: "text", text: analystUserPrompt(plan, subResults) }] },
    ],
    system: ANALYST_SYSTEM_PROMPT,
    model,
    provider,
    maxTokens: 2_048,
    stream: true,
  };
  try {
    const text = (await collectText(deps.gateway, request, signal)).trim();
    return text.length >= 80 ? text : null;
  } catch {
    return null;
  }
}

/** The block that carries analyst notes into a synthesis prompt. */
function analystNotesBlock(analysis: string | null): string {
  if (!analysis) return "";
  return `\nANALYST NOTES (reasoned judgment over these findings — weave the thesis, disconfirming case, implications, and signals into the report, presented AS analysis, distinct from sourced facts):\n${analysis}\n`;
}

/**
 * Pack source bodies for the synthesis prompt within a total-character budget,
 * preferring fetched full-text sources over snippet-only ones so the richest
 * evidence survives when the budget is tight. Citation indices are preserved
 * (every block shows its real [index]); blocks are emitted in citation order.
 */
export function selectSynthesisSources(
  sources: ResearchSource[],
  charsPerSource: number,
  maxTotalChars: number,
): string[] {
  // Budget full-text (fetched) sources first; snippet-only ones fill what's left.
  const ordered = [...sources].sort((a, b) => {
    if (a.fetched !== b.fetched) return a.fetched ? -1 : 1;
    return a.index - b.index;
  });
  const byIndex = new Map<number, string>();
  let used = 0;
  for (const src of ordered) {
    const full = (src.text || src.snippet || "").trim();
    const room = Math.max(0, maxTotalChars - used);
    const body = full.slice(0, Math.min(charsPerSource, room));
    used += body.length;
    const head = `[${src.index}] ${src.title || src.url} — ${src.url}`;
    byIndex.set(src.index, body ? `${head}\n${body}` : head);
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
}

/** Per-sub-question findings block, optionally truncating each brief. */
function findingsBlock(subResults: SubQuestionResult[], perChars?: number): string {
  return [...subResults]
    .sort((a, b) => a.index - b.index)
    .map((r) => {
      const f = r.findings || "(no findings gathered)";
      return `### ${r.index + 1}. ${r.question}\n${perChars ? f.slice(0, perChars) : f}`;
    })
    .join("\n\n");
}

function synthesisUserPrompt(
  plan: ResearchPlan,
  subResults: SubQuestionResult[],
  sources: ResearchSource[],
  s: Settings,
  analysis: string | null = null,
): string {
  const sourceBlocks = selectSynthesisSources(sources, s.charsPerSource, s.maxSynthesisChars).join(
    "\n\n",
  );
  const fmt = plan.outputFormat ? `\nDesired format: ${plan.outputFormat}` : "";

  return `RESEARCH QUESTION:
${plan.question}${fmt}

FINDINGS FROM INVESTIGATION (per sub-question):
${findingsBlock(subResults)}
${analystNotesBlock(analysis)}
NUMBERED SOURCES (cite these by [n]):
${sourceBlocks}

Write the report now.`;
}

// ─── Long-form synthesis (outline → write each section) ───

const OUTLINE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, focus: { type: "string" } },
        required: ["title"],
      },
    },
  },
};

/** Parse an outline response into distinct sections (deduped, capped). Pure. */
export function parseOutline(obj: unknown, maxSections: number): ReportSection[] {
  if (!obj || typeof obj !== "object") return [];
  const raw = Array.isArray((obj as Record<string, unknown>).sections)
    ? ((obj as Record<string, unknown>).sections as unknown[])
    : [];
  const out: ReportSection[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const rec = x as Record<string, unknown>;
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, focus: typeof rec.focus === "string" ? rec.focus.trim() : "" });
    if (out.length >= maxSections) break;
  }
  return out;
}

/** Structural fallback if the outline call fails: derive sections from findings. */
function fallbackOutline(subResults: SubQuestionResult[], maxSections: number): ReportSection[] {
  const body: ReportSection[] = [...subResults]
    .sort((a, b) => a.index - b.index)
    .slice(0, Math.max(1, maxSections - 2))
    .map((r) => ({
      title: r.question,
      focus: "Cover this sub-question in depth using its findings and sources.",
    }));
  return [
    {
      title: "Executive Summary",
      focus: "Summarize the key findings and the overall answer to the research question.",
    },
    ...body,
    { title: "Conclusion", focus: "Synthesize the implications, trade-offs, and open questions." },
  ].slice(0, maxSections);
}

async function planReportOutline(
  deps: Pick<ResearchDeps, "gateway">,
  plan: ResearchPlan,
  subResults: SubQuestionResult[],
  s: Settings,
  model: string,
  provider: ProviderName,
  analysis: string | null = null,
  signal?: AbortSignal,
): Promise<ReportSection[]> {
  const fmt = plan.outputFormat ? `\nDesired overall format: ${plan.outputFormat}` : "";
  const userPrompt = `RESEARCH QUESTION:
${plan.question}${fmt}

FINDINGS GATHERED (per sub-question, abridged):
${findingsBlock(subResults, 900)}
${analystNotesBlock(analysis)}
Design the section outline now.`;

  const request: InferenceRequest = {
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
    system: OUTLINE_SYSTEM_PROMPT_TMPL(s.maxSections),
    model,
    provider,
    maxTokens: 2048,
    responseFormat: { type: "json_schema", jsonSchema: OUTLINE_JSON_SCHEMA },
    stream: true,
  };

  let text: string;
  try {
    text = await collectText(deps.gateway, request, signal);
  } catch {
    return fallbackOutline(subResults, s.maxSections);
  }
  const sections = parseOutline(extractJson(text), s.maxSections);
  return sections.length > 0 ? sections : fallbackOutline(subResults, s.maxSections);
}

function sectionUserPrompt(
  plan: ResearchPlan,
  subResults: SubQuestionResult[],
  sourceBlocks: string,
  outline: ReportSection[],
  written: ReportSection[],
  index: number,
  sec: ReportSection,
  analysis: string | null = null,
): string {
  const outlineList = outline.map((o, i) => `${i + 1}. ${o.title}`).join("\n");
  // A compact reminder of what's already covered, to avoid repetition.
  const covered = written.length
    ? `\nSECTIONS ALREADY WRITTEN (do NOT repeat their content):\n${written
        .slice(-8)
        .map((w) => `- ${w.title}: ${w.focus.slice(0, 160)}`)
        .join("\n")}\n`
    : "";

  return `RESEARCH QUESTION:
${plan.question}

FULL REPORT OUTLINE (you are writing section ${index + 1} of ${outline.length}):
${outlineList}
${covered}
THE SECTION TO WRITE NOW:
## ${sec.title}
Focus: ${sec.focus || "Cover this section thoroughly."}

FINDINGS FROM INVESTIGATION (raw material, per sub-question):
${findingsBlock(subResults)}
${analystNotesBlock(analysis)}
NUMBERED SOURCES (cite these by [n]):
${sourceBlocks}

Write the in-depth body of "## ${sec.title}" now — comprehensive, specific, and well-cited.`;
}

/** Stream one LLM call, normalizing its events to ResearchEvents. */
async function* streamCall(
  gateway: LlmGateway,
  request: InferenceRequest,
  signal?: AbortSignal,
): AsyncGenerator<ResearchEvent> {
  try {
    for await (const ev of gateway.inferStream(request, signal ? { signal } : {})) {
      if (ev.type === "content_delta" && ev.delta.type === "text_delta") {
        yield { type: "research_report_delta", text: ev.delta.text };
      } else if (ev.type === "notice") {
        yield { type: "notice", message: ev.message };
      } else if (ev.type === "error") {
        yield { type: "error", error: ev.error, recoverable: false };
        return;
      }
    }
  } catch (err) {
    yield {
      type: "error",
      error: signal?.aborted
        ? "Research aborted."
        : err instanceof Error
          ? err.message
          : String(err),
      recoverable: false,
    };
  }
}

/**
 * Synthesize the final report. Quick depth (maxSections ≤ 1) makes a single
 * streamed call; standard/deep outline the report then write each section in its
 * own call, streaming the whole thing as `research_report_delta`s. A failed
 * section is downgraded to a notice and skipped (a partial long report beats
 * none); only an abort is surfaced as a fatal error.
 */
export async function* synthesizeReport(
  deps: Pick<ResearchDeps, "gateway">,
  plan: ResearchPlan,
  subResults: SubQuestionResult[],
  sources: ResearchSource[],
  s: Settings,
  model: string,
  provider: ProviderName,
  analysis: string | null = null,
  signal?: AbortSignal,
): AsyncGenerator<ResearchEvent> {
  // Quick: one call.
  if (s.maxSections <= 1) {
    const req: InferenceRequest = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: synthesisUserPrompt(plan, subResults, sources, s, analysis) },
          ],
        },
      ],
      system: SYNTHESIS_SYSTEM_PROMPT,
      model,
      provider,
      maxTokens: s.synthesisMaxTokens,
      stream: true,
    };
    yield* streamCall(deps.gateway, req, signal);
    return;
  }

  // Long-form: outline, then write each section.
  const outline = await planReportOutline(
    deps,
    plan,
    subResults,
    s,
    model,
    provider,
    analysis,
    signal,
  );
  if (signal?.aborted) {
    yield { type: "error", error: "Research aborted.", recoverable: false };
    return;
  }

  const sourceBlocks = selectSynthesisSources(
    sources,
    s.charsPerSource,
    Math.min(s.maxSynthesisChars, SECTION_SOURCE_CHAR_CAP),
  ).join("\n\n");

  const written: ReportSection[] = [];
  for (let i = 0; i < outline.length; i++) {
    if (signal?.aborted) {
      yield { type: "error", error: "Research aborted.", recoverable: false };
      return;
    }
    const sec = outline[i];
    yield { type: "notice", message: `Writing section ${i + 1}/${outline.length}: ${sec.title}` };
    // Emit the heading ourselves so structure is guaranteed and consistent.
    yield { type: "research_report_delta", text: `${i === 0 ? "" : "\n\n"}## ${sec.title}\n\n` };

    const req: InferenceRequest = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: sectionUserPrompt(
                plan,
                subResults,
                sourceBlocks,
                outline,
                written,
                i,
                sec,
                analysis,
              ),
            },
          ],
        },
      ],
      system: SECTION_SYSTEM_PROMPT,
      model,
      provider,
      maxTokens: s.sectionMaxTokens,
      stream: true,
    };

    let sectionErr: string | undefined;
    for await (const ev of streamCall(deps.gateway, req, signal)) {
      if (ev.type === "error") {
        sectionErr = ev.error;
        break;
      }
      yield ev;
    }
    if (sectionErr) {
      if (signal?.aborted) {
        yield { type: "error", error: "Research aborted.", recoverable: false };
        return;
      }
      // Non-fatal: note it and keep building the rest of the report.
      yield {
        type: "notice",
        message: `Section "${sec.title}" could not be completed (${sectionErr.slice(0, 80)}). Continuing.`,
      };
    }
    written.push(sec);
  }
}

export function collectWarnings(
  report: string,
  sources: ResearchSource[],
  subResults: SubQuestionResult[],
): string[] {
  const warnings: string[] = [];
  const cited = new Set<number>();
  for (const m of report.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= sources.length) cited.add(n);
    else warnings.push(`Report cited [${n}], which is out of range.`);
  }
  if (cited.size === 0) warnings.push("The report contains no inline citations.");
  const failed = subResults.filter((r) => r.status === "failed").length;
  if (failed > 0) warnings.push(`${failed} sub-question(s) failed — coverage may be partial.`);
  return [...new Set(warnings)];
}

// ─── Helpers ───

/** Run a streamed inference and concatenate just the text. Throws on error. */
async function collectText(
  gateway: LlmGateway,
  request: InferenceRequest,
  signal?: AbortSignal,
): Promise<string> {
  let out = "";
  for await (const ev of gateway.inferStream(request, signal ? { signal } : {})) {
    if (ev.type === "content_delta" && ev.delta.type === "text_delta") out += ev.delta.text;
    else if (ev.type === "error") throw new Error(ev.error);
  }
  return out;
}

/**
 * Best-effort JSON extraction from a model response: try direct parse, then a
 * fenced code block, then the first balanced top-level object (string-aware).
 */
export function extractJson(text: string): unknown {
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const v = tryParse(fence[1].trim());
    if (v !== undefined) return v;
  }

  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          const v = tryParse(text.slice(start, i + 1));
          if (v !== undefined) return v;
          break;
        }
      }
    }
  }
  return null;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ─── Async event queue ───
// Bridges concurrent investigators (producers) to the single-consumer
// runResearch generator so progress streams live instead of batching.

class AsyncEventQueue<T> {
  private buffer: T[] = [];
  private waiting: Array<
    (r: { value: T; done: false } | { value: undefined; done: true }) => void
  > = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const w = this.waiting.shift();
    if (w) w({ value, done: false });
    else this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length) this.waiting.shift()!({ value: undefined, done: true });
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      if (this.buffer.length) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<{ value: T; done: false } | { value: undefined; done: true }>(
        (resolve) => this.waiting.push(resolve),
      );
      if (next.done) return;
      yield next.value;
    }
  }
}
