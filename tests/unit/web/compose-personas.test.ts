// ─── The six composers, from the API latency investigation ───
//
// One test per persona, all projecting the SAME task state — the worked example
// from the Phase 11 wireframes, in `compose/fixture.ts` — because a composer
// that only works on the state shaped for it is a template, not a composer.
//
// What each persona test asserts:
//   • the projection validates against the projection schema, which means every
//     block's props already satisfy that primitive's own schema;
//   • the spine the brief assigns that persona is present, in order;
//   • every id a region names resolves to a block, and every bound block's path
//     resolves to something in the state;
//   • composing twice produces byte-identical output. Determinism is what makes
//     a screenshot reviewable and a projection cacheable.

import { describe, expect, test } from "bun:test";

import { API_LATENCY_TASK } from "../../../apps/web/src/compose/fixture";
import { composeProjection } from "../../../apps/web/src/compose/personas";
import { composeTaskSurface } from "../../../apps/web/src/compose/model-choice";
import { resolvePath } from "../../../apps/web/src/compose/bind";
import {
  blocksOf,
  validateProjection,
  type Projection,
} from "../../../apps/web/src/compose/projection";
import { TASK_KINDS, deriveView, type TaskKind } from "../../../apps/web/src/compose/state";
import { BLOCK_TYPES, PRIMITIVES } from "../../../apps/web/src/primitives/index";

const STATE = deriveView(API_LATENCY_TASK);

/** The spine the brief assigns each persona, by block type, in `primary` order. */
const SPINE: Record<TaskKind, string[]> = {
  investigate: ["heading", "hypothesis", "evidence", "diff", "terminal", "timeline", "decision"],
  build: ["checklist", "diff", "terminal", "table", "artifact", "log"],
  analyze: ["metric", "chart", "comparison", "table", "source"],
  research: ["evidence", "source", "hypothesis", "relationship"],
  operate: ["approval", "log", "terminal", "timeline"],
  write: ["artifact", "tree", "text", "source"],
};

function typesIn(projection: Projection, region: "header" | "primary" | "side" | "actions") {
  return blocksOf(projection, region).map((b) => b.type);
}

describe.each(TASK_KINDS)("the %s persona", (persona) => {
  const projection = composeProjection(STATE, persona);

  test("validates, with every block's props matching its primitive's schema", () => {
    const { projection: valid, notes } = validateProjection(projection);
    expect(notes, `composer emitted a projection its own validator rejects`).toEqual([]);
    expect(valid).not.toBeNull();
    expect(valid!.blocks.length).toBe(projection.blocks.length);
  });

  test("carries the brief's spine, in order", () => {
    const primary = typesIn(projection, "primary");
    const wanted = SPINE[persona];
    // A subsequence check, not equality: supplementary blocks may sit between
    // spine blocks, and the transcript always closes the region.
    let cursor = 0;
    for (const type of primary) {
      if (type === wanted[cursor]) cursor += 1;
    }
    expect(cursor, `${persona} primary was [${primary.join(", ")}]`).toBe(wanted.length);
  });

  test("uses only catalogue types", () => {
    for (const block of projection.blocks) {
      expect(BLOCK_TYPES).toContain(block.type);
    }
  });

  test("names no block it does not define, and defines none twice", () => {
    const ids = projection.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    const defined = new Set(ids);
    for (const region of ["header", "primary", "side", "actions"] as const) {
      const named =
        region === "side" ? (projection.regions.side ?? []) : projection.regions[region];
      for (const id of named) expect(defined.has(id), `${region} names ${id}`).toBe(true);
    }
  });

  test("every bind path resolves against the state", () => {
    for (const block of projection.blocks) {
      if (block.bind === undefined) continue;
      const value = resolvePath(STATE, block.bind);
      expect(value, `${block.id} binds ${block.bind}, which resolved to undefined`).toBeDefined();
    }
  });

  test("a foldWhen only sits on a primitive that can fold", () => {
    for (const block of projection.blocks) {
      if (block.foldWhen === undefined || block.foldWhen === "never") continue;
      expect(PRIMITIVES[block.type].foldable, `${block.type} cannot fold`).toBe(true);
    }
  });

  test("is deterministic", () => {
    expect(JSON.stringify(composeProjection(STATE, persona))).toBe(JSON.stringify(projection));
  });

  test("has a header, a primary and the task id", () => {
    expect(projection.taskId).toBe(STATE.taskId);
    expect(projection.persona).toBe(persona);
    expect(typesIn(projection, "header")[0]).toBe("heading");
    expect(projection.regions.primary.length).toBeGreaterThan(2);
  });
});

describe("the investigate surface, in detail", () => {
  const { projection } = composeTaskSurface(STATE);

  test("defaults to the state's own kind", () => {
    expect(projection.persona).toBe("investigate");
  });

  test("binds the hypotheses to the narrative and folds the refuted ones", () => {
    const block = projection.blocks.find((b) => b.id === "hypotheses");
    expect(block).toBeDefined();
    expect(block!.type).toBe("hypothesis");
    expect(block!.bind).toBe("narrative.hypotheses");
    expect(block!.foldWhen).toBe("refuted");
  });

  test("the plan's progress is counted, never asserted", () => {
    const block = projection.blocks.find((b) => b.id === "task-progress");
    expect(block!.type).toBe("progress");
    expect(block!.bind).toBe("progress");
    const bound = resolvePath(STATE, "progress") as Record<string, unknown>;
    expect(bound.done).toBe(5);
    expect(bound.total).toBe(8);
    expect(Object.keys(bound)).not.toContain("percent");
  });

  test("the held step reaches the actions region with its exact grant", () => {
    const approvals = blocksOf(projection, "actions").find((b) => b.type === "approval");
    expect(approvals?.bind).toBe("heldDecisions");
    const held = resolvePath(STATE, "heldDecisions") as Array<Record<string, unknown>>;
    expect(held).toHaveLength(1);
    expect(held[0]!.grant).toContain("CREATE INDEX CONCURRENTLY on public.orders");
    // The exact grant, not a category.
    expect(held[0]!.grant).not.toBe("database access");
  });

  test("the question reaches the actions region as a Choice with its options", () => {
    const choice = blocksOf(projection, "actions").find((b) => b.type === "choice");
    expect(choice?.bind).toBe("askDecisions");
    const asks = resolvePath(STATE, "askDecisions") as Array<Record<string, unknown>>;
    expect((asks[0]!.options as unknown[]).length).toBe(2);
  });

  test("the transcript is present and folded", () => {
    const block = projection.blocks.find((b) => b.id === "conversation");
    expect(block!.type).toBe("transcript");
    expect(block!.props.folded).toBe(true);
  });
});

describe("a task that has only just started", () => {
  // The state a surface is in three seconds after the intent strip: a goal, a
  // kind, and nothing else. Every persona must still compose something that
  // reads as that kind of work rather than as a blank page.
  const bare = deriveView({ taskId: "t_new", objective: "Find out why CI is slow", kind: "build" });

  test.each(TASK_KINDS)("%s composes and validates from a bare state", (persona) => {
    const projection = composeProjection(bare, persona);
    const { projection: valid, notes } = validateProjection(projection);
    expect(notes).toEqual([]);
    expect(valid!.regions.primary.length).toBeGreaterThan(2);
  });

  test("supplementary blocks stay out until there is data", () => {
    const projection = composeProjection(bare, "investigate");
    const ids = projection.blocks.map((b) => b.id);
    for (const absent of ["fleet", "artifacts", "spend", "conversation", "changes", "commands"]) {
      expect(ids, `${absent} should not be composed for an empty task`).not.toContain(absent);
    }
    // …and the spine is still there, so the surface reads as an investigation.
    expect(ids).toContain("hypotheses");
    expect(ids).toContain("history");
  });

  test("the side region is omitted entirely rather than left empty", () => {
    const projection = composeProjection(bare, "investigate");
    expect(projection.regions.side).toBeUndefined();
  });
});
