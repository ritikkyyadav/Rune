// ─── The six composers — Task State in, projection out, deterministically ───
//
// One composer per task kind, and each is a pure function of the state: the
// same state produces byte-identical projections on every machine, in every
// screenshot, in every test. No clock, no random ids, no iteration over an
// object's key order.
//
// Two rules decide whether a block is in the projection:
//
//   SPINE blocks are always present. They are the persona's shape, and their
//   designed empty states ("No hypotheses yet.") are how a task three seconds
//   old still reads as an investigation rather than as a blank page.
//
//   SUPPLEMENTARY blocks appear only when their data is non-empty. A surface
//   that shows an empty Cost, an empty fleet and an empty artifact list on every
//   task is the "everything, always" layout this phase replaced.
//
// The brief's assignments, kept verbatim:
//   investigate → hypotheses + evidence + timeline
//   build       → checklist + diff + terminal + checks + approval
//   analyze     → metric + chart + comparison + table + sources
//   research    → claims + sources + evidence
//   operate     → approvals + logs + timeline
//   write       → artifact + outline + sources

import type { AnyProps, BlockType } from "../primitives";
import type { FoldPredicate, Projection, ProjectionBlock, Regions } from "./projection";
import type { TaskKind, TaskStateView } from "./state";

type Region = "header" | "primary" | "side" | "actions";

class Draft {
  private readonly blocks: ProjectionBlock[] = [];
  private readonly regions: Record<Region, string[]> = {
    header: [],
    primary: [],
    side: [],
    actions: [],
  };

  add(
    region: Region,
    id: string,
    type: BlockType,
    props: AnyProps,
    bind?: string,
    foldWhen?: FoldPredicate,
  ): void {
    this.blocks.push({
      id,
      type,
      props,
      ...(bind ? { bind } : {}),
      ...(foldWhen ? { foldWhen } : {}),
    });
    this.regions[region].push(id);
  }

  build(taskId: string, persona: TaskKind): Projection {
    const regions: Regions = {
      header: this.regions.header,
      primary: this.regions.primary,
      actions: this.regions.actions,
      ...(this.regions.side.length > 0 ? { side: this.regions.side } : {}),
    };
    return { taskId, persona, regions, blocks: this.blocks };
  }
}

function has(v: unknown[] | undefined): boolean {
  return Array.isArray(v) && v.length > 0;
}

/**
 * The invariant every block below obeys: **a block's static props must render on
 * their own**, and what they render is that primitive's empty state.
 *
 * A bound block's props are the fallback the binding overwrites, so if they were
 * incomplete the block would fail `validateProjection` on a task that has not
 * produced its data yet — which is every task, for its first few seconds. This
 * is why the primitives' own identifying strings are `.max()`-bounded and never
 * `.min(1)`: see the note in `primitives/kit.tsx`.
 */
const EMPTY_METRIC = { name: "", value: "" };

function elapsedText(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const m = Math.floor(ms / 60_000);
  return m < 1 ? `${Math.round(ms / 1000)}s` : `${m}m`;
}

/** The header every persona shares: what the task is, and how far along it is. */
function header(d: Draft, state: TaskStateView): void {
  const meta = [state.phase, elapsedText(state.elapsedMs)].filter(Boolean).join(" · ");
  d.add(
    "header",
    "title",
    "heading",
    { level: 1, text: "", eyebrow: state.kind, ...(meta ? { meta } : {}) },
    "objective",
  );
  d.add("header", "task-progress", "progress", { done: 0, total: 0 }, "progress");
}

/**
 * The pending decisions, as the two primitives that can answer one.
 *
 * `held_step` and `approval` become an Approval with its exact grant;
 * `question` and `review` become a Choice. Both are BOUND rather than baked in,
 * so a decision that arrives ten minutes into a run appears without the surface
 * being recomposed, and a decision that is answered folds in place — it stays
 * present, because "what did I approve" is a question people ask afterwards,
 * and it stops taking the room an open one deserves.
 *
 * `withApprovals` is false for the operate persona, which puts them in `primary`
 * because for that kind of task the approvals ARE the work.
 */
function actions(d: Draft, state: TaskStateView, withApprovals = true): void {
  if (withApprovals && has(state.heldDecisions)) {
    d.add(
      "actions",
      "approvals",
      "approval",
      { action: "", grant: "" },
      "heldDecisions",
      "resolved",
    );
  }
  if (has(state.askDecisions)) {
    d.add(
      "actions",
      "questions",
      "choice",
      { question: "", options: [] },
      "askDecisions",
      "resolved",
    );
  }
}

/** Cost, fleet and artifacts: present when there is something to say. */
function sidebar(d: Draft, state: TaskStateView): void {
  if (has(state.agents)) {
    d.add("side", "fleet", "agent", { label: "Agents", name: "", status: "queued" }, "agents");
  }
  if (has(state.artifacts)) {
    d.add(
      "side",
      "artifacts",
      "artifact",
      { label: "Artifacts", kind: "file", name: "", ref: "" },
      "artifacts",
    );
  }
  if (state.cost) {
    d.add("side", "spend", "cost", { label: "Cost", usd: null }, "cost");
  }
}

/** The transcript, at the bottom of every surface, folded. Chat is the input. */
function transcript(d: Draft, state: TaskStateView): void {
  if (!has(state.transcript)) return;
  d.add("primary", "conversation", "transcript", { turns: [], folded: true }, "transcript");
}

// ─── investigate ───

function investigate(d: Draft, state: TaskStateView): void {
  header(d, state);
  if (has(state.metrics)) {
    d.add("header", "signals", "metric", EMPTY_METRIC, "metrics");
  }
  d.add("primary", "hypotheses-head", "heading", { level: 2, text: "Hypotheses" });
  d.add(
    "primary",
    "hypotheses",
    "hypothesis",
    { text: "", status: "proposed" },
    "narrative.hypotheses",
    "refuted",
  );
  d.add("primary", "findings", "evidence", { label: "Findings", claim: "", sources: [] }, "claims");
  if (has(state.diffs)) {
    d.add("primary", "changes", "diff", { path: "", patch: "" }, "diffs");
  }
  if (has(state.terminals)) {
    d.add("primary", "commands", "terminal", { command: "" }, "terminals");
  }
  d.add("primary", "history", "timeline", { label: "Timeline", events: [], live: true }, "events");
  if (has(state.narrative?.decisions)) {
    d.add("primary", "decisions", "decision", { text: "", basedOn: [] }, "narrative.decisions");
  }
  transcript(d, state);
  sidebar(d, state);
  actions(d, state);
}

// ─── build ───

function build(d: Draft, state: TaskStateView): void {
  header(d, state);
  d.add("primary", "plan", "checklist", { label: "Plan", items: [] }, "todos");
  d.add("primary", "changes", "diff", { path: "", patch: "" }, "diffs");
  d.add("primary", "commands", "terminal", { command: "" }, "terminals");
  d.add(
    "primary",
    "checks",
    "table",
    {
      label: "Checks",
      columns: [
        { key: "command", header: "Command", mono: true },
        { key: "summary", header: "Result" },
        { key: "durationMs", header: "ms", align: "right", muted: true },
      ],
      rows: [],
    },
    "checkRows",
  );
  if (has(state.artifacts)) {
    d.add("primary", "built", "artifact", { kind: "file", name: "", ref: "" }, "artifacts");
  }
  if (has(state.logs)) {
    d.add("primary", "output", "log", { title: "Build output", lines: [], folded: true }, "logs");
  }
  transcript(d, state);
  sidebar(d, state);
  actions(d, state);
}

// ─── analyze ───

function analyze(d: Draft, state: TaskStateView): void {
  header(d, state);
  d.add("primary", "figures", "metric", EMPTY_METRIC, "metrics");
  d.add("primary", "series", "chart", { label: "Series", form: "line", points: [] }, "chartPoints");
  if (state.comparison) {
    d.add("primary", "options", "comparison", { options: [], rows: [] }, "comparison");
  }
  d.add(
    "primary",
    "data",
    "table",
    {
      label: "Data",
      columns: [
        { key: "name", header: "Name" },
        { key: "value", header: "Value", align: "right" },
      ],
      rows: [],
    },
    "table",
  );
  d.add(
    "primary",
    "citations",
    "source",
    { title: "", locator: { kind: "file", ref: "" } },
    "sources",
  );
  if (state.prose) {
    d.add("primary", "reading", "text", { label: "Reading", body: "" }, "prose");
  }
  transcript(d, state);
  sidebar(d, state);
  actions(d, state);
}

// ─── research ───

function research(d: Draft, state: TaskStateView): void {
  header(d, state);
  d.add("primary", "claims", "evidence", { label: "Claims", claim: "", sources: [] }, "claims");
  d.add(
    "primary",
    "citations",
    "source",
    { label: "Sources", title: "", locator: { kind: "url", ref: "https://example.invalid" } },
    "sources",
  );
  if (has(state.narrative?.hypotheses)) {
    d.add(
      "primary",
      "hypotheses",
      "hypothesis",
      { text: "", status: "proposed" },
      "narrative.hypotheses",
      "refuted",
    );
  }
  if (state.relationship) {
    d.add("primary", "map", "relationship", { nodes: [], edges: [] }, "relationship");
  }
  // Unconditional: research ends in a written answer, and a surface that shows
  // the sources but not the place the answer will be is a bibliography.
  d.add("primary", "summary", "text", { label: "Summary", body: "" }, "prose");
  transcript(d, state);
  sidebar(d, state);
  actions(d, state);
}

// ─── operate ───

function operate(d: Draft, state: TaskStateView): void {
  header(d, state);
  d.add(
    "primary",
    "held",
    "approval",
    { label: "Waiting on you", action: "", grant: "" },
    "heldDecisions",
    "resolved",
  );
  d.add("primary", "output", "log", { title: "Output", lines: [], folded: true }, "logs");
  d.add("primary", "commands", "terminal", { command: "" }, "terminals");
  d.add("primary", "history", "timeline", { label: "Timeline", events: [], live: true }, "events");
  if (has(state.metrics)) {
    d.add("primary", "signals", "metric", EMPTY_METRIC, "metrics");
  }
  transcript(d, state);
  sidebar(d, state);
  // Approvals are already in `primary` for this persona; only the questions
  // belong in `actions`.
  actions(d, state, false);
}

// ─── write ───

function write(d: Draft, state: TaskStateView): void {
  header(d, state);
  d.add(
    "primary",
    "draft",
    "artifact",
    { label: "Draft", kind: "report", name: "", ref: "" },
    "artifacts",
  );
  d.add("primary", "outline", "tree", { label: "Outline", nodes: [] }, "outline");
  d.add("primary", "prose", "text", { label: "Text", body: "" }, "prose");
  d.add(
    "primary",
    "citations",
    "source",
    { label: "Sources", title: "", locator: { kind: "file", ref: "" } },
    "sources",
  );
  if (has(state.diffs)) {
    d.add("primary", "changes", "diff", { path: "", patch: "" }, "diffs");
  }
  transcript(d, state);
  sidebar(d, state);
  actions(d, state);
}

const COMPOSERS: Record<TaskKind, (d: Draft, s: TaskStateView) => void> = {
  investigate,
  build,
  analyze,
  research,
  operate,
  write,
};

/**
 * The default projection for a task.
 *
 * `persona` overrides the state's own `kind` — that is the one thing
 * `compose_view` is allowed to change, and it is how a build task that turned
 * into a debugging session gets the investigate surface.
 */
export function composeProjection(state: TaskStateView, persona?: TaskKind): Projection {
  const chosen = persona ?? state.kind;
  const draft = new Draft();
  COMPOSERS[chosen](draft, state);
  return draft.build(state.taskId, chosen);
}
