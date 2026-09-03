// ─── The projection schema — what the agent is allowed to say about a surface ───
//
//   { taskId, persona, regions: { header, primary, side?, actions }, blocks: [
//       { id, type, props, bind?: statePath, foldWhen?: predicate } ] }
//
// A projection is a LAYOUT, never markup and never a component. Three properties
// make that stick, and each is a validation rule rather than a convention:
//
//   1. `type` is `z.enum(BLOCK_TYPES)`. Thirty names. A block naming anything
//      else is not a block, and there is no path from model output to the DOM
//      that does not pass through this enum.
//   2. `props` are validated against THAT primitive's own schema. Unknown props
//      are rejected (every primitive schema is strict), so `dangerouslySetInnerHTML`
//      in a props object fails the block instead of reaching React.
//   3. `bind` is a dotted path, not an expression, and `foldWhen` is one of five
//      named predicates, not a callback. Neither can carry code.
//
// A block that fails validation is DROPPED with the reason recorded, and the
// rest of the projection stands. An all-or-nothing parse would let one bad prop
// blank a surface that was 95% correct, which is the failure mode a person
// notices and cannot diagnose.

import { z } from "zod";

import { BLOCK_TYPES, PRIMITIVES, type BlockType } from "../primitives";
import { TASK_KINDS } from "./state";

/** The six personas. Identical to the task kinds — one composer each. */
export const PersonaSchema = z.enum(TASK_KINDS);
export type Persona = z.infer<typeof PersonaSchema>;

export const BlockTypeSchema = z.enum(BLOCK_TYPES);

/**
 * A block id: lowercase, hyphen or underscore separated, short.
 *
 * The pattern matters because ids cross the model boundary twice — once in the
 * projection, once in `compose_view`'s emphasis list — and the emphasis list is
 * used to index into regions. A constrained id is one that cannot be a path, a
 * prototype key, or an unbounded string.
 */
export const BlockIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, "a block id is lowercase alphanumeric with - or _")
  .refine((id) => !RESERVED_KEYS.has(id), {
    message: "a block id may not be a prototype key",
  });

/**
 * Names that are a property of every object in JavaScript.
 *
 * The pattern above already excludes `__proto__` (it may not start with an
 * underscore), but `constructor`, `prototype`, `toString` and their friends are
 * perfectly good lowercase words, and a block id is used to index a handler map
 * in the renderer. That lookup is `hasOwnProperty`-guarded, so this is the
 * second lock rather than the first — but an id that can never name something
 * the language already defines is one fewer thing to reason about every time
 * somebody adds a map keyed by block id.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "tostring",
  "toString",
  "valueof",
  "valueOf",
  "hasownproperty",
  "hasOwnProperty",
]);

/**
 * A state path: dotted segments and numeric indices, resolved against the task
 * state. Deliberately not a JSONPath — there is nothing here to evaluate.
 */
export const StatePathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/, "a state path is dotted identifiers")
  .refine((p) => !/(^|\.)(?:__proto__|prototype|constructor)(\.|$)/.test(p), {
    message: "a state path may not walk the prototype chain",
  });

/**
 * The fold predicates. A closed set, because `foldWhen` is the one field whose
 * natural type is a function, and a function from a model is a script.
 *
 *   never      — never fold (the default; stated so a projection can be explicit)
 *   refuted    — the bound value's `status` is "refuted"
 *   completed  — its `status` is "completed" or "done"
 *   resolved   — its `resolution` is neither null nor undefined
 *   empty      — the bound value is empty: [], "", null, undefined
 */
export const FoldPredicateSchema = z.enum(["never", "refuted", "completed", "resolved", "empty"]);
export type FoldPredicate = z.infer<typeof FoldPredicateSchema>;

export const BlockSchema = z.strictObject({
  id: BlockIdSchema,
  type: BlockTypeSchema,
  props: z.record(z.string(), z.unknown()),
  bind: StatePathSchema.optional(),
  foldWhen: FoldPredicateSchema.optional(),
});
export type ProjectionBlock = z.infer<typeof BlockSchema>;

export const RegionsSchema = z.strictObject({
  header: z.array(BlockIdSchema).max(12),
  primary: z.array(BlockIdSchema).max(60),
  side: z.array(BlockIdSchema).max(24).optional(),
  actions: z.array(BlockIdSchema).max(12),
});
export type Regions = z.infer<typeof RegionsSchema>;

export const ProjectionSchema = z.strictObject({
  taskId: z.string().min(1).max(120),
  persona: PersonaSchema,
  regions: RegionsSchema,
  blocks: z.array(BlockSchema).max(120),
});
export type Projection = z.infer<typeof ProjectionSchema>;

export const REGION_NAMES = ["header", "primary", "side", "actions"] as const;
export type RegionName = (typeof REGION_NAMES)[number];

/** One thing the validator changed or refused, and why. */
export interface ComposeNote {
  level: "drop" | "reject" | "repair";
  where: string;
  reason: string;
}

/** A log the caller owns, so a test can read the reasons instead of stdout. */
export interface ComposeLog {
  notes: ComposeNote[];
  note(n: ComposeNote): void;
}

export function makeLog(): ComposeLog {
  const notes: ComposeNote[] = [];
  return {
    notes,
    note(n) {
      notes.push(n);
    },
  };
}

/** The reason zod gave, flattened to one line a person can act on. */
function zodReason(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export interface ValidateResult {
  projection: Projection | null;
  notes: ComposeNote[];
}

/**
 * Validate a projection, dropping the blocks that fail and keeping the rest.
 *
 * The order is deliberate. Shape first (a projection whose `regions` is a
 * string is not repairable), then blocks one at a time against their own
 * primitive schema, then the cross-check that every id a region names is a
 * block that survived. That last step is what keeps a dropped block from
 * leaving a hole the renderer has to guess about.
 */
export function validateProjection(input: unknown, log: ComposeLog = makeLog()): ValidateResult {
  const shape = ProjectionSchema.safeParse(input);
  if (!shape.success) {
    log.note({ level: "reject", where: "projection", reason: zodReason(shape.error) });
    return { projection: null, notes: log.notes };
  }

  const seen = new Set<string>();
  const blocks: ProjectionBlock[] = [];
  for (const block of shape.data.blocks) {
    if (seen.has(block.id)) {
      log.note({ level: "drop", where: block.id, reason: "duplicate block id" });
      continue;
    }
    const entry = PRIMITIVES[block.type];
    const props = entry.schema.safeParse(block.props);
    if (!props.success) {
      log.note({
        level: "drop",
        where: `${block.id} (${block.type})`,
        reason: `props do not match the ${block.type} schema — ${zodReason(props.error)}`,
      });
      continue;
    }
    if (block.foldWhen !== undefined && block.foldWhen !== "never" && !entry.foldable) {
      log.note({
        level: "repair",
        where: `${block.id} (${block.type})`,
        reason: `${block.type} has no folded form; foldWhen dropped`,
      });
      const { foldWhen: _dropped, ...rest } = block;
      seen.add(block.id);
      blocks.push(rest);
      continue;
    }
    seen.add(block.id);
    blocks.push(block);
  }

  const regions: Regions = {
    header: shape.data.regions.header.filter((id) => keep(id, seen, "header", log)),
    primary: shape.data.regions.primary.filter((id) => keep(id, seen, "primary", log)),
    actions: shape.data.regions.actions.filter((id) => keep(id, seen, "actions", log)),
    ...(shape.data.regions.side
      ? { side: shape.data.regions.side.filter((id) => keep(id, seen, "side", log)) }
      : {}),
  };

  return { projection: { ...shape.data, regions, blocks }, notes: log.notes };
}

function keep(id: string, seen: Set<string>, region: string, log: ComposeLog): boolean {
  if (seen.has(id)) return true;
  log.note({
    level: "drop",
    where: `${region}.${id}`,
    reason: "names a block that does not exist",
  });
  return false;
}

/** Blocks in the order a region lists them, ready to render. */
export function blocksOf(projection: Projection, region: RegionName): ProjectionBlock[] {
  const ids = region === "side" ? (projection.regions.side ?? []) : projection.regions[region];
  const byId = new Map(projection.blocks.map((b) => [b.id, b]));
  return ids.map((id) => byId.get(id)).filter((b): b is ProjectionBlock => b !== undefined);
}

export type { BlockType };
