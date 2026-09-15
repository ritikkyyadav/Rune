// ─── The visual record: blind, rubric-bound, and never a score ───
//
// `visual-verification.ts` answers "did anyone LOOK at this?" — a mechanical
// question about receipts. This file answers the other half, the one the
// handoff's Phase 5 asks for and nothing in the harness had: what did the
// screen look like, judged against a rubric written before the run, by
// something that is not the model that produced it.
//
// Four rules make the answer worth having, and each is enforced here rather
// than asked for in a prompt:
//
//   1. INDEPENDENT. The reviewer must not be the generating model, and not
//      even its family: a model reviewing its own output shares its blind
//      spots, and two checkpoints of one family share most of them. With no
//      independent reviewer configured, the record says `no independent
//      reviewer` and NOTHING ELSE HAPPENS — no call, no findings, no fallback
//      to the generator. An absent review is information; a self-review
//      dressed as one is not.
//   2. BLIND. The reviewer is given the rubric and the captures. It is not
//      given the request, the plan, the art direction, or the model's own
//      account of what it built — all of which are arguments for the screen
//      being good, and none of which are visible to the person who will use it.
//   3. RUBRIC-BOUND. Eight named criteria, fixed in `docs/program/visual-rubric.json`
//      and versioned. Every criterion is answered pass / fail / unclear with
//      one quoted line. "unclear" is a real answer.
//   4. NEVER A SCORE. No number is produced, parsed, or stored — and a
//      reviewer that returns one has the number stripped out of its line. The
//      handoff bans "an arbitrary numeric design score from the generating
//      model"; a number from any model is the same bad object, because it
//      launders a judgement into a measurement.
//
// The result is recorded as evidence with `verifier: "visual-review@1:<model>"`
// on a criterion whose `method` is `{ kind: "review" }`, which M1's
// `criterionStatus` derives as `needs_review` and never as `satisfied`. A
// second model supplements a person's judgement; it cannot certify in its place.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import rubricJson from "../../../docs/program/visual-rubric.json";

// ─── The rubric ───

export interface VisualRubricCriterion {
  id: string;
  name: string;
  asks: string;
  fail_when: string;
  unclear_when?: string;
  /** Captures this criterion cannot be answered without. */
  needs?: string[];
}

export interface VisualRubric {
  id: string;
  version: number;
  written: string;
  purpose: string;
  verdicts: string[];
  rules: string[];
  criteria: VisualRubricCriterion[];
}

export const VISUAL_RUBRIC = rubricJson as VisualRubric;

/** `visual-rubric@1` — the rubric identity that goes on every record. */
export function rubricRef(rubric: VisualRubric = VISUAL_RUBRIC): string {
  return `${rubric.id}@${rubric.version}`;
}

// ─── Picking a reviewer that is not the thing it is reviewing ───

/**
 * The coarse family of a model, for the "not the same blind spots" test.
 *
 * Independence is by model LINEAGE, read out of the id — not by provider id.
 * A Claude model served through openrouter is still Anthropic's model with
 * Anthropic's blind spots, and an openrouter account that can reach both a
 * Claude and a GPT model can still produce an independent review.
 *
 * Deliberately coarse and deliberately fail-closed in both directions: a
 * pattern matches ANYWHERE in the id rather than on a word boundary, because
 * the cost of collapsing two unrelated models into one family is a review that
 * does not run, and the cost of splitting one vendor's models into two is a
 * model reviewing itself. `openai/chatgpt-4o-latest` used to read as
 * `provider:openai` — the `gpt` probe required a non-letter before "gpt", and
 * "chatgpt" has an "a" — which made OpenAI's own 4o checkpoint an "independent"
 * reviewer of `openai/gpt-4o`.
 *
 * An id this does not recognise gets its own family derived from the provider;
 * `independentOf` then adds the rule that makes that honest.
 */
export function modelFamily(provider: string, model: string): string {
  const m = `${model}`.toLowerCase();
  if (/claude|anthropic|sonnet|haiku|opus/.test(m)) return "claude";
  if (/gpt|(^|[^a-z])o[134]([^a-z]|$)|codex|davinci/.test(m)) return "gpt";
  if (/gemini|palm|bison|gemma/.test(m)) return "gemini";
  if (/llama/.test(m)) return "llama";
  if (/mistral|mixtral|codestral|magistral|devstral/.test(m)) return "mistral";
  if (/qwen/.test(m)) return "qwen";
  if (/deepseek/.test(m)) return "deepseek";
  if (/grok/.test(m)) return "grok";
  if (/command-?[ar]|cohere/.test(m)) return "cohere";
  if (/glm|kimi|minimax|yi-/.test(m)) return m.split(/[-/:]/)[0] ?? m;
  return `provider:${provider.toLowerCase()}`;
}

/** An id no pattern recognised — the family is a guess from the provider. */
const unrecognised = (family: string): boolean => family.startsWith("provider:");

/**
 * Can `candidate` review `generator`'s work?
 *
 * Two rules. Different lineages, which is the property the rubric wants. And,
 * where either id is UNRECOGNISED, not the same provider: an id the table does
 * not know tells us nothing about its lineage, and the one thing that is known
 * about it is who serves it. Without the second rule `provider:openai` and
 * `gpt` read as different strings and a provider's own new checkpoint reviews
 * its own older one — fail-closed for unknown-vs-unknown, wide open for
 * unknown-vs-known, which is the shape the v7 pass found.
 */
export function independentOf(generator: ReviewerIdentity, candidate: ReviewerIdentity): boolean {
  const own = modelFamily(generator.provider, generator.model);
  const theirs = modelFamily(candidate.provider, candidate.model);
  if (own === theirs) return false;
  if (
    (unrecognised(own) || unrecognised(theirs)) &&
    generator.provider.toLowerCase() === candidate.provider.toLowerCase()
  )
    return false;
  return true;
}

export interface ReviewerIdentity {
  provider: string;
  model: string;
}

/** `provider/model`, the label that goes in the verifier string. */
export function reviewerRef(who: ReviewerIdentity): string {
  return `${who.provider}/${who.model}`;
}

/**
 * The first candidate from a DIFFERENT model family than the generator, or
 * null. Null is a legitimate, common answer — most sessions have one provider
 * connected — and it means the review does not run at all.
 */
export function pickVisualReviewer(inputs: {
  generator: ReviewerIdentity;
  /** Connected, funded-or-subscription candidates, in preference order. */
  candidates: readonly ReviewerIdentity[];
}): ReviewerIdentity | null {
  for (const candidate of inputs.candidates)
    if (independentOf(inputs.generator, candidate)) return candidate;
  return null;
}

// ─── Running the rubric ───

export type CriterionVerdict = "pass" | "fail" | "unclear";

export interface VisualCapture {
  /** Absolute path to a preserved screenshot. */
  path: string;
  /** Viewport width, when the capture recorded one. */
  width?: number;
  /** What the capture is of: "wide", "narrow", "focus", "empty", "reference"… */
  label?: string;
}

/**
 * Everything the reviewer is shown. There is no field for the request, the
 * plan, or the model's report — the type is the blindness, so a future caller
 * cannot leak the prompt in by passing "just a bit of context".
 */
export interface VisualReviewPrompt {
  instructions: string;
  rubric: Array<{ id: string; name: string; asks: string; fail_when: string }>;
  captures: Array<{ path: string; width?: number; label?: string }>;
}

export interface VisualReviewFinding {
  id: string;
  name: string;
  verdict: CriterionVerdict;
  /** One line from the reviewer quoting what settles it. Never a number. */
  quote: string;
}

export interface VisualReviewRecord {
  /** `visual-rubric@1`. */
  rubric: string;
  /** `visual-review@1:<provider>/<model>`, or null when none ran. */
  verifier: string | null;
  /** Why no findings exist, when that is the case. */
  reason?: "no independent reviewer" | "no captures to review";
  reviewedAt: string;
  captures: string[];
  findings: VisualReviewFinding[];
  /** One line per `fail` — what a person should look at first. */
  defects: string[];
}

const INSTRUCTIONS = [
  "You are reviewing screenshots of a user interface against a fixed rubric.",
  "You are not told what was asked for, who built it, or why. Judge only what the captures show.",
  "Answer EVERY criterion with exactly one line: `<id>: <pass|fail|unclear> — <one sentence naming what in the capture settles it>`.",
  "Use `unclear` whenever the captures cannot show the criterion. It is a real answer, not a hedge.",
  "Do not give a score, a grade, a rating, a percentage, or a total. There is no number in a correct answer.",
  "Do not suggest fixes. Say what you see.",
].join("\n");

export function buildVisualReviewPrompt(
  captures: readonly VisualCapture[],
  rubric: VisualRubric = VISUAL_RUBRIC,
): VisualReviewPrompt {
  return {
    instructions: INSTRUCTIONS,
    rubric: rubric.criteria.map((c) => ({
      id: c.id,
      name: c.name,
      asks: c.asks,
      fail_when: c.fail_when,
    })),
    captures: captures.map((c) => ({
      path: basename(c.path),
      ...(c.width !== undefined ? { width: c.width } : {}),
      ...(c.label ? { label: c.label } : {}),
    })),
  };
}

/**
 * Remove anything that reads as a score from a reviewer's line.
 *
 * Measurements a reviewer legitimately quotes ("the 390px capture", "12px
 * label text") are numbers ABOUT the screen and stay. A grade is a number
 * about the review, and there is no correct one — so `8/10`, `score: 85`,
 * `7 out of 10`, `rating 4/5`, `B+` are struck out where they appear.
 */
export function stripScore(line: string): string {
  return line
    .replace(/\b(?:score|rating|grade|overall)\b\s*[:=]?\s*[-+]?\d+(?:\.\d+)?%?/gi, "")
    .replace(/\b\d+(?:\.\d+)?\s*(?:\/|out\s+of)\s*\d+\b/gi, "")
    .replace(/\b(?:score|rating|grade)\b\s*[:=]?\s*[A-F][+-]?\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;])/g, "$1")
    .trim();
}

/** Parse the reviewer's reply into one finding per rubric criterion. */
export function parseVisualReview(
  reply: string,
  rubric: VisualRubric = VISUAL_RUBRIC,
): VisualReviewFinding[] {
  const byId = new Map<string, { verdict: CriterionVerdict; quote: string }>();
  for (const raw of reply.split("\n")) {
    const line = raw.replace(/^[-*\d.\s]+/, "").trim();
    const match = /^([a-z0-9-]+)\s*[::]\s*(pass|fail|unclear)\b[\s—–:-]*(.*)$/i.exec(line);
    if (!match) continue;
    const id = match[1]!.toLowerCase();
    if (byId.has(id)) continue; // first answer wins; a reviewer may not revise
    byId.set(id, {
      verdict: match[2]!.toLowerCase() as CriterionVerdict,
      quote: stripScore(match[3] ?? ""),
    });
  }
  return rubric.criteria.map((c) => {
    const answer = byId.get(c.id);
    if (!answer) {
      return {
        id: c.id,
        name: c.name,
        verdict: "unclear" as const,
        quote: "the reviewer did not answer for this criterion",
      };
    }
    return {
      id: c.id,
      name: c.name,
      verdict: answer.verdict,
      quote: answer.quote || "the reviewer gave no reason",
    };
  });
}

/**
 * Run the rubric over the preserved captures.
 *
 * `ask` is injected: it is the one call this makes, and the caller owns which
 * gateway, budget and timeout it runs under. Tests script it and assert it is
 * never called when there is no independent reviewer.
 */
export async function runVisualReview(opts: {
  captures: readonly VisualCapture[];
  reviewer: ReviewerIdentity | null;
  ask: (prompt: VisualReviewPrompt, reviewer: ReviewerIdentity) => Promise<string>;
  rubric?: VisualRubric;
  now?: () => Date;
}): Promise<VisualReviewRecord> {
  const rubric = opts.rubric ?? VISUAL_RUBRIC;
  const at = (opts.now?.() ?? new Date()).toISOString();
  const base: VisualReviewRecord = {
    rubric: rubricRef(rubric),
    verifier: null,
    reviewedAt: at,
    captures: opts.captures.map((c) => c.path),
    findings: [],
    defects: [],
  };
  // No independent reviewer: record the absence and do nothing else. Not the
  // generating model, not a weaker one, not "best effort".
  if (!opts.reviewer) return { ...base, reason: "no independent reviewer" };
  if (opts.captures.length === 0) return { ...base, reason: "no captures to review" };

  const prompt = buildVisualReviewPrompt(opts.captures, rubric);
  const reply = await opts.ask(prompt, opts.reviewer);
  const findings = parseVisualReview(reply, rubric);
  return {
    ...base,
    verifier: `visual-review@1:${reviewerRef(opts.reviewer)}`,
    findings,
    defects: findings.filter((f) => f.verdict === "fail").map((f) => `${f.name}: ${f.quote}`),
  };
}

// ─── The record, as acceptance and as files on disk ───

/**
 * The criterion a visual review attaches to.
 *
 * `method: { kind: "review" }` is the whole point: M1's `criterionStatus`
 * derives that as `needs_review` before it looks at any evidence, so no amount
 * of reviewer enthusiasm can move it to `satisfied`. `source: "evaluator"`
 * keeps `record_evidence` from letting the model cite it.
 */
export function visualReviewCriterion(record: VisualReviewRecord): {
  id: string;
  text: string;
  rung: null;
  source: "evaluator";
  required: false;
  method: { kind: "review" };
} {
  return {
    id: "visual-review",
    text: `the screen is reviewed against ${record.rubric} by an independent reviewer`,
    rung: null,
    source: "evaluator",
    required: false,
    method: { kind: "review" },
  };
}

/** The evidence row for a completed review. Null when none ran. */
export function visualReviewEvidence(
  record: VisualReviewRecord,
): { verifier: string; result: "passed" | "failed"; detail: string } | null {
  if (!record.verifier) return null;
  return {
    verifier: record.verifier,
    // A `fail` on any criterion is a failed review. There is no score, so
    // there is no threshold to argue about.
    result: record.defects.length === 0 ? "passed" : "failed",
    detail:
      record.defects.length === 0
        ? `${record.findings.filter((f) => f.verdict === "pass").length} of ${record.findings.length} criteria pass, none fail`
        : record.defects.join("; ").slice(0, 400),
  };
}

/** Where a session's preserved visual evidence lives. */
export function visualEvidenceDir(sessionId: string, home: string): string {
  return join(home, "evidence", sessionId, "visual-review");
}

/**
 * Preserve the captures and the record together, so the defect list can never
 * be read without the pictures it was written from. Returns the directory.
 */
export function preserveVisualReview(
  record: VisualReviewRecord,
  dir: string,
): { dir: string; files: string[] } {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const kept: string[] = [];
  for (const source of record.captures) {
    if (!existsSync(source)) continue;
    const target = join(dir, basename(source));
    try {
      copyFileSync(source, target);
      files.push(target);
      kept.push(basename(source));
    } catch {
      /* an unreadable capture is not a reason to lose the record */
    }
  }
  const stored: VisualReviewRecord = { ...record, captures: kept };
  const json = join(dir, "visual-review.json");
  writeFileSync(json, JSON.stringify(stored, null, 2) + "\n");
  files.push(json);
  const defects = join(dir, "defects.md");
  writeFileSync(defects, renderVisualReview(stored) + "\n");
  files.push(defects);
  return { dir, files };
}

/** The human page: what was reviewed, by whom, and what it said. */
export function renderVisualReview(record: VisualReviewRecord): string {
  const lines = [`# Visual review — ${record.rubric}`, ""];
  lines.push(`Reviewer: ${record.verifier ?? "none"}${record.reason ? ` (${record.reason})` : ""}`);
  lines.push(`Reviewed: ${record.reviewedAt}`);
  lines.push(
    `Captures: ${record.captures.length > 0 ? record.captures.join(", ") : "none preserved"}`,
  );
  if (record.findings.length === 0) {
    lines.push("", "No rubric findings were produced.");
    return lines.join("\n");
  }
  lines.push("", "| criterion | verdict | what settles it |", "| --- | --- | --- |");
  for (const f of record.findings) {
    lines.push(`| ${f.name} | ${f.verdict} | ${f.quote.replace(/\|/g, "\\|")} |`);
  }
  lines.push("", record.defects.length === 0 ? "No defects recorded." : "## Defects");
  for (const d of record.defects) lines.push(`- ${d}`);
  return lines.join("\n");
}
