// ─── compose_view — the one thing the model gets to say about the surface ───
//
// The model may ask for a persona and an emphasis list. That is the entire
// grammar. It cannot name a block type, supply props, write a bind path, add a
// region or reorder anything it did not compose. Everything it CAN say is a
// choice among things the deterministic composer already produced.
//
// The fallback is the design, not the error path: an invalid call is logged and
// THE DEFAULT STANDS. There is no branch in which a rejected choice degrades the
// surface — the worst outcome of a model saying something nonsensical is the
// surface it would have got by saying nothing.
//
//   applyModelChoice(projection, choice)   validates a choice against one
//                                          already-composed projection
//   composeTaskSurface(state, choice)      the entry point the shell uses: it
//                                          recomposes for a valid persona, then
//                                          applies the emphasis
//
// The split exists because a persona change is a RECOMPOSITION — a different
// persona has a different block set — and `applyModelChoice` has a projection,
// not a state, so it cannot perform one. Asking it to would mean returning a
// projection labelled `analyze` whose blocks are an investigation's, which is a
// lie told in a type-correct way. It refuses the mismatch and logs it instead.

import { z } from "zod";

import { composeProjection } from "./personas";
import {
  BlockIdSchema,
  PersonaSchema,
  makeLog,
  validateProjection,
  type ComposeLog,
  type Persona,
  type Projection,
} from "./projection";
import { deriveView, type TaskStateView } from "./state";

/**
 * What `compose_view` accepts. Strict, so an extra key is a rejection rather
 * than a silently ignored instruction — a model that sent `{persona, emphasis,
 * blocks:[…]}` and got a surface back would reasonably conclude `blocks` worked.
 */
export const ModelChoiceSchema = z.strictObject({
  persona: PersonaSchema,
  emphasis: z.array(BlockIdSchema).max(8),
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

/**
 * Apply a model's `compose_view` call to a default projection.
 *
 * Returns the input projection unchanged on anything invalid. The rules, each
 * logged when it bites:
 *
 *   • the choice must parse — a persona outside the six, an emphasis id that is
 *     not a block id, an unknown key, or a non-object all fail here
 *   • the persona must match the projection's — see the note above
 *   • an emphasis id naming no block in the projection is dropped; the rest of
 *     the emphasis still applies, because one stale id should not cost the model
 *     its whole request
 *
 * Emphasis reorders `primary` — emphasised blocks first, in the order given,
 * everything else after in its composed order. It does not add, remove, resize
 * or restyle anything.
 */
export function applyModelChoice(
  projection: Projection,
  choice: unknown,
  log: ComposeLog = makeLog(),
): Projection {
  const parsed = ModelChoiceSchema.safeParse(choice);
  if (!parsed.success) {
    log.note({
      level: "reject",
      where: "compose_view",
      reason: `invalid choice, default stands — ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    });
    return projection;
  }

  if (parsed.data.persona !== projection.persona) {
    log.note({
      level: "reject",
      where: "compose_view.persona",
      reason: `asked for "${parsed.data.persona}" against a "${projection.persona}" projection; a persona change is a recomposition, default stands`,
    });
    return projection;
  }

  const known = new Set(projection.blocks.map((b) => b.id));
  const inPrimary = new Set(projection.regions.primary);
  const emphasis: string[] = [];
  for (const id of parsed.data.emphasis) {
    if (!known.has(id)) {
      log.note({
        level: "drop",
        where: `compose_view.emphasis.${id}`,
        reason: "names no block in this projection",
      });
      continue;
    }
    if (!inPrimary.has(id)) {
      log.note({
        level: "drop",
        where: `compose_view.emphasis.${id}`,
        reason: "names a block outside the primary region; emphasis reorders primary only",
      });
      continue;
    }
    if (!emphasis.includes(id)) emphasis.push(id);
  }
  if (emphasis.length === 0) return projection;

  const rest = projection.regions.primary.filter((id) => !emphasis.includes(id));
  return {
    ...projection,
    regions: { ...projection.regions, primary: [...emphasis, ...rest] },
  };
}

export interface ComposeResult {
  projection: Projection;
  /** True when the model's choice was refused and the default is what you see. */
  fallback: boolean;
  log: ComposeLog;
}

/**
 * The shell's entry point: state (+ an optional model choice) in, a validated
 * projection out.
 *
 * Always returns a projection. `validateProjection` on the composer's own output
 * is not paranoia about our code — it is the guarantee that whatever renders has
 * passed the same gate model-supplied input passes, so there is exactly one
 * definition of "a projection this build will draw".
 */
export function composeTaskSurface(state: TaskStateView, choice?: unknown): ComposeResult {
  const log = makeLog();
  const view = deriveView(state);
  const parsed = choice === undefined ? null : ModelChoiceSchema.safeParse(choice);

  let persona: Persona | undefined;
  let fallback = false;
  if (parsed !== null) {
    if (parsed.success) {
      persona = parsed.data.persona;
    } else {
      fallback = true;
      log.note({
        level: "reject",
        where: "compose_view",
        reason: `invalid choice, default persona "${view.kind}" stands — ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      });
    }
  }

  const composed = composeProjection(view, persona);
  const withEmphasis =
    parsed !== null && parsed.success ? applyModelChoice(composed, parsed.data, log) : composed;

  const { projection } = validateProjection(withEmphasis, log);
  if (projection === null) {
    // Unreachable while the composers only emit catalogue blocks, and it is a
    // branch rather than a `!` because "unreachable" is a claim this file makes
    // about itself and the fallback is what makes the claim safe to be wrong
    // about: the empty investigate surface renders, and the log says why.
    const bare = composeProjection({ ...view, kind: "investigate" }, "investigate");
    return { projection: bare, fallback: true, log };
  }
  return { projection, fallback, log };
}
