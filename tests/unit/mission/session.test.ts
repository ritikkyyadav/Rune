import { describe, it, expect } from "vitest";
import { MissionLog } from "../../../packages/mission/src/log";
import { initialState, metCriteria, type MissionState } from "../../../packages/mission/src/reduce";
import { MISSION, NOT_DONE, EVIDENCE } from "../../../packages/mission/src/demo/session";
import { header, project } from "../../../packages/mission/src/surface/stream";
import { ledger } from "../../../packages/mission/src/surface/ledger";
import { decisionHold, terminus } from "../../../packages/mission/src/surface/holds";
import {
  detectCaps,
  holdWidth,
  plainCaps,
  MEASURE,
  NARROW,
  type Caps,
} from "../../../packages/mission/src/render/caps";
import { plainText, assertColourBudget, type Row } from "../../../packages/mission/src/render/row";

/** Every rung of the ladder, driven by the same events. */
const RUNGS: Array<[string, Caps]> = [
  [
    "utf-8 · colour · 92",
    detectCaps({
      colour: "truecolor",
      glyphs: "utf8",
      pulse: "blocks",
      columns: MEASURE,
      measure: MEASURE,
    }),
  ],
  ["ascii · mono · 92", plainCaps(MEASURE)],
  [
    "utf-8 · mono · 58",
    detectCaps({
      colour: "none",
      glyphs: "utf8",
      pulse: "ascii",
      columns: NARROW,
      measure: NARROW,
    }),
  ],
  ["ascii · mono · 58", plainCaps(NARROW)],
];

/** Replay the reference mission, collecting every row the product would draw. */
function draw(caps: Caps): Row[] {
  const log = new MissionLog(undefined, { now: () => 1 });
  let previous: MissionState = initialState();
  const rows: Row[] = [
    ...header(
      {
        version: "0.4",
        repo: "ledger/core",
        branch: "main",
        treeClean: true,
        note: "3 open issues on auth",
        model: "claude-opus-4-1",
        effort: "max",
        sandboxed: true,
        posture: "edits and tests run free, shell asks",
      },
      caps,
    ),
  ];

  for (const beat of MISSION) {
    const ev = log.append(beat.event);
    const state = log.current;

    if (ev.type === "DECISION_OPENED") {
      const d = state.decisions[state.decisions.length - 1]!;
      rows.push(...(decisionHold(d, holdWidth(caps)).filter(Boolean) as Row[]));
    } else if (ev.type === "MISSION_CONCLUDED") {
      rows.push(
        ...(terminus(
          state,
          { notDone: NOT_DONE, evidence: EVIDENCE, branch: "gear/m-4f2a", commits: 3 },
          holdWidth(caps),
        ).filter(Boolean) as Row[]),
      );
    } else {
      rows.push(...(project(ev, state, previous, caps).filter(Boolean) as Row[]));
    }
    if (state.id) rows.push(...ledger(state, { caps, now: 2 }));
    previous = state;
  }
  return rows;
}

describe("the reference mission, at every rung of the ladder", () => {
  for (const [name, caps] of RUNGS) {
    describe(name, () => {
      const rows = draw(caps);
      const hold = holdWidth(caps);

      it("draws something", () => {
        expect(rows.length).toBeGreaterThan(40);
      });

      it("never overflows its measure — metadata drops to its own row instead", () => {
        // A snippet is the deliberate exception: it is meant to be pasted, so it opts
        // out of clipping and soft-wraps rather than being cut into a broken command.
        const over = rows
          .filter((r) => r.clip !== "never")
          .map((r) => plainText(r, hold))
          .filter((t) => t.length > hold.measure);
        expect(over.slice(0, 3)).toEqual([]);
      });

      it("lets a pasteable snippet through uncut, and nothing else", () => {
        const snippets = rows.filter((r) => r.clip === "never");
        for (const r of snippets) expect(plainText(r, hold)).not.toContain("…");
      });

      it("keeps syntax colour inside code regions and chrome outside them", () => {
        // Test 11: no token class outside a code region.
        expect(() => rows.forEach(assertColourBudget)).not.toThrow();
      });

      it("prints no percentage and no estimate of what remains", () => {
        const text = rows.map((r) => plainText(r, caps)).join("\n");
        expect(text).not.toMatch(/\d+%/);
        expect(text).not.toMatch(/\b(eta|remaining|est\.)\b/i);
      });
    });
  }
});

describe("what the session is allowed to claim", () => {
  const log = new MissionLog(undefined, { now: () => 1 });
  for (const beat of MISSION) log.append(beat.event);
  const state = log.current;

  it("concludes with every criterion met, each carrying its own evidence", () => {
    expect(state.phase).toBe("concluded");
    expect(metCriteria(state)).toBe(4);
    for (const c of state.criteria) expect(c.evidence).toBeDefined();
  });

  it("reports its own elapsed time, not the renderer's wall clock", () => {
    const text = terminus(state, { notDone: [], evidence: [] }, plainCaps())
      .map((r) => (r ? plainText(r, plainCaps()) : ""))
      .join("\n");
    expect(text).toContain("18m 42s");
  });

  it("names the finding it proved and deliberately did not fix", () => {
    const outOfScope = state.findings.filter((f) => f.outOfScope);
    expect(outOfScope.map((f) => f.id)).toEqual(["f-03", "f-05"]);
    // and nothing changed on their account
    expect(state.changes.some((c) => c.cause === "f-03")).toBe(false);
  });

  it("cites a finding as the cause of every change it made", () => {
    expect(state.changes.every((c) => c.cause)).toBe(true);
  });
});
