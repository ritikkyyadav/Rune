// ─── Research Mode Types ───
// Deep-research ("DeepSearch") feature: the user asks a question, the agent
// PROPOSES a decomposed plan, the user APPROVES, and the agent fans out
// web (+optionally local) investigators, then synthesizes a cited report.
//
// The WIRE types (plan, sources, report, `ResearchEvent`) live in
// `@rune/protocol` — research streams over the protocol like any other event
// (P2.7) — and are re-exported here so research.ts, the Engine methods and the
// CLI/TUI renderers keep their existing import sites. `ResearchOptions` stays
// local: it carries a `ProviderName` and is a call-site options bag, not a
// wire shape.

import type { ProviderName } from "@rune/llm-gateway";
import type { ResearchDepth } from "@rune/protocol";

export type {
  ResearchDepth,
  SourceScope,
  ResearchSubQuestion,
  ResearchPlan,
  ResearchClarification,
  ResearchSource,
  SubQuestionResult,
  ResearchReport,
  ResearchEvent,
} from "@rune/protocol";
export { isClarification } from "@rune/protocol";

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
  /** Directory for saved reports. Default `<workspace>/.rune/research`. */
  outputDir?: string;
}
