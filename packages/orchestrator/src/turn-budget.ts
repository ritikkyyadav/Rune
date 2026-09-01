// ─── How many turns a message deserves ───
//
// Measured, from the session log: a 24-character question — "well why are
// you quite ?" — entered the same 80-turn agent loop as a 900-line build
// spec, resumed the open mission, and burned 80 completions and 53 minutes
// answering a question whose answer was one sentence. Claude Code answers
// the same class of message in one completion. The multiplier is the whole
// latency story: completions per user turn, not seconds per completion.
//
// So the budget now scales with the message. The classification is
// deliberately conservative and purely mechanical (no model call — a
// classifier that costs a completion would be the disease as the cure):
// only unambiguously conversational shapes get the small budget — greetings
// and short questions with no imperative verb and no workspace reference.
// Everything else keeps the full ceiling. A misread costs little either
// way: a small-budget run that turns out to be real work hits its ceiling
// in minutes, wraps up honestly, and the user's "continue" (an imperative)
// gets the full budget back.

/** What a user message earns before the loop starts. */
export interface TurnBudget {
  maxTurns: number;
  /** True when the small conversational budget applied. */
  conversational: boolean;
  /** Harness note steering the model to answer first; only on conversational turns. */
  note?: string;
}

/** The conversational ceiling: room to check something, not to build something. */
export const CONVERSATIONAL_MAX_TURNS = 8;

/** Greetings, thanks, acknowledgements — smalltalk with nothing to execute. */
const SMALLTALK_RE =
  /^(?:well\s+|so\s+|ok(?:ay)?\s+)*(?:hi+|hii+|hello+|hey+|yo|sup|howdy|thanks?|thank you|thx|ty|ok(?:ay)?|cool|nice|great|awesome|perfect|good (?:morning|afternoon|evening|night)|good job|well done|lol|haha+|hm+|hmm+)\b[\s\S]{0,40}$/i;

/**
 * Verbs that make a short message WORK rather than conversation. Broad on
 * purpose: the cost of wrongly granting the full budget is zero, the cost of
 * wrongly granting the small one is a clipped task.
 */
const IMPERATIVE_RE =
  /\b(?:fix|build|make|create|write|add|implement|change|update|delete|remove|install|refactor|improve|test|verify|deploy|ship|run|execute|start|restart|stop|launch|setup|configure|migrate|convert|rename|move|copy|push|commit|merge|rebase|revert|scan|search|find|look|check|inspect|audit|review|analyze|analyse|debug|investigate|generate|scaffold|render|draw|design|plan|open|show|preview|compare|measure|benchmark|optimi[sz]e|clean|format|lint|compile|rebuild|redo|retry|resume|proceed|continue|go ahead|do it|keep going)\b/i;

/** Paths, extensions, code ticks, flags — the message points INTO the workspace. */
const WORKSPACE_TOKEN_RE = /[/\\`]|--?\w{2,}|\.\w{1,5}\b/;

/**
 * The budget a message earns. `fullBudget` is the engine's ceiling; the
 * conversational budget never exceeds it.
 */
export function turnBudgetForMessage(message: string, fullBudget: number): TurnBudget {
  const trimmed = (message ?? "").trim();
  const full: TurnBudget = { maxTurns: fullBudget, conversational: false };
  if (!trimmed) return full;
  // Anything long, multi-line, or workspace-pointing is work.
  if (trimmed.length > 140 || trimmed.includes("\n")) return full;

  const bare = trimmed.replace(/[\s!?.]+$/g, "");
  const smalltalk = SMALLTALK_RE.test(bare);
  const shortQuestion =
    trimmed.endsWith("?") && !IMPERATIVE_RE.test(trimmed) && !WORKSPACE_TOKEN_RE.test(trimmed);
  if (!smalltalk && !shortQuestion) return full;

  return {
    maxTurns: Math.min(CONVERSATIONAL_MAX_TURNS, fullBudget),
    conversational: true,
    note:
      "The user's message reads as conversation or a question, not new work: answer it directly, in prose, and end your turn. " +
      "Do not resume the broader task or start tool-driven work unless the answer genuinely requires it — if the mission should continue, say what you would do next and stop.",
  };
}
