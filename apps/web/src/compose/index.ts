// ─── The composer, as one import ───
//
// The shell (P11.3) needs four things from this directory and nothing else:
// compose a surface, render it, know what a projection is, and read the log of
// what the model asked for and did not get.

export { composeProjection } from "./personas";
export { applyModelChoice, composeTaskSurface, ModelChoiceSchema } from "./model-choice";
export type { ComposeResult, ModelChoice } from "./model-choice";
export { ProjectionView, Region } from "./Surface";
export { bindBlock, isEmptyValue, resolvePath, shouldFold } from "./bind";
export type { BoundRender } from "./bind";
export {
  BlockIdSchema,
  BlockSchema,
  FoldPredicateSchema,
  PersonaSchema,
  ProjectionSchema,
  REGION_NAMES,
  RegionsSchema,
  StatePathSchema,
  blocksOf,
  makeLog,
  validateProjection,
} from "./projection";
export type {
  ComposeLog,
  ComposeNote,
  FoldPredicate,
  Persona,
  Projection,
  ProjectionBlock,
  RegionName,
  Regions,
} from "./projection";
export { TASK_KINDS, deriveView } from "./state";
export type {
  AskQuestion,
  EvidenceRef,
  HeldApproval,
  Hypothesis,
  Narrative,
  PendingDecision,
  RecordedDecision,
  TaskArtifact,
  TaskKind,
  TaskProgress,
  TaskStateView,
} from "./state";
