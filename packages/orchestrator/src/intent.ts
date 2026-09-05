// ─── The Intent Interpreter: what shape of work is this? ───
//
// One question, asked once per task: is this an investigation, a build, an
// analysis, a research job, an operation, or a piece of writing? The answer
// picks the surface a person sees (Phase 11's composer projects from it) and
// nothing else — it never gates a tool, a permission, or a model choice, so a
// wrong reading costs a layout and never a capability.
//
// Two readings, in this order:
//
//  1. DETERMINISTIC, always. Zero tokens, zero latency, and right on the
//     overwhelming majority of real asks, because the verb of an English
//     request is a strong signal: "why is X slow" is an investigation and
//     "build me X" is a build, and no model call improves on that.
//  2. ONE small model call, and only when the deterministic reading found
//     nothing to go on. That is the case the call exists for. It is bounded
//     (a handful of tokens out), it answers with one word, anything else is
//     discarded, and its failure is not an error — the deterministic default
//     stands.
//
// The ordering is the point. A classifier in front of every task start is a
// tax on every task; a classifier behind an ambiguity gate is paid only by the
// asks that are genuinely ambiguous. The same asymmetry the task-boundary rule
// uses: make the common case free and the rare case cheap.
//
// The engine leaves the second reading OFF by default (`[intent] interpreter`,
// EngineConfig.intent). Two reasons, and the second is the one that decided it:
//
//  - What it buys is a LAYOUT. A wrong reading costs a projection and never a
//    capability, which is a poor return on a round-trip taken in the chat path
//    before the first token.
//  - It is a real provider call in the middle of a turn. Every scripted
//    provider in this repository — the eval mock, the ACP conformance client,
//    the browser-doctrine fixture — hands out responses in order, so a hidden
//    call at task start silently consumes one and the run downstream is a
//    different run. A capability that changes what the NEXT call receives is
//    not something to switch on for everybody by default.
//
// So `interpretIntent` takes `ask` as an argument rather than reaching for a
// gateway: with it, the second reading happens; without it, the first stands.

import type { TaskKind } from "@rune/protocol";
import { TASK_KINDS } from "@rune/protocol";

export type { TaskKind };

/** What the workspace looks like, as far as the reading is concerned. */
export interface WorkspaceSignals {
  /** The workspace holds a project (a manifest, a repo, source files). */
  hasProject?: boolean;
  /** The workspace is empty or near-empty — a build starts from nothing. */
  greenfield?: boolean;
}

export interface IntentReading {
  kind: TaskKind;
  /** Where the reading came from. `default` means nothing in the ask decided it. */
  source: "deterministic" | "model" | "default";
  /** True when something in the ask actually pointed at this kind. */
  confident: boolean;
}

/**
 * Verb-and-object patterns, strongest signal first. Order matters: "explain
 * why the query is slow" is an investigation, not a piece of writing, and
 * "write a test that reproduces it" is a build, not prose.
 */
const PATTERNS: Array<{ kind: TaskKind; re: RegExp }> = [
  // An investigation asks WHY, or names a symptom to be explained.
  {
    kind: "investigate",
    re: /\b(why|root[- ]cause|diagnos\w*|debug|troubleshoot|investigate|figure out why|what(?:'s| is) (?:wrong|causing|going on)|regress\w*|broke\w*|failing|crash\w*|leak\w*|flaky|hang\w*|slow(?:er|ed|ness)?)\b/i,
  },
  // Research goes OUTSIDE the workspace for an answer, with sources.
  {
    kind: "research",
    re: /\b(research|deep[- ]?dive|survey the|state of the art|literature|competitor|market|cite[ds]?|sources?|prior art|benchmark(?:s|ing)? (?:against|of)|compare (?:vendors|providers|tools|libraries))\b/i,
  },
  // Analysis reads data that already exists and reports what it says.
  {
    kind: "analyze",
    re: /\b(analy[sz]\w*|audit|review|assess|measure|profile|quantify|statistics|metrics|breakdown|how (?:many|much)|trends?|correlat\w*|distribution)\b/i,
  },
  // An operation acts on a running system.
  {
    kind: "operate",
    re: /\b(deploy|rollback|roll back|restart|provision|migrat(?:e|ion) (?:the )?(?:db|database|prod|production)|scale (?:up|down|out)|failover|cut over|release to|publish to|rotate (?:the )?(?:key|secret|credential)|incident|on[- ]call|patch production)\b/i,
  },
  // Writing produces prose for a person to read.
  {
    kind: "write",
    re: /\b(write (?:up|a (?:doc|readme|post|essay|report|summary|spec|proposal|email|memo|changelog))|draft|document(?:ation)?|readme|blog|changelog|release notes|summar(?:ise|ize) (?:this|the)|explain (?:to|for) (?:the|a) (?:team|reader|audience))\b/i,
  },
  // A build changes the tree.
  {
    kind: "build",
    re: /\b(build|implement|add|create|make|write (?:a|the|some)? ?(?:function|class|module|component|script|test|endpoint|api|cli|app|page|feature)|refactor|rename|port|migrate|wire|fix|patch|support for|set ?up|scaffold|clone)\b/i,
  },
];

/**
 * Read the ask, with no model call. `confident` is false when nothing matched
 * — that is the gate the model call sits behind.
 */
export function readIntent(message: string, signals: WorkspaceSignals = {}): IntentReading {
  const text = message.trim();
  if (!text) return { kind: "build", source: "default", confident: false };
  for (const { kind, re } of PATTERNS) {
    if (re.test(text)) return { kind, source: "deterministic", confident: true };
  }
  // Nothing matched. A question mark with no verb is a question about the
  // world or the code, which is an investigation either way; an empty
  // workspace with an imperative is a build. Neither is confident.
  if (/\?\s*$/.test(text)) return { kind: "investigate", source: "default", confident: false };
  if (signals.greenfield) return { kind: "build", source: "default", confident: false };
  return { kind: "build", source: "default", confident: false };
}

/**
 * The whole prompt. Deliberately tiny — the answer is one word, the model has
 * no tools, and a wrong answer costs a layout.
 */
export const INTENT_INTERPRETER_PROMPT =
  "Classify this request as exactly one of: investigate, build, analyze, research, operate, write.\n" +
  "investigate = find out why something behaves as it does. build = change or create code.\n" +
  "analyze = read existing data and report what it says. research = gather outside sources.\n" +
  "operate = act on a running system. write = produce prose for a person.\n" +
  "Answer with one word and nothing else.";

/** The one word, if it is one of the six. Anything else is not an answer. */
export function parseTaskKind(raw: string): TaskKind | null {
  const word = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return (TASK_KINDS as readonly string[]).includes(word) ? (word as TaskKind) : null;
}

export interface InterpretOptions {
  message: string;
  signals?: WorkspaceSignals;
  /**
   * The one small model call. Supplied by the Engine (a non-streaming request
   * with a handful of output tokens); omitted by embedders, tests and any
   * session without a gateway, in which case the deterministic reading stands
   * — which is a correct outcome, not a degraded one.
   */
  ask?: (prompt: string, question: string) => Promise<string>;
  /** How long the call gets before the deterministic reading wins. */
  timeoutMs?: number;
}

/**
 * The interpreter. Never throws, never blocks longer than `timeoutMs`, and
 * never returns something outside the union.
 */
export async function interpretIntent(opts: InterpretOptions): Promise<IntentReading> {
  const local = readIntent(opts.message, opts.signals ?? {});
  if (local.confident || !opts.ask) return local;

  const timeoutMs = opts.timeoutMs ?? 4_000;
  try {
    const answer = await Promise.race([
      opts.ask(INTENT_INTERPRETER_PROMPT, opts.message.slice(0, 2_000)),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), timeoutMs).unref?.()),
    ]);
    const kind = parseTaskKind(answer ?? "");
    if (kind) return { kind, source: "model", confident: true };
  } catch {
    // A classifier that cannot be reached is not a failed task. The
    // deterministic reading below is what the surface composes from.
  }
  return local;
}
