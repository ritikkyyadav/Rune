// ─── Nothing the model says can add a block type that is not in the catalogue ───
//
// This file is the safety argument of the intent layer, written as assertions.
// The claim is narrow and total: a `compose_view` call is a persona and an
// emphasis list, and there is no value either field can take that puts a block
// type, a prop, a bind path or a fragment of markup on screen.
//
// It is tested three ways, because "we validated it" is a claim and the three
// are evidence:
//
//   1. hostile choices — 30-odd shapes a confused or adversarial model could
//      emit — every one returns the default, with the reason logged;
//   2. hostile PROJECTIONS — what a compromised composer would have to produce
//      to get an out-of-catalogue block through — every one is dropped;
//   3. an invariant swept over both: after any of them, every surviving block's
//      type is in BLOCK_TYPES.

import { describe, expect, test } from "bun:test";

import { API_LATENCY_TASK } from "../../../apps/web/src/compose/fixture";
import { composeProjection } from "../../../apps/web/src/compose/personas";
import {
  ModelChoiceSchema,
  applyModelChoice,
  composeTaskSurface,
} from "../../../apps/web/src/compose/model-choice";
import { resolvePath, shouldFold } from "../../../apps/web/src/compose/bind";
import { makeLog, validateProjection } from "../../../apps/web/src/compose/projection";
import { deriveView } from "../../../apps/web/src/compose/state";
import { BLOCK_TYPES } from "../../../apps/web/src/primitives/index";

const STATE = deriveView(API_LATENCY_TASK);
const DEFAULT = composeProjection(STATE, "investigate");
const BEFORE = JSON.stringify(DEFAULT);

/** Everything a model could put in `compose_view` that is not a valid choice. */
const HOSTILE_CHOICES: Array<[string, unknown]> = [
  ["null", null],
  ["undefined-ish", {}],
  ["a string", "investigate"],
  ["an array", ["investigate"]],
  ["a number", 3],
  ["persona missing", { emphasis: ["hypotheses"] }],
  ["emphasis missing", { persona: "investigate" }],
  ["persona not in the six", { persona: "hack", emphasis: [] }],
  ["persona nearly right", { persona: "Investigate", emphasis: [] }],
  ["persona is a block type", { persona: "preview", emphasis: [] }],
  ["persona is an object", { persona: { toString: "investigate" }, emphasis: [] }],
  ["emphasis is a string", { persona: "investigate", emphasis: "hypotheses" }],
  ["emphasis holds objects", { persona: "investigate", emphasis: [{ id: "hypotheses" }] }],
  ["emphasis holds a path", { persona: "investigate", emphasis: ["../../etc/passwd"] }],
  ["emphasis holds __proto__", { persona: "investigate", emphasis: ["__proto__"] }],
  ["emphasis holds constructor", { persona: "investigate", emphasis: ["constructor"] }],
  ["emphasis is too long", { persona: "investigate", emphasis: Array(9).fill("hypotheses") }],
  ["an extra key: blocks", { persona: "investigate", emphasis: [], blocks: [{ type: "script" }] }],
  ["an extra key: regions", { persona: "investigate", emphasis: [], regions: { primary: [] } }],
  ["an extra key: html", { persona: "investigate", emphasis: [], html: "<img onerror=alert(1)>" }],
  [
    "an extra key: props",
    { persona: "investigate", emphasis: [], props: { dangerouslySetInnerHTML: { __html: "x" } } },
  ],
  [
    "a prototype-polluting key",
    JSON.parse('{"persona":"investigate","emphasis":[],"__proto__":{"x":1}}'),
  ],
];

describe("an invalid compose_view returns the default, and says why", () => {
  test.each(HOSTILE_CHOICES)("%s", (_label, choice) => {
    const log = makeLog();
    const out = applyModelChoice(DEFAULT, choice, log);
    expect(JSON.stringify(out)).toBe(BEFORE);
    expect(
      log.notes.length,
      "a rejection with no reason logged is a silent failure",
    ).toBeGreaterThan(0);
    expect(log.notes[0]!.level).toBe("reject");
    expect(log.notes[0]!.reason.length).toBeGreaterThan(10);
  });

  test("and the whole surface still composes, with fallback flagged", () => {
    for (const [label, choice] of HOSTILE_CHOICES) {
      const result = composeTaskSurface(STATE, choice);
      expect(result.projection.persona, label).toBe("investigate");
      for (const block of result.projection.blocks) {
        expect(BLOCK_TYPES, `${label} introduced ${block.type}`).toContain(block.type);
      }
    }
  });

  test("the schema itself refuses every one of them", () => {
    for (const [label, choice] of HOSTILE_CHOICES) {
      // The one exception is the prototype-pollution literal, whose OWN keys are
      // valid — which is the point: `__proto__` in JSON is an own property, and
      // a strict object refuses it as an unknown key rather than assigning it.
      const parsed = ModelChoiceSchema.safeParse(choice);
      expect(parsed.success, `${label} parsed`).toBe(false);
    }
  });
});

describe("a valid compose_view does exactly one thing", () => {
  test("it reorders primary, and changes nothing else", () => {
    const log = makeLog();
    const out = applyModelChoice(
      DEFAULT,
      { persona: "investigate", emphasis: ["history", "hypotheses"] },
      log,
    );
    expect(out.regions.primary.slice(0, 2)).toEqual(["history", "hypotheses"]);
    // Same blocks, same ids, same props — a permutation of primary and nothing more.
    expect(out.blocks).toEqual(DEFAULT.blocks);
    expect([...out.regions.primary].sort()).toEqual([...DEFAULT.regions.primary].sort());
    expect(out.regions.header).toEqual(DEFAULT.regions.header);
    expect(out.regions.actions).toEqual(DEFAULT.regions.actions);
    expect(log.notes).toEqual([]);
  });

  test("an emphasis id that names nothing is dropped on its own", () => {
    const log = makeLog();
    const out = applyModelChoice(
      DEFAULT,
      { persona: "investigate", emphasis: ["nope", "history"] },
      log,
    );
    expect(out.regions.primary[0]).toBe("history");
    expect(log.notes.map((n) => n.level)).toEqual(["drop"]);
    expect(log.notes[0]!.reason).toContain("names no block");
  });

  test("an emphasis id outside primary is dropped, not promoted into it", () => {
    const log = makeLog();
    const out = applyModelChoice(DEFAULT, { persona: "investigate", emphasis: ["title"] }, log);
    expect(out.regions.primary).toEqual(DEFAULT.regions.primary);
    expect(log.notes[0]!.reason).toContain("outside the primary region");
  });

  test("a persona different from the projection's is refused, not faked", () => {
    const log = makeLog();
    const out = applyModelChoice(DEFAULT, { persona: "analyze", emphasis: [] }, log);
    expect(out.persona).toBe("investigate");
    expect(JSON.stringify(out)).toBe(BEFORE);
    expect(log.notes[0]!.reason).toContain("recomposition");
  });

  test("but composeTaskSurface honours it by recomposing", () => {
    const result = composeTaskSurface(STATE, { persona: "analyze", emphasis: ["data"] });
    expect(result.projection.persona).toBe("analyze");
    expect(result.fallback).toBe(false);
    expect(result.projection.regions.primary[0]).toBe("data");
    // …and the blocks are the analyze persona's, not the investigate one's.
    expect(result.projection.blocks.map((b) => b.type)).toContain("chart");
    expect(result.projection.blocks.map((b) => b.id)).not.toContain("hypotheses");
  });
});

describe("a projection can only name a type in the catalogue", () => {
  const cases: Array<[string, unknown]> = [
    ["script", "script"],
    ["iframe", "iframe"],
    ["html", "html"],
    ["raw", "raw"],
    ["Text (capitalised)", "Text"],
    ["__proto__", "__proto__"],
    ["constructor", "constructor"],
    ["toString", "toString"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["empty string", ""],
    ["a number", 7],
    ["null", null],
  ];

  test.each(cases)("a block typed %s is dropped", (_label, type) => {
    const log = makeLog();
    const { projection } = validateProjection(
      {
        ...DEFAULT,
        blocks: [...DEFAULT.blocks, { id: "injected", type, props: {} }],
        regions: { ...DEFAULT.regions, primary: [...DEFAULT.regions.primary, "injected"] },
      },
      log,
    );
    // A bad `type` fails the projection schema outright — the enum is checked
    // before any block is looked at — so the whole thing is refused rather than
    // partially accepted. Either way, nothing named `injected` renders.
    if (projection !== null) {
      expect(projection.blocks.map((b) => b.id)).not.toContain("injected");
    }
    expect(log.notes.length).toBeGreaterThan(0);
  });

  test("a block with markup in its props is dropped, and the rest survive", () => {
    const log = makeLog();
    const { projection } = validateProjection(
      {
        ...DEFAULT,
        blocks: [
          ...DEFAULT.blocks,
          {
            id: "smuggled",
            type: "text",
            props: { body: "hi", dangerouslySetInnerHTML: { __html: "<script>alert(1)</script>" } },
          },
        ],
        regions: { ...DEFAULT.regions, primary: [...DEFAULT.regions.primary, "smuggled"] },
      },
      log,
    );
    expect(projection).not.toBeNull();
    expect(projection!.blocks.map((b) => b.id)).not.toContain("smuggled");
    expect(projection!.regions.primary).not.toContain("smuggled");
    // The other blocks are untouched: one bad block does not blank a surface.
    expect(projection!.blocks.length).toBe(DEFAULT.blocks.length);
    expect(log.notes.some((n) => n.reason.includes("do not match the text schema"))).toBe(true);
  });

  test("a duplicate block id is dropped", () => {
    const log = makeLog();
    const { projection } = validateProjection(
      { ...DEFAULT, blocks: [...DEFAULT.blocks, DEFAULT.blocks[0]!] },
      log,
    );
    expect(projection!.blocks.length).toBe(DEFAULT.blocks.length);
    expect(log.notes[0]!.reason).toContain("duplicate");
  });

  test("a foldWhen on a primitive that cannot fold is repaired, not obeyed", () => {
    const log = makeLog();
    const { projection } = validateProjection(
      {
        ...DEFAULT,
        blocks: DEFAULT.blocks.map((b) =>
          b.id === "history" ? { ...b, foldWhen: "refuted" as const } : b,
        ),
      },
      log,
    );
    const history = projection!.blocks.find((b) => b.id === "history");
    expect(history).toBeDefined();
    expect(history!.foldWhen).toBeUndefined();
    expect(log.notes[0]!.level).toBe("repair");
  });
});

describe("bind paths carry no code and cannot walk out of the state", () => {
  test("the prototype chain is unreachable", () => {
    for (const path of [
      "__proto__",
      "constructor",
      "narrative.__proto__",
      "narrative.constructor.name",
      "todos.0.__proto__",
      "objective.constructor",
    ]) {
      expect(resolvePath(STATE, path), path).toBeUndefined();
    }
  });

  test("the schema refuses them before resolution ever runs", () => {
    const log = makeLog();
    for (const bind of ["__proto__", "narrative.__proto__.x", "a.constructor", "a.prototype.b"]) {
      const { projection } = validateProjection(
        {
          ...DEFAULT,
          blocks: [{ id: "b", type: "text", props: { body: "" }, bind }],
          regions: { header: [], primary: ["b"], actions: [] },
        },
        log,
      );
      expect(projection, bind).toBeNull();
    }
  });

  test("a path that does not exist resolves to undefined rather than throwing", () => {
    expect(resolvePath(STATE, "nope")).toBeUndefined();
    expect(resolvePath(STATE, "narrative.nope.deeper")).toBeUndefined();
    expect(resolvePath(null, "a.b")).toBeUndefined();
  });

  test("real paths still resolve", () => {
    expect(resolvePath(STATE, "objective")).toBe(API_LATENCY_TASK.objective);
    expect((resolvePath(STATE, "narrative.hypotheses") as unknown[]).length).toBe(3);
    expect(resolvePath(STATE, "narrative.hypotheses.0.status")).toBe("refuted");
  });
});

describe("the fold predicates are five names and nothing else", () => {
  test("refuted", () => {
    expect(shouldFold("refuted", { status: "refuted" })).toBe(true);
    expect(shouldFold("refuted", { status: "confirmed" })).toBe(false);
    expect(shouldFold("refuted", "refuted")).toBe(false);
  });
  test("resolved", () => {
    expect(shouldFold("resolved", { resolution: "approved" })).toBe(true);
    expect(shouldFold("resolved", { resolution: null })).toBe(false);
    expect(shouldFold("resolved", {})).toBe(false);
  });
  test("completed, empty and never", () => {
    expect(shouldFold("completed", { status: "completed" })).toBe(true);
    expect(shouldFold("empty", [])).toBe(true);
    expect(shouldFold("empty", ["x"])).toBe(false);
    expect(shouldFold("never", { status: "refuted" })).toBe(false);
    expect(shouldFold(undefined, { status: "refuted" })).toBe(false);
  });
});

describe("the invariant, swept", () => {
  test("no choice, valid or hostile, ever produces a type outside the catalogue", () => {
    const choices: unknown[] = [
      undefined,
      ...HOSTILE_CHOICES.map(([, c]) => c),
      { persona: "build", emphasis: [] },
      { persona: "analyze", emphasis: ["data", "series"] },
      { persona: "research", emphasis: ["claims"] },
      { persona: "operate", emphasis: ["held", "output"] },
      { persona: "write", emphasis: ["draft"] },
      { persona: "investigate", emphasis: ["hypotheses", "history", "findings"] },
    ];
    let seen = 0;
    for (const choice of choices) {
      const { projection } = composeTaskSurface(STATE, choice);
      for (const block of projection.blocks) {
        expect(BLOCK_TYPES).toContain(block.type);
        seen += 1;
      }
      // Every id a region names still resolves to a block that exists.
      const ids = new Set(projection.blocks.map((b) => b.id));
      for (const region of ["header", "primary", "side", "actions"] as const) {
        const named =
          region === "side" ? (projection.regions.side ?? []) : projection.regions[region];
        for (const id of named) expect(ids.has(id)).toBe(true);
      }
    }
    expect(seen, "the sweep inspected nothing").toBeGreaterThan(200);
  });
});
