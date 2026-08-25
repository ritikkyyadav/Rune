// ─── Research Mode Types ───
// Deep-research ("DeepSearch") feature: the user asks a question, the agent
// PROPOSES a decomposed plan, the user APPROVES, and the agent fans out
// web (+optionally local) investigators, then synthesizes a cited report.
//
// These types are the contract shared by the orchestration core
// (research.ts), the Engine methods, and the CLI/TUI renderers.

import type { ProviderName } from "@gear/llm-gateway";

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

export interface ResearchOptions {
  depth?: ResearchDepth;
  /** Investigate→reflect cycles (round 1 = the plan, later rounds fill gaps). */
  maxRounds?: number;
  maxSubQuestions?: number;
  maxParallel?: number;
  maxSourcesPerStep?: number;
  /** Total sources fed to synthesis (after dedup). */
  maxTotalSources?: number;
  /** Per-source body chars fed to synthesis. */
  charsPerSource?: number;
  /** Override model/provider for the run (defaults to the session model). */
  model?: string;
  provider?: ProviderName;
  /** Max tokens for the final synthesis call. */
  synthesisMaxTokens?: number;
  // ─── CLI/TUI knobs (ignored by the core; read by the command handlers) ───
  /** Skip the approval gate and run immediately. Default false. */
  autoApprove?: boolean;
  /** Save the finished report to a markdown file. Default true. */
  save?: boolean;
  /** Directory for saved reports. Default `<workspace>/.gear/research`. */
  outputDir?: string;
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
