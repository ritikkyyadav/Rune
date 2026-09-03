// ─── The catalogue — thirty primitives, and nothing else ───
//
// This file is the closed vocabulary. A projection block names a `type`; if the
// name is not a key of `PRIMITIVES`, the block does not exist, and no amount of
// model output can change that. The composer's fallback test asserts exactly
// this property, because it is the whole safety argument of the intent layer:
// the model chooses a COMPOSITION, never a component and never markup.
//
// Each entry carries four things the rest of the system needs:
//
//   schema     the contract. The composer validates props against it and drops
//              a block that fails, with the reason logged.
//   Component  the renderer.
//   bind       how a value resolved from a state path becomes props:
//                assign — props[key] = value        (a list into `rows`)
//                merge  — props = {…props, …value}  (an object of fields)
//                repeat — one component per array element, element spread over
//                         the block's own props (a list of hypotheses)
//                none   — the primitive takes no live data
//   foldable   whether the primitive honours a `folded` prop, which is what
//              lets `foldWhen` be a closed predicate rather than a callback.
//
// Adding a primitive means adding it here, in docs/primitives.md, and in the
// gallery. The schema test fails on any of the three being missing.

import type { ReactNode } from "react";
import { z } from "zod";

import { Agent, AgentSchema } from "./Agent";
import { Approval, ApprovalSchema } from "./Approval";
import { Artifact, ArtifactSchema } from "./Artifact";
import { Chart, ChartSchema } from "./Chart";
import { Checklist, ChecklistSchema } from "./Checklist";
import { Choice, ChoiceSchema } from "./Choice";
import { Comparison, ComparisonSchema } from "./Comparison";
import { Cost, CostSchema } from "./Cost";
import { Decision, DecisionSchema } from "./Decision";
import { Diff, DiffSchema } from "./Diff";
import { Divider, DividerSchema } from "./Divider";
import { Evidence, EvidenceSchema } from "./Evidence";
import { File, FileSchema } from "./File";
import { Form, FormSchema } from "./Form";
import { Heading, HeadingSchema } from "./Heading";
import { Hypothesis, HypothesisSchema } from "./Hypothesis";
import { Link, LinkSchema } from "./LinkBlock";
import { Log, LogSchema } from "./Log";
import { Metric, MetricSchema } from "./Metric";
import { Preview, PreviewSchema } from "./Preview";
import { Progress, ProgressSchema } from "./Progress";
import { Relationship, RelationshipSchema } from "./Relationship";
import { Source, SourceSchema } from "./Source";
import { Table, TableSchema } from "./Table";
import { Terminal, TerminalSchema } from "./Terminal";
import { Text, TextSchema } from "./Text";
import { Timeline, TimelineSchema } from "./Timeline";
import { Transcript, TranscriptSchema } from "./Transcript";
import { Tree, TreeSchema } from "./Tree";
import { Warning, WarningSchema } from "./Warning";

export type AnyProps = Record<string, unknown>;

export type BindMode = "assign" | "merge" | "repeat" | "none";

export interface PrimitiveEntry {
  type: BlockType;
  /** The name a person reads in the gallery and the docs. */
  title: string;
  /** One line: what it is for. Rendered in docs/primitives.md. */
  summary: string;
  schema: z.ZodType;
  Component: (props: AnyProps) => ReactNode;
  bind: { mode: BindMode; key?: string };
  /** Honours `folded`, so a `foldWhen` predicate may target it. */
  foldable?: boolean;
  /** Takes callbacks the projection cannot supply; the shell wires them. */
  interactive?: boolean;
}

function define<S extends z.ZodType>(spec: {
  type: BlockType;
  title: string;
  summary: string;
  schema: S;
  Component: (props: z.infer<S>) => ReactNode;
  bind: { mode: BindMode; key?: string };
  foldable?: boolean;
  interactive?: boolean;
}): PrimitiveEntry {
  return spec as unknown as PrimitiveEntry;
}

/**
 * The thirty ids, in the order the brief lists them, which is also the order
 * the gallery renders them and the order docs/primitives.md documents them.
 */
export const BLOCK_TYPES = [
  "text",
  "heading",
  "metric",
  "table",
  "chart",
  "timeline",
  "diff",
  "file",
  "tree",
  "terminal",
  "source",
  "evidence",
  "hypothesis",
  "decision",
  "checklist",
  "progress",
  "approval",
  "choice",
  "form",
  "comparison",
  "relationship",
  "artifact",
  "preview",
  "log",
  "transcript",
  "agent",
  "cost",
  "warning",
  "link",
  "divider",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export const BlockTypeSchema = z.enum(BLOCK_TYPES);

export const PRIMITIVES: Record<BlockType, PrimitiveEntry> = {
  text: define({
    type: "text",
    title: "Text",
    summary: "A paragraph the agent wrote. Text nodes only — never markup.",
    schema: TextSchema,
    Component: Text,
    bind: { mode: "assign", key: "body" },
  }),
  heading: define({
    type: "heading",
    title: "Heading",
    summary: "The one line that says what a region is, with an eyebrow and a right-hand fact.",
    schema: HeadingSchema,
    Component: Heading,
    bind: { mode: "assign", key: "text" },
  }),
  metric: define({
    type: "metric",
    title: "Metric",
    summary: "One number and what it moved from; the delta is derived, never supplied.",
    schema: MetricSchema,
    Component: Metric,
    bind: { mode: "repeat" },
  }),
  table: define({
    type: "table",
    title: "Table",
    summary: "Rows of facts, aligned by column so they can be compared.",
    schema: TableSchema,
    Component: Table,
    bind: { mode: "assign", key: "rows" },
  }),
  chart: define({
    type: "chart",
    title: "Chart",
    summary: "Line or bar, drawn in SVG: faint grid, emphasized endpoint, tabular figures.",
    schema: ChartSchema,
    Component: Chart,
    bind: { mode: "assign", key: "points" },
  }),
  timeline: define({
    type: "timeline",
    title: "Timeline",
    summary: "What happened, in order, on a hairline rail.",
    schema: TimelineSchema,
    Component: Timeline,
    bind: { mode: "assign", key: "events" },
  }),
  diff: define({
    type: "diff",
    title: "Diff",
    summary: "A unified patch as banded hunks with both line gutters.",
    schema: DiffSchema,
    Component: Diff,
    bind: { mode: "repeat" },
  }),
  file: define({
    type: "file",
    title: "File",
    summary: "A path, what happened to it, and the region that mattered.",
    schema: FileSchema,
    Component: File,
    bind: { mode: "repeat" },
  }),
  tree: define({
    type: "tree",
    title: "Tree",
    summary: "A hierarchy as a flat list with depths, collapsible at every parent.",
    schema: TreeSchema,
    Component: Tree,
    bind: { mode: "assign", key: "nodes" },
  }),
  terminal: define({
    type: "terminal",
    title: "Terminal",
    summary: "A command, its output tail, its exit code when one is known.",
    schema: TerminalSchema,
    Component: Terminal,
    bind: { mode: "repeat" },
  }),
  source: define({
    type: "source",
    title: "Source",
    summary: "A citation with a locator — a path and a line, or a URL and a time.",
    schema: SourceSchema,
    Component: Source,
    bind: { mode: "repeat" },
  }),
  evidence: define({
    type: "evidence",
    title: "Evidence",
    summary: "A claim bound to its sources; strength is counted, never asserted.",
    schema: EvidenceSchema,
    Component: Evidence,
    bind: { mode: "repeat" },
  }),
  hypothesis: define({
    type: "hypothesis",
    title: "Hypothesis",
    summary: "An experiment card: proposed, testing, refuted (folded, with its reason), confirmed.",
    schema: HypothesisSchema,
    Component: Hypothesis,
    bind: { mode: "repeat" },
    foldable: true,
  }),
  decision: define({
    type: "decision",
    title: "Decision",
    summary: "What was decided, what it rests on, and what was not chosen.",
    schema: DecisionSchema,
    Component: Decision,
    bind: { mode: "repeat" },
  }),
  checklist: define({
    type: "checklist",
    title: "Checklist",
    summary: "The plan, with the ledger's three marks: done, verified, unproven.",
    schema: ChecklistSchema,
    Component: Checklist,
    bind: { mode: "assign", key: "items" },
  }),
  progress: define({
    type: "progress",
    title: "Progress",
    summary: "Steps closed on evidence over steps. There is no prop that takes a percentage.",
    schema: ProgressSchema,
    Component: Progress,
    bind: { mode: "merge" },
  }),
  approval: define({
    type: "approval",
    title: "Approval",
    summary: "A held step with the exact grant it asks for. Keys y / a / n.",
    schema: ApprovalSchema,
    Component: Approval,
    bind: { mode: "repeat" },
    foldable: true,
    interactive: true,
  }),
  choice: define({
    type: "choice",
    title: "Choice",
    summary: "An ask_user question whose options are data, not prose.",
    schema: ChoiceSchema,
    Component: Choice,
    bind: { mode: "repeat" },
    foldable: true,
    interactive: true,
  }),
  form: define({
    type: "form",
    title: "Form",
    summary: "Structured input in four field kinds: text, number, select, toggle.",
    schema: FormSchema,
    Component: Form,
    bind: { mode: "assign", key: "fields" },
    interactive: true,
  }),
  comparison: define({
    type: "comparison",
    title: "Comparison",
    summary: "Two or three options on the same rows, with the winner named per row.",
    schema: ComparisonSchema,
    Component: Comparison,
    bind: { mode: "merge" },
  }),
  relationship: define({
    type: "relationship",
    title: "Relationship",
    summary: "A small graph, laid out deterministically so it draws the same every time.",
    schema: RelationshipSchema,
    Component: Relationship,
    bind: { mode: "merge" },
  }),
  artifact: define({
    type: "artifact",
    title: "Artifact",
    summary: "A thing the task produced that outlives it: a file, a diff, a report.",
    schema: ArtifactSchema,
    Component: Artifact,
    bind: { mode: "repeat" },
    interactive: true,
  }),
  preview: define({
    type: "preview",
    title: "Preview",
    summary: "The only primitive that renders markup, and it renders it in a sandboxed iframe.",
    schema: PreviewSchema,
    Component: Preview,
    bind: { mode: "merge" },
  }),
  log: define({
    type: "log",
    title: "Log",
    summary: "Raw output behind a fold that says how much is behind it.",
    schema: LogSchema,
    Component: Log,
    bind: { mode: "assign", key: "lines" },
    foldable: true,
  }),
  transcript: define({
    type: "transcript",
    title: "Transcript",
    summary: "The conversation, folded by default. Chat is the input, not the output.",
    schema: TranscriptSchema,
    Component: Transcript,
    bind: { mode: "assign", key: "turns" },
    foldable: true,
  }),
  agent: define({
    type: "agent",
    title: "Agent",
    summary: "One fleet row: who, what it is doing, what it has spent.",
    schema: AgentSchema,
    Component: Agent,
    bind: { mode: "repeat" },
  }),
  cost: define({
    type: "cost",
    title: "Cost",
    summary: "What the run has spent. null renders as an em dash, never as $0.00.",
    schema: CostSchema,
    Component: Cost,
    bind: { mode: "merge" },
  }),
  warning: define({
    type: "warning",
    title: "Warning",
    summary: "Something to know before acting, in one of three severities.",
    schema: WarningSchema,
    Component: Warning,
    bind: { mode: "repeat" },
  }),
  link: define({
    type: "link",
    title: "Link",
    summary: "Somewhere else worth going; the scheme allowlist is in the schema.",
    schema: LinkSchema,
    Component: Link,
    bind: { mode: "repeat" },
  }),
  divider: define({
    type: "divider",
    title: "Divider",
    summary: "One hairline, optionally carrying a word.",
    schema: DividerSchema,
    Component: Divider,
    bind: { mode: "none" },
  }),
};

/** Whether a name is a primitive this build ships. The closed-vocabulary gate. */
export function isBlockType(name: unknown): name is BlockType {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(PRIMITIVES, name);
}

export { Frame, LocatorSchema, StatusSchema, baseProps, locatorText } from "./kit";
export type { BaseProps, Locator, PrimitiveStatus, Tone } from "./kit";
