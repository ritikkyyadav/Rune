# Composition — the projection schema, the six personas, and the fallback

The agent does not write the interface. It writes a **projection**: a validated JSON
layout over a closed catalogue of [thirty primitives](primitives.md). The task state is
the source of truth, not the screen; a projection binds primitives to state paths, so
the surface updates live as events arrive without being recomposed.

Everything below lives in `apps/web/src/compose/`.

## The shape

```jsonc
{
  "taskId": "task_2f9c41",
  "persona": "investigate",
  "regions": {
    "header": ["title", "task-progress", "signals"],
    "primary": ["hypotheses-head", "hypotheses", "findings", "changes", "history"],
    "side": ["fleet", "artifacts", "spend"], // optional
    "actions": ["approvals", "questions"],
  },
  "blocks": [
    {
      "id": "hypotheses",
      "type": "hypothesis", // one of the thirty. Nothing else parses.
      "props": { "text": "", "status": "proposed" },
      "bind": "narrative.hypotheses", // a dotted state path, never an expression
      "foldWhen": "refuted", // one of five named predicates, never a callback
    },
  ],
}
```

`regions` name block ids; `blocks` define them. A region naming an id that no block
defines is dropped, and a block no region names is inert.

## Why a model cannot break the interface

Four rules, each a validation step rather than a convention (`projection.ts`):

1. **`type` is `z.enum(BLOCK_TYPES)`.** Thirty names. A block naming anything else is
   not a block. There is no other path from model output to the DOM.
2. **`props` are validated against that primitive's own schema**, and every primitive
   schema is a `z.strictObject`, so an unknown prop is a rejection rather than a
   silently ignored instruction. `dangerouslySetInnerHTML` in a props object fails the
   block instead of reaching React.
3. **`bind` is a dotted path**, matched by a regex that excludes `__proto__`,
   `prototype` and `constructor`, and resolved by walking own properties only
   (`bind.ts`). It is not JSONPath; there is nothing in it to evaluate.
4. **`foldWhen` is one of five named predicates** — `never`, `refuted`, `completed`,
   `resolved`, `empty` — because it is the one field whose natural type is a function,
   and a function from a model is a script.

A block that fails validation is **dropped with the reason recorded**, and the rest of
the projection stands. An all-or-nothing parse would let one bad prop blank a surface
that was 95% correct, which is the failure mode a person notices and cannot diagnose.

## The six personas

One deterministic composer per task kind (`personas.ts`). Same state in, byte-identical
projection out — no clock, no random ids, no iteration over an object's key order.

| persona       | the spine, in order                                               |
| ------------- | ----------------------------------------------------------------- |
| `investigate` | hypotheses · evidence · changes · commands · timeline · decisions |
| `build`       | checklist · diff · terminal · checks · artifacts · log            |
| `analyze`     | metrics · chart · comparison · table · sources · reading          |
| `research`    | claims · sources · hypotheses · relationship · summary            |
| `operate`     | approvals · logs · terminal · timeline · signals                  |
| `write`       | artifact · outline · prose · sources · changes                    |

Every persona also gets the shared header (`heading` bound to `objective`, `progress`
bound to `progress`), the folded `transcript` at the foot of `primary`, the `side`
column (fleet, artifacts, cost) and the `actions` region.

Two rules decide whether a block is in the projection:

- **Spine blocks are always present.** They are the persona's shape, and their designed
  empty states ("No hypotheses yet.") are how a task three seconds old still reads as
  an investigation rather than as a blank page.
- **Supplementary blocks appear only when their data is non-empty.** A surface that
  shows an empty Cost, an empty fleet and an empty artifact list on every task is the
  "everything, always" layout Phase 11 replaced.

## Binding, and why it means no recomposition

The composer runs once per task-kind change. Everything after that is the renderer
(`Surface.tsx`) resolving `bind` paths against the current state on each render.

| mode     | what happens                                                               |
| -------- | -------------------------------------------------------------------------- |
| `assign` | `props[key] = value`                                                       |
| `merge`  | `props = { …props, …value }`                                               |
| `repeat` | one component per array element, the element spread over the block's props |
| `none`   | the primitive takes no live data                                           |

`repeat` is what makes live updates cheap: a projection composed when there was one
hypothesis draws four of them ten seconds later, from the same block, with no
recomposition and nothing else on the page moving.

Props are **re-validated at render**, not only at compose. That is not belt and braces:
compose-time validation sees a block's static props, and everything interesting arrives
later through a binding. A malformed row from the wire renders that one block's error
state with the reason on it, and the other nineteen blocks are unaffected.

### Folding

`foldWhen: "refuted"` on the hypotheses block means a hypothesis whose `status` turns
`refuted` folds to one line carrying its reason. The fold is reversible — a real
`<button>` with `aria-expanded` — and the Decision Record keeps the folded branches
present. The schema requires a `reason` on a refuted hypothesis, because "refuted" with
no reason is the branch disappearing rather than being folded.

## `compose_view` — the one thing the model gets to say

```ts
{ persona: "investigate" | "build" | "analyze" | "research" | "operate" | "write",
  emphasis: BlockId[] }   // max 8
```

That is the entire grammar. The model cannot name a block type, supply props, write a
bind path, add a region, or reorder anything it did not compose.

`applyModelChoice(projection, choice)` returns **the default on anything invalid**, and
logs why. There is no branch in which a rejected choice degrades the surface: the worst
outcome of the model saying something nonsensical is the surface it would have got by
saying nothing. It refuses, and logs, when

- the choice does not parse — a persona outside the six, an emphasis entry that is not a
  block id, an unknown key, a non-object;
- the persona does not match the projection's. A persona change is a **recomposition**,
  and this function has a projection, not a state. Returning a projection labelled
  `analyze` whose blocks are an investigation's would be a lie told in a type-correct
  way, so `composeTaskSurface(state, choice)` handles that case by composing with the
  chosen persona first and then applying the emphasis.

An emphasis id naming no block, or naming a block outside `primary`, is dropped on its
own; the rest of the emphasis still applies, because one stale id should not cost the
model its whole request. Emphasis reorders `primary` — emphasised first, in the order
given, everything else after in composed order. It does not add, remove, resize or
restyle anything.

## The task state the composer reads

`state.ts` is the web's view of the Task State Model that **P11.1** adds to
`packages/orchestrator/src/task-state.ts` — `kind`, `narrative` (hypotheses,
decisions), `artifacts`, `pendingDecisions`, `progress` — using its field names
verbatim so the merge is mechanical. When P11.1 lands, that module becomes a re-export
of the protocol types and nothing else in `compose/` moves.

`deriveView(state)` is the one place a composer's input is reshaped, and it does three
things, all pure and idempotent:

- `heldDecisions` — the held steps and approvals among `pendingDecisions`, in the
  Approval primitive's prop shape;
- `askDecisions` — the questions and reviews, in the Choice primitive's prop shape;
- `checkRows` — `checks` in the Table primitive's row shape.

Filtering and renaming are not things a state _path_ can do, and putting them into the
binding language is how a projection schema turns into a template engine. They happen
once, in a named function, where they can be read and tested.

## Where the pieces are

| file                      | what it owns                                                   |
| ------------------------- | -------------------------------------------------------------- |
| `compose/projection.ts`   | the zod schema, `validateProjection`, the compose log          |
| `compose/personas.ts`     | the six deterministic composers                                |
| `compose/model-choice.ts` | `compose_view`'s whitelist, the fallback, `composeTaskSurface` |
| `compose/bind.ts`         | path resolution, the fold predicates, `bindBlock`              |
| `compose/Surface.tsx`     | the renderer: regions, live binding, per-block error states    |
| `compose/state.ts`        | the Task State view and `deriveView`                           |
| `compose/fixture.ts`      | the API latency investigation the tests and the gallery use    |
