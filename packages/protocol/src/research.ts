// ─── ResearchEvent and its payloads ───
//
// Canonical here; `packages/orchestrator/src/research-types.ts` re-exports so
// the orchestration core and the CLI keep their existing import sites. These
// cross the wire under the `research_event` stream (P2.7).

/** Depth presets — control sub-question count, fan-out, sources, and turns. */
export type ResearchDepth = "quick" | "standard" | "deep";

/**
 * Where a sub-question gathers from. The planner decides this per sub-question:
 * "web" for external topics, "local" when the question is about THIS project's
 * code/files, "both" when it needs both. Default is "web".
 */
export type SourceScope = "web" | "local" | "both";

export interface ResearchSubQuestion {
  index: number;
  question: string;
  rationale: string;
  sourceScope: SourceScope;
}

export interface ResearchPlan {
  id: string;
  /** The original (or revised) research question. */
  question: string;
  /** Optional one-line restatement of the refined understanding. */
  clarification?: string;
  subQuestions: ResearchSubQuestion[];
  /** Free-form synthesis hint, e.g. "report" | "comparison" | "brief". */
  outputFormat?: string;
  createdAt: string;
}

/** Returned by the planner when the request is too ambiguous to plan. */
export interface ResearchClarification {
  needsClarification: true;
  question: string;
  questions: string[];
}

/** Type guard distinguishing a clarification request from a finished plan. */
export function isClarification(
  x: ResearchPlan | ResearchClarification,
): x is ResearchClarification {
  return (x as ResearchClarification).needsClarification === true;
}

export interface ResearchSource {
  /** 1-based global citation index, assigned on first sighting. */
  index: number;
  title: string;
  url: string;
  /** Short snippet from web_search. */
  snippet?: string;
  /** Full readable markdown when the page was fetched via web_fetch. */
  text?: string;
  /** True once the page body was fetched (not just search-snippet). */
  fetched: boolean;
  /** Index of the sub-question that first surfaced this source. */
  fromSubQuestion: number;
}

export interface SubQuestionResult {
  index: number;
  question: string;
  status: "ok" | "failed" | "empty";
  /** The investigator's final summary text. */
  findings: string;
  sourceCount: number;
  error?: string;
}

export interface ResearchReport {
  question: string;
  /** Final synthesized report incl. the appended Sources section. */
  markdown: string;
  sources: ResearchSource[];
  subResults: SubQuestionResult[];
  completed: number;
  failed: number;
  /** Non-fatal warnings (e.g. out-of-range citation, degraded coverage). */
  warnings: string[];
}

/**
 * Streamed by `runResearch`. The `error` shape matches AgentTurnEvent so the
 * CLI/TUI can render it through the same path.
 */
export type ResearchEvent =
  | { type: "research_plan"; plan: ResearchPlan }
  | { type: "research_step_start"; index: number; question: string; sourceScope: SourceScope }
  | {
      type: "research_source";
      sourceIndex: number;
      subQuestion: number;
      url: string;
      title: string;
      fetched: boolean;
    }
  | {
      type: "research_step_done";
      index: number;
      status: "ok" | "failed" | "empty";
      sourceCount: number;
    }
  | { type: "research_synthesizing"; sourceCount: number }
  | { type: "research_report_delta"; text: string }
  | { type: "research_complete"; report: ResearchReport }
  | { type: "notice"; message: string }
  | { type: "error"; error: string; recoverable: boolean };

export type ResearchEventType = ResearchEvent["type"];

/** The manifest, guarded exactly as `AGENT_TURN_EVENT_TYPES` is. */
export const RESEARCH_EVENT_TYPES = [
  "research_plan",
  "research_step_start",
  "research_source",
  "research_step_done",
  "research_synthesizing",
  "research_report_delta",
  "research_complete",
  "notice",
  "error",
] as const satisfies readonly ResearchEventType[];

type _AllResearchMembersListed =
  Exclude<ResearchEventType, (typeof RESEARCH_EVENT_TYPES)[number]> extends never
    ? true
    : {
        ERROR: "RESEARCH_EVENT_TYPES is missing a member of ResearchEvent";
        missing: Exclude<ResearchEventType, (typeof RESEARCH_EVENT_TYPES)[number]>;
      };
const _allResearchMembersListed: _AllResearchMembersListed = true;
void _allResearchMembersListed;

/**
 * The research members that are NOT also `AgentTurnEvent` members.
 *
 * `notice` and `error` are shared by both unions on purpose — the CLI renders
 * a research failure through the same path as a turn failure — so a reducer
 * that consumes both must not list them twice.
 */
export const RESEARCH_ONLY_EVENT_TYPES = [
  "research_plan",
  "research_step_start",
  "research_source",
  "research_step_done",
  "research_synthesizing",
  "research_report_delta",
  "research_complete",
] as const;
