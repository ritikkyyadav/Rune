/**
 * Compaction-quality evals (P10.8) — what a long session LOSES when its
 * transcript is squashed.
 *
 * The competitive audit's Gap 6 ("compaction can eat its own summaries") was
 * answered with a structured-state merge, and nothing measured whether the
 * merge actually carries the run's facts across. Compaction had exactly one
 * eval before this file — `spine_todos_survive_compaction`, which asserts that
 * a marker and a todo string appear afterwards. A summary can satisfy that and
 * still have amnesia'd every decision the user stated, every path the run
 * touched, and every fact a tool result taught it.
 *
 * ── The instrument ──
 *
 * Compaction quality has two halves and only one belongs to the harness: what
 * the harness FEEDS the summarizer and what it does with the answer, versus
 * what the model makes of it. Measuring against a canned reply measures
 * neither. So these tasks drive a FAITHFUL summarizer: it carries forward
 * every sentinel it is handed and invents nothing. Under it, any fact missing
 * from the post-compaction prompt is a fact the harness dropped before the
 * model ever saw it — which is the half that can be fixed here.
 *
 * Facts are planted as sentinels (`DECISION-n`, `FACT-n`) in user prompts and
 * in tool results, so survival is a substring test on the request the provider
 * actually received rather than a judgement about prose.
 *
 * ── The rig ──
 *
 * `mock-model` gets a registered 60k window (`teardown` gives it back), which
 * is small enough that the tail budget (30%) and the target (50%) are real
 * constraints instead of rounding errors against the 100k default. Compaction
 * is then driven two ways: explicitly with `compact_context` (deterministic,
 * forced, always summarizes) and naturally by crossing the high-water mark
 * with bulky tool results (which takes the eviction tier).
 */

import { writeFile } from "fs/promises";
import { join } from "path";
import { Database } from "bun:sqlite";

import type { EvalTask } from "./harness";
import type { SummaryRequest } from "./mock-provider";
import {
  countTokens,
  registerContextLimit,
  UNKNOWN_MODEL_CONTEXT_LIMIT,
} from "../../packages/orchestrator/src/tokenizer";

// ─── The rig ───

/**
 * The window `mock-model` runs under for this family. Above the ~19.5k floor
 * of system prompt + 29 tool schemas (so a run is possible at all) and low
 * enough that 30% of it is a tail a scripted session can overflow.
 */
const MOCK_WINDOW = 60_000;

const registerWindow = (): void => registerContextLimit("mock-model", MOCK_WINDOW);
/** Hand the default back, so the next task in the suite runs unrigged. */
const restoreWindow = (): void => registerContextLimit("mock-model", UNKNOWN_MODEL_CONTEXT_LIMIT);

/** Section labels the context engine asks its summarizer to use, verbatim. */
const SECTIONS = [
  "## Goals & requirements",
  "## Key facts & codebase knowledge",
  "## Actions taken & outcomes (files touched, commands run)",
  "## Decisions & open questions",
  "## Current state & next step",
] as const;

const PRIOR_MARK = "\n\nPRIOR STATE:\n";
const SEGMENT_MARK = "\n\nNew conversation segment:\n";
const CONVERSATION_MARK = "\n\nConversation:\n";

/** The two halves of a compaction request: accumulated state, and new text. */
export function splitSummaryRequest(text: string): { prior: string; segment: string } {
  const p = text.indexOf(PRIOR_MARK);
  if (p >= 0) {
    const rest = text.slice(p + PRIOR_MARK.length);
    const s = rest.indexOf(SEGMENT_MARK);
    if (s >= 0) {
      return { prior: rest.slice(0, s), segment: rest.slice(s + SEGMENT_MARK.length) };
    }
    return { prior: rest, segment: "" };
  }
  const c = text.indexOf(CONVERSATION_MARK);
  return { prior: "", segment: c >= 0 ? text.slice(c + CONVERSATION_MARK.length) : text };
}

/**
 * `DECISION-3`, `FACT-11` — one sentinel, matched anywhere.
 *
 * No leading `\b`: a tool result reaches the summarizer as JSON, where the
 * two characters before the token are a literal backslash and `t` (an escaped
 * tab). Both are word characters, so a word boundary never matches there and
 * the extractor silently saw nothing in exactly the place that matters.
 */
const SENTINEL = /(DECISION|FACT)-\d+\b/g;

/** Every sentinel in a blob, in first-seen order, deduplicated. */
function sentinels(blob: string): string[] {
  const seen = new Set<string>();
  for (const m of blob.matchAll(SENTINEL)) seen.add(m[0]);
  return [...seen];
}

/**
 * The statement each sentinel was made in (first occurrence wins): the text
 * from the token to the end of its line, where "line" means a real newline, a
 * JSON-escaped one, or the end of a JSON string — so one statement comes back
 * per sentinel whether it was in prose or inside a tool result's payload.
 */
function sentinelLines(blob: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of blob.matchAll(SENTINEL)) {
    const key = m[0];
    if (out.has(key)) continue;
    const window = blob.slice(m.index ?? 0, (m.index ?? 0) + 180);
    const ends = [window.indexOf("\n"), window.indexOf("\\n"), window.indexOf('","')].filter(
      (i) => i >= 0,
    );
    out.set(key, window.slice(0, ends.length > 0 ? Math.min(...ends) : window.length).trim());
  }
  return out;
}

/**
 * The mission line, carried forward once rather than re-bulleted every merge.
 * Prior state wins; otherwise the segment's first user turn.
 */
function goalLine(prior: string, segment: string): string {
  const carried = /^- goal: (.+)$/m.exec(prior);
  if (carried) return carried[1];
  const first = /^user: (.+)$/m.exec(segment);
  return first ? first[1].slice(0, 300) : "(not stated in this segment)";
}

/**
 * A summarizer that cannot lie in either direction: it emits one line per
 * distinct sentinel it was handed — from the prior state and from the new
 * segment both — and nothing else. It never invents a fact and never drops
 * one, so what is missing downstream was missing upstream.
 *
 * The output uses the engine's own section labels, because the merge path
 * re-parses its own previous output and stable labels are the contract.
 */
export function faithfulSummarizer(req: SummaryRequest): string {
  const { prior, segment } = splitSummaryRequest(req.text);
  const lines = new Map<string, string>();
  for (const [k, v] of sentinelLines(prior)) lines.set(k, v);
  for (const [k, v] of sentinelLines(segment)) if (!lines.has(k)) lines.set(k, v);

  const decisions = [...lines.entries()].filter(([k]) => k.startsWith("DECISION"));
  const facts = [...lines.entries()].filter(([k]) => k.startsWith("FACT"));
  // Paths the segment (or the prior state) named — the file ledger's half of
  // the record that lives in prose rather than in the spine.
  const paths = new Set<string>();
  for (const m of (prior + "\n" + segment).matchAll(/\b(?:src|lib)\/[\w./-]+\.ts\b/g)) {
    paths.add(m[0]);
  }

  return [
    SECTIONS[0],
    `- goal: ${goalLine(prior, segment)}`,
    ...decisions.map(([, v]) => `- ${v}`),
    SECTIONS[1],
    ...facts.map(([, v]) => `- ${v}`),
    SECTIONS[2],
    ...[...paths].sort().map((p) => `- touched ${p}`),
    SECTIONS[3],
    "- (carried forward verbatim by the eval's faithful summarizer)",
    SECTIONS[4],
    "- continue with the next open step on the plan",
  ].join("\n");
}

// ─── Reading what the model was actually sent ───

/** Flatten one request's messages to the text the provider received. */
function requestText(messages: Array<{ content: unknown[] }> | undefined): string {
  if (!messages) return "";
  return messages
    .flatMap((m) => m.content as Array<Record<string, unknown>>)
    .map((b) => {
      if (b.type === "text") return String(b.text ?? "");
      if (b.type === "tool_use")
        return `[tool: ${String(b.toolName)}(${JSON.stringify(b.toolInput)})]`;
      if (b.type === "tool_result") return `[result: ${String(b.toolResultContent ?? "")}]`;
      return "";
    })
    .join("\n");
}

const SUMMARY_MARKER = "[Earlier conversation summary]";
const SPINE_MARKER = "[Task state — maintained by the harness";

export interface CompactionRow {
  beforeTokens: number;
  afterTokens: number;
  summarizedCount: number;
  forced: boolean;
  tier: string | null;
  trigger: string | null;
}

/** Every auto-compaction the session log recorded, in order. */
function compactions(dbPath: string, sessionId: string): CompactionRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT payload_json FROM events WHERE session_id = ? AND type = 'auto_compaction' ORDER BY seq",
      )
      .all(sessionId) as Array<{ payload_json: string }>;
    return rows.map((r) => {
      const p = (JSON.parse(r.payload_json)?.payload ?? {}) as Record<string, unknown>;
      return {
        beforeTokens: Number(p.beforeTokens ?? 0),
        afterTokens: Number(p.afterTokens ?? 0),
        summarizedCount: Number(p.summarizedCount ?? 0),
        forced: p.forced === true,
        tier: typeof p.tier === "string" ? p.tier : null,
        trigger: typeof p.trigger === "string" ? p.trigger : null,
      };
    });
  } finally {
    db.close();
  }
}

/** How many auto-compactions the session log recorded. */
function compactionRows(dbPath: string, sessionId: string): number {
  return compactions(dbPath, sessionId).length;
}

/** The guard on every task here: nothing was tested if nothing was compacted. */
function compactionHappened(
  text: string,
  dbPath: string,
  sessionId: string,
  atLeast: number,
): string | null {
  if (!text.includes(SUMMARY_MARKER)) {
    return "the final request carries no summary — the transcript was never compacted";
  }
  const rows = compactionRows(dbPath, sessionId);
  if (rows < atLeast) {
    return `only ${rows} compaction${rows === 1 ? "" : "s"} recorded; the drill needs ${atLeast}`;
  }
  return null;
}

// ─── The scripted session ───

const SPEC = `# Ledger service

DECISION-1: SQLite, not Postgres — the local case is the whole product.
DECISION-2: every write goes through one append-only path; no in-place updates.
`;

const NOTES = `FACT-1: the append path is src/ledger/append.ts and nothing else writes rows.
FACT-2: schema migrations live in src/ledger/schema.ts, applied on open.
`;

const WIRE = `FACT-3: the wire format is one JSON object per line, no envelope.
FACT-4: clock skew is tolerated by storing the receipt time, never the client's.
`;

const mod = (n: string, body: string): string => `export const ${n} = () => {\n  ${body}\n};\n`;

/**
 * Eight modules, so the file ledger is longer than any one render window's
 * convenience slice — a ledger that only remembers its last few files is a
 * ledger the model cannot use to answer "what have I already built".
 */
const MODULES = [
  "src/ledger/append.ts",
  "src/ledger/schema.ts",
  "src/ledger/wire.ts",
  "src/ledger/clock.ts",
  "src/ledger/query.ts",
  "src/ledger/compact.ts",
  "src/ledger/index.ts",
  "src/ledger/errors.ts",
];

const write = (path: string, i: number) => ({
  name: "write_file",
  args: { path, content: mod(`m${i}`, `return ${i};`) },
});

const read = (path: string) => ({ name: "read_file", args: { path } });
const compact = () => ({ name: "compact_context", args: {} });

const PLAN = [
  "read the spec and the notes",
  "build the eight ledger modules",
  "check the build",
  "report what was built",
];

const todos = (done: number) => ({
  name: "todo_write",
  args: {
    items: PLAN.map((content, i) => ({
      content,
      status: i < done ? "completed" : i === done ? "in_progress" : "pending",
    })),
  },
});

/**
 * Spare end-turn responses. The finish gate legitimately spends one model turn
 * asking a run not to end on an open plan, and a script that budgeted for zero
 * of those dies of "script exhausted" — which reads as a compaction failure
 * and is not one.
 */
const SPARES = [
  { text: "Everything on the plan is done; wrapping up." },
  { text: "Nothing further to do." },
  { text: "Done." },
];

/**
 * A long session with four forced compactions spread through it. Facts are
 * planted in the first three turns — before compaction #1 — so every one of
 * them has to survive four merge cycles to reach the final request.
 */
const LONG_SESSION = [
  { text: "Recording the plan first.", toolCalls: [todos(0)] },
  { toolCalls: [read("spec.md")] },
  { toolCalls: [read("notes.md")] },
  { toolCalls: [read("wire.md")] },
  { text: "Spec absorbed. Building.", toolCalls: [todos(1)] },
  // One bulk read before each compaction, so every fold has real material.
  // Without it the head is a handful of small messages and the merged state
  // is bigger than what it replaces — which compaction now declines to do.
  { toolCalls: [read("bulk-0.txt"), write(MODULES[0], 0), write(MODULES[1], 1)] },
  { toolCalls: [compact()] }, // ── compaction 1
  { toolCalls: [read("bulk-1.txt"), write(MODULES[2], 2), write(MODULES[3], 3)] },
  { toolCalls: [compact()] }, // ── compaction 2
  { toolCalls: [read("bulk-2.txt"), write(MODULES[4], 4), write(MODULES[5], 5)] },
  { toolCalls: [compact()] }, // ── compaction 3
  { toolCalls: [read("bulk-3.txt"), write(MODULES[6], 6), write(MODULES[7], 7)] },
  { text: "All eight written.", toolCalls: [todos(2)] },
  { toolCalls: [compact()] }, // ── compaction 4
  {
    text: "Checking the build.",
    toolCalls: [{ name: "bash", args: { command: "ls src/ledger | wc -l" } }],
  },
  { text: "Eight modules present.", toolCalls: [todos(3)] },
  { toolCalls: [read(MODULES[0])] },
  { text: "Reported.", toolCalls: [todos(4)] },
  { text: "Built the eight-module ledger per DECISION-1 and DECISION-2." },
  ...SPARES,
];

const setupWorkspace = async ({ workspace }: { workspace: string }): Promise<void> => {
  registerWindow();
  await writeFile(join(workspace, "spec.md"), SPEC);
  await writeFile(join(workspace, "notes.md"), NOTES);
  await writeFile(join(workspace, "wire.md"), WIRE);
};

// ─── The pressure session ───
// The forced drill above never crosses the high-water mark, so it only ever
// exercises the summarizing tier. A real long run crosses it first, and the
// CHEAP tier — stripping old tool-result bodies — runs before any summarizer
// is ever called. Whatever those results were carrying is then gone from the
// only record that existed. This session reproduces that order: read the
// facts, bury them under bulk, cross the mark, then compact.

/** Eight results big enough that reading them crosses 0.7 of a 60k window. */
const BULK_LINES = 100;
const BULK = (tag: string): string =>
  `${tag}\n` +
  Array.from(
    { length: BULK_LINES },
    (_, i) => `  line ${String(i).padStart(4, "0")} ${"routine output ".repeat(9)}`,
  ).join("\n");

const BULK_FILES = Array.from({ length: 8 }, (_, i) => `bulk-${i}.txt`);

const setupPressure = async ({ workspace }: { workspace: string }): Promise<void> => {
  await setupWorkspace({ workspace });
  for (let i = 0; i < BULK_FILES.length; i++) {
    await writeFile(join(workspace, BULK_FILES[i]), BULK(`FACT-1${i}: bulk file ${i} header`));
  }
};

const PRESSURE_HEAD = [
  { text: "Recording the plan first.", toolCalls: [todos(0)] },
  { toolCalls: [read("spec.md")] },
  { toolCalls: [read("notes.md")] },
  { toolCalls: [read("wire.md")] },
  { text: "Spec absorbed. Surveying the bulk data.", toolCalls: [todos(1)] },
];

const PRESSURE_TAIL = [
  // A bulk read rides along with each build turn, so the forced compactions
  // that follow have real material to fold. Without it the head is a handful
  // of small messages and the merged state is bigger than what it would
  // replace — which compaction now declines to do, correctly.
  { toolCalls: [read("bulk-0.txt"), write(MODULES[0], 0), write(MODULES[1], 1)] },
  { toolCalls: [compact()] },
  { toolCalls: [read("bulk-1.txt"), write(MODULES[2], 2), write(MODULES[3], 3)] },
  { toolCalls: [compact()] },
  { text: "Four modules written.", toolCalls: [todos(2)] },
  {
    text: "Checking the build.",
    toolCalls: [{ name: "bash", args: { command: "ls src/ledger | wc -l" } }],
  },
  { text: "Build checked.", toolCalls: [todos(3)] },
  { toolCalls: [read(MODULES[0])] },
  { text: "Reported.", toolCalls: [todos(4)] },
  { text: "Built the append path per DECISION-1 and DECISION-2." },
  ...SPARES,
];

/**
 * Bulk read ONE FILE PER TURN. The old results then sit deep enough in the
 * history that the verbatim tail does not cover them, which is the shape where
 * the cheap eviction tier can actually reach its target and run.
 */
const PRESSURE_SESSION = [
  ...PRESSURE_HEAD,
  ...BULK_FILES.map((f) => ({ toolCalls: [read(f)] })),
  ...PRESSURE_TAIL,
];

/**
 * The same reads issued as two PARALLEL BATCHES. Identical bytes, identical
 * facts — and a different compaction, because the tail is floored by a message
 * count and two batches are two messages.
 */
const BURST_SESSION = [
  ...PRESSURE_HEAD,
  { toolCalls: BULK_FILES.slice(0, 4).map(read) },
  { toolCalls: BULK_FILES.slice(4).map(read) },
  ...PRESSURE_TAIL,
];

const PRESSURE_PROMPT =
  "survey every bulk-*.txt file and build the ledger service described in spec.md. " +
  "DECISION-3: no external dependencies, standard library only. Read notes.md and wire.md first.";

// ─── 1. Facts stated before compaction reach the model after it ───

const factsSurvive: EvalTask = {
  name: "compaction_facts_survive",
  category: "context",
  description:
    "Decisions the user stated and facts tool results taught, all before the first compaction, are still in the prompt after the run crosses the high-water mark and compacts three times.",
  setup: setupPressure,
  teardown: restoreWindow,
  summarizer: faithfulSummarizer,
  script: PRESSURE_SESSION,
  prompts: [PRESSURE_PROMPT],
  verify: async ({ mock, dbPath, sessionId }) => {
    if (!mock) return { pass: true }; // real mode: the unit layer covers this
    const final = requestText(mock.requestHistory.at(-1) as never);
    const guard = compactionHappened(final, dbPath, sessionId, 3);
    if (guard) return { pass: false, reason: guard };

    // Everything the run was told before the first compaction, from all three
    // sources: the user's own message, and the three files it read.
    const planted = [...sentinels(SPEC), ...sentinels(NOTES), ...sentinels(WIRE), "DECISION-3"];
    const lost = planted.filter((s) => !final.includes(s));
    if (lost.length > 0) {
      return {
        pass: false,
        reason: `${lost.length} of ${planted.length} pinned facts did not survive compaction: ${lost.join(", ")}`,
      };
    }
    return { pass: true };
  },
};

// ─── 2. The plan and the file ledger survive ───

const planAndLedgerSurvive: EvalTask = {
  name: "compaction_plan_and_ledger_survive",
  category: "context",
  description:
    "After four compactions the prompt still carries the goal, every todo with its state, and every file the run wrote.",
  setup: setupPressure,
  teardown: restoreWindow,
  summarizer: faithfulSummarizer,
  script: LONG_SESSION,
  prompts: [
    "build the ledger service described in spec.md. DECISION-3: no external dependencies, standard library only. Read notes.md and wire.md before you start.",
  ],
  verify: async ({ mock, dbPath, sessionId }) => {
    if (!mock) return { pass: true };
    const final = requestText(mock.requestHistory.at(-1) as never);
    const guard = compactionHappened(final, dbPath, sessionId, 4);
    if (guard) return { pass: false, reason: guard };

    if (!final.includes(SPINE_MARKER)) {
      return { pass: false, reason: "the final request lost the [Task state] block entirely" };
    }
    // The goal, verbatim enough to act on.
    if (!final.includes("build the ledger service described in spec.md")) {
      return { pass: false, reason: "the goal is no longer in the prompt" };
    }
    // Every planned step, open and closed alike. A plan that forgets its
    // finished half re-does the work; one that forgets its open half stops.
    const missingSteps = PLAN.filter((s) => !final.includes(s));
    if (missingSteps.length > 0) {
      return {
        pass: false,
        reason: `${missingSteps.length} of ${PLAN.length} plan steps missing after compaction: ${missingSteps.join(" | ")}`,
      };
    }
    // The file ledger: every module this run wrote.
    const missingFiles = MODULES.filter((p) => !final.includes(p));
    if (missingFiles.length > 0) {
      return {
        pass: false,
        reason: `file ledger lost ${missingFiles.length} of ${MODULES.length} written files: ${missingFiles.join(", ")}`,
      };
    }
    return { pass: true };
  },
};

// ─── 3. The harness's own hash ledger survives ───
// The model never carries content hashes; the harness does. If compaction
// costs that ledger, the first edit after it is refused with "read the file
// before editing it" and the run burns a turn re-reading what it just wrote.

const hashLedgerSurvives: EvalTask = {
  name: "compaction_hash_ledger_survives",
  category: "context",
  description: "An edit issued after compaction still applies with no hash and no re-read.",
  setup: setupPressure,
  teardown: restoreWindow,
  summarizer: faithfulSummarizer,
  script: [
    { text: "Planning.", toolCalls: [todos(0)] },
    { toolCalls: [read("spec.md"), read("bulk-0.txt")] },
    { toolCalls: [write(MODULES[0], 0), write(MODULES[1], 1)] },
    { text: "Spec read, first modules written.", toolCalls: [todos(1)] },
    { toolCalls: [compact()] },
    { toolCalls: [read("bulk-1.txt"), write(MODULES[2], 2)] },
    { toolCalls: [compact()] },
    // No expected_hash and no re-read: the harness must supply it from the
    // ledger it kept while the transcript was being squashed.
    {
      toolCalls: [
        {
          name: "edit_file",
          args: { path: MODULES[0], old_text: "return 0;", new_text: "return 42;" },
        },
      ],
    },
    { text: "Edited after compaction.", toolCalls: [todos(4)] },
    { text: "Done — the ledger survived the squash." },
  ],
  prompts: ["build the ledger service described in spec.md, then tune the append path"],
  verify: async ({ workspace, mock, dbPath, sessionId }) => {
    if (!mock) return { pass: true };
    const final = requestText(mock.requestHistory.at(-1) as never);
    const guard = compactionHappened(final, dbPath, sessionId, 2);
    if (guard) return { pass: false, reason: guard };
    const body = await Bun.file(join(workspace, MODULES[0])).text();
    if (!body.includes("return 42;")) {
      return {
        pass: false,
        reason: `the post-compaction edit did not apply — the freshness ledger did not survive: ${body.trim()}`,
      };
    }
    return { pass: true };
  },
};

// ─── 4. The recent tail stays verbatim ───
// Compaction exists to shrink the HEAD. The results the next step is about to
// act on must come through untouched — not summarized, not stubbed.

const recentResultsVerbatim: EvalTask = {
  name: "compaction_recent_results_verbatim",
  category: "context",
  description: "The tool results the next step needs survive compaction verbatim, not as a stub.",
  setup: setupPressure,
  teardown: restoreWindow,
  summarizer: faithfulSummarizer,
  script: LONG_SESSION,
  prompts: [
    "build the ledger service described in spec.md. DECISION-3: no external dependencies, standard library only. Read notes.md and wire.md before you start.",
  ],
  verify: async ({ mock, dbPath, sessionId }) => {
    if (!mock) return { pass: true };
    const final = requestText(mock.requestHistory.at(-1) as never);
    const guard = compactionHappened(final, dbPath, sessionId, 4);
    if (guard) return { pass: false, reason: guard };
    // The last script step before the final answer re-read append.ts; its
    // body must be in the prompt as itself.
    if (!final.includes("export const m0")) {
      return {
        pass: false,
        reason:
          "the most recent read's content is not in the prompt — the tail was not kept verbatim",
      };
    }
    if (final.includes("[tool result evicted to reclaim context]")) {
      const tail = final.slice(final.lastIndexOf(SUMMARY_MARKER));
      if (tail.includes("[tool result evicted to reclaim context]")) {
        return { pass: false, reason: "results in the kept tail were evicted, not preserved" };
      }
    }
    return { pass: true };
  },
};

// ─── 5. Compaction never re-summarizes its own summary ───

const noSummaryOfSummary: EvalTask = {
  name: "compaction_no_summary_of_summary",
  category: "context",
  description:
    "Each compaction merges the prior state; it never feeds its own summary back as transcript, and its request stays inside the summarizer's window.",
  setup: setupPressure,
  teardown: restoreWindow,
  summarizer: faithfulSummarizer,
  script: LONG_SESSION,
  prompts: [
    "build the ledger service described in spec.md. DECISION-3: no external dependencies, standard library only. Read notes.md and wire.md before you start.",
  ],
  verify: async ({ mock, dbPath, sessionId }) => {
    if (!mock) return { pass: true };
    const final = requestText(mock.requestHistory.at(-1) as never);
    const guard = compactionHappened(final, dbPath, sessionId, 4);
    if (guard) return { pass: false, reason: guard };

    // (a) Exactly one summary in the working set — never a summary nested
    //     inside a summary, never two side by side.
    const markers = final.split(SUMMARY_MARKER).length - 1;
    if (markers !== 1) {
      return {
        pass: false,
        reason: `${markers} summary markers in one prompt; expected exactly 1`,
      };
    }

    // (b) No compaction was ever handed its own previous summary as new
    //     transcript to compress. This is Gap 6 measured directly.
    for (let i = 0; i < mock.summaryRequests.length; i++) {
      const { prior, segment } = splitSummaryRequest(mock.summaryRequests[i].text);
      if (segment.includes(SUMMARY_MARKER)) {
        return {
          pass: false,
          reason: `compaction #${i + 1} fed its previous summary back as transcript (summary-of-summary)`,
        };
      }
      for (const label of SECTIONS) {
        if (segment.includes(label)) {
          return {
            pass: false,
            reason: `compaction #${i + 1}'s segment contains "${label}" — a prior state leaked into the transcript half`,
          };
        }
      }
      if (i > 0 && prior.length === 0) {
        return {
          pass: false,
          reason: `compaction #${i + 1} carried no prior state — the merge chain broke`,
        };
      }
    }

    // (c) The summarizer's own request must fit the summarizer's own window.
    //     The engine budgets the transcript at 55% of the model's context; the
    //     whole request has to stay under the window regardless.
    for (let i = 0; i < mock.summaryRequests.length; i++) {
      const size = countTokens(mock.summaryRequests[i].text);
      if (size > MOCK_WINDOW) {
        return {
          pass: false,
          reason: `compaction #${i + 1}'s own request was ~${size} tokens against a ${MOCK_WINDOW} window`,
        };
      }
    }

    // (d) The merged state must not grow without bound across compactions.
    //     A faithful summarizer adds one line per NEW fact, so a merge that
    //     stays a merge converges; one that re-compresses its own prose does
    //     not. The bound is generous on purpose — this catches runaway, not
    //     honest accumulation.
    const sizes = mock.summaryReplies.map((s) => countTokens(s));
    if (sizes.length >= 2) {
      const bound = sizes[0] * 2 + 200;
      const last = sizes[sizes.length - 1];
      if (last > bound) {
        return {
          pass: false,
          reason: `summary grew from ~${sizes[0]} to ~${last} tokens across ${sizes.length} compactions (bound ~${bound})`,
        };
      }
    }
    return { pass: true };
  },
};

// ─── 6. Evicted tool results stay identifiable ───
// The cheapest compaction tier replaces old tool-result BODIES with a stub and
// never calls a summarizer, so nothing else records what was in them. A stub
// that says only "N chars reclaimed" turns every old result into the same
// anonymous hole: the run cannot tell the read that found the bug from the one
// that listed a directory, and cannot know which is worth re-running.

const EVICTED = "[tool result evicted to reclaim context]";

const evictedResultsIdentifiable: EvalTask = {
  name: "compaction_evicted_results_identifiable",
  category: "context",
  description:
    "The eviction tier strips bulky old results without turning them into anonymous holes, and still reclaims the great majority of what it strips.",
  setup: setupPressure,
  teardown: restoreWindow,
  summarizer: faithfulSummarizer,
  script: PRESSURE_SESSION,
  prompts: [PRESSURE_PROMPT],
  verify: async ({ mock, dbPath, sessionId }) => {
    if (!mock) return { pass: true };
    const final = requestText(mock.requestHistory.at(-1) as never);
    if (compactionRows(dbPath, sessionId) < 1) {
      return {
        pass: false,
        reason: "no compaction fired — the bulk reads did not cross the high-water mark",
      };
    }
    // Every request across the run, so a result evicted early and summarized
    // away later is still counted where it was evicted.
    const everySent = (mock.requestHistory as never as Array<{ content: unknown[] }>[]).map(
      requestText,
    );
    const withEvictions = everySent.filter((t) => t.includes(EVICTED));
    if (withEvictions.length === 0) {
      return {
        pass: false,
        reason: "compaction never took the eviction tier — this task measures nothing",
      };
    }
    const worst = withEvictions[withEvictions.length - 1];
    const evicted = worst.split(EVICTED).length - 1;

    // (a) An evicted result must still say what it WAS. These bulk results
    //     carry their identity on the first line, exactly where a real tool
    //     puts the path, the exit code, or the FAIL.
    const identifiable = BULK_FILES.map((_, i) => `FACT-1${i}`).filter((s) =>
      worst.includes(s),
    ).length;
    if (identifiable < Math.min(evicted, BULK_FILES.length)) {
      return {
        pass: false,
        reason: `${evicted} results were evicted and only ${identifiable} of ${BULK_FILES.length} stayed identifiable — the rest are anonymous holes`,
      };
    }

    // (b) …and the tier must still do its job. Keeping an excerpt is only
    //     defensible while the excerpt is a small fraction of the body, so
    //     this guards the fix against becoming "stop evicting".
    const kept = worst.length;
    const uncompacted = requestText(mock.requestHistory[6] as never); // after the bulk reads
    if (uncompacted.length > 0 && kept > uncompacted.length * 0.75) {
      return {
        pass: false,
        reason: `eviction reclaimed too little: ${kept} chars against ${uncompacted.length} before compaction`,
      };
    }

    // (c) Small results are not worth destroying. Stripping a 400-byte result
    //     reclaims a rounding error and costs the whole result — the three
    //     spec reads in this session are exactly that shape.
    const sizes = [...worst.matchAll(/reclaim context\][\s\S]{0,80}?(\d+) chars reclaimed/g)].map(
      (m) => Number(m[1]),
    );
    const tiny = sizes.filter((n) => n < 2_000);
    if (tiny.length > 0) {
      return {
        pass: false,
        reason: `${tiny.length} of ${sizes.length} evictions destroyed a result under 2,000 chars (${tiny.join(", ")}) — all cost, no reclaim`,
      };
    }
    return { pass: true };
  },
};

// ─── 7. A compaction has to be worth its round trip ───
//
// Two ways for a compaction to "succeed" and leave the run worse off, both
// observed in this family's own pressure session before P10.8:
//
//   · it summarizes eleven messages and frees 1.2% of the working set, because
//     the token-budgeted tail is floored by a MESSAGE COUNT and six tool-heavy
//     messages exceed the whole budget on their own. The trigger is still hot,
//     so it fires again next turn — a paid round trip that bought nothing.
//   · it over-cuts and leaves 918 tokens standing in a 60k window: the exact
//     "212 messages folded to 834 tokens" pathology tiered compaction was
//     built to end, reached from the other direction.

const compactionIsWorthIt: EvalTask = {
  name: "compaction_reclaims_and_keeps_a_tail",
  category: "context",
  description:
    "Every compaction frees a real share of the working set, and none of them collapses the tail to a token stub — including when the bulk arrived as two parallel batches.",
  setup: setupPressure,
  teardown: restoreWindow,
  summarizer: faithfulSummarizer,
  script: BURST_SESSION,
  prompts: [PRESSURE_PROMPT],
  verify: async ({ mock, dbPath, sessionId }) => {
    if (!mock) return { pass: true };
    const rows = compactions(dbPath, sessionId);
    if (rows.length < 2) {
      return { pass: false, reason: `only ${rows.length} compactions recorded; the drill needs 2` };
    }
    /** What the engine aims to keep verbatim: COMPACT_TAIL_RATIO of the window. */
    const tailBudget = Math.floor(MOCK_WINDOW * 0.3);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.beforeTokens <= 0) continue;
      const freed = (r.beforeTokens - r.afterTokens) / r.beforeTokens;
      // A compaction that ran the summarizer and freed almost nothing has
      // spent a round trip and left the trigger hot.
      if (r.summarizedCount > 0 && freed < 0.15) {
        return {
          pass: false,
          reason: `compaction #${i + 1} folded ${r.summarizedCount} messages and freed only ${(freed * 100).toFixed(1)}% (${r.beforeTokens} → ${r.afterTokens})`,
        };
      }
      // …and one that cuts to the bone has thrown away context it was
      // budgeted to keep. Only the AUTOMATIC tier is budgeted to keep 30%:
      // an explicit compact_context, or an over-limit rejection, was asked to
      // free room now and legitimately cuts to the recent exchange.
      if (r.trigger !== "auto") continue;
      const floor = Math.floor(Math.min(r.beforeTokens, tailBudget) * 0.5);
      if (r.afterTokens < floor) {
        return {
          pass: false,
          reason: `compaction #${i + 1} left ${r.afterTokens} tokens of a ${tailBudget}-token tail budget (${r.beforeTokens} before)`,
        };
      }
    }
    return { pass: true };
  },
};

export const COMPACTION_TASKS: EvalTask[] = [
  factsSurvive,
  planAndLedgerSurvive,
  hashLedgerSurvives,
  recentResultsVerbatim,
  noSummaryOfSummary,
  evictedResultsIdentifiable,
  compactionIsWorthIt,
];
