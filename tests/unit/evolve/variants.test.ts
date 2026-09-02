/**
 * P7.3 — the variants registry and the tune rules that name it.
 *
 * Two claims are under test and they are different in kind:
 *
 *  1. The registry is CLOSED and structurally cannot express a safety or spend
 *     change. Most of that is enforced by the type system (a variant carrying
 *     `sandboxEnabled` does not compile), so what is left to test at runtime is
 *     that nobody has cast past it and that the config-line renderer never
 *     emits a forbidden key.
 *  2. The tuner keys on the failure modes that OCCUR. Three of the four
 *     original rules fired on signals with zero occurrences across 601
 *     sessions; the rules added here fire on aborted, error, max_turns and
 *     halted, which is where the mass actually is.
 */

import { describe, expect, it } from "bun:test";

import {
  VARIANTS,
  VARIANT_IDS,
  isVariantId,
  variantConfig,
  variantConfigLines,
} from "../../../packages/orchestrator/src/evolve/variants";
import {
  AB_CONFIG_KEYS,
  AB_FORBIDDEN_KEYS,
  configHash,
} from "../../../packages/orchestrator/src/evolve/config-hash";
import { scorecard, tuneProposals } from "../../../packages/orchestrator/src/retro";
import type { RetroSample, RunRetro } from "../../../packages/orchestrator/src/retro";

describe("the variants registry is a closed allowlist", () => {
  it("has variants, and every id matches its key", () => {
    expect(VARIANT_IDS.length).toBeGreaterThan(0);
    for (const id of VARIANT_IDS) expect(VARIANTS[id].id).toBe(id);
  });

  it("recognises only ids it declares", () => {
    expect(isVariantId("doctrine_full")).toBe(true);
    expect(isVariantId("sandbox_off")).toBe(false);
    expect(isVariantId("__proto__")).toBe(false);
    expect(isVariantId("constructor")).toBe(false);
  });

  it("touches no key outside the A/B allowlist", () => {
    for (const id of VARIANT_IDS) {
      for (const key of Object.keys(variantConfig(id))) {
        expect(AB_CONFIG_KEYS as readonly string[]).toContain(key);
        expect(AB_FORBIDDEN_KEYS).not.toContain(key);
      }
    }
  });

  it("gives every variant a hash distinct from the control arm", () => {
    // A variant that hashes the same as control is a variant that changes
    // nothing — an A/B on it would report a "win" that is pure noise.
    const control = configHash({});
    const seen = new Map<string, string>();
    for (const id of VARIANT_IDS) {
      const h = configHash(variantConfig(id));
      expect(h).not.toBe(control);
      expect(seen.has(h)).toBe(false);
      seen.set(h, id);
    }
  });

  it("states a hypothesis for each variant", () => {
    // A promotion has to be readable back as a belief someone can disagree
    // with; an unexplained knob flip is not evidence of anything.
    for (const id of VARIANT_IDS) {
      expect(VARIANTS[id].hypothesis.length).toBeGreaterThan(40);
      expect(VARIANTS[id].summary.length).toBeGreaterThan(10);
    }
  });

  it("renders config lines for every variant, and only safe sections", () => {
    const allowedSections = new Set(["[llm]", "[notebook]", "[context]", "[evolve]"]);
    for (const id of VARIANT_IDS) {
      const lines = variantConfigLines(id);
      // A variant with no rendering cannot be promoted — promote.ts treats an
      // empty render as a refusal, so an empty one here would be a trap.
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        if (line.startsWith("[")) expect(allowedSections.has(line)).toBe(true);
        for (const forbidden of AB_FORBIDDEN_KEYS) {
          expect(line.startsWith(`${forbidden} =`)).toBe(false);
        }
      }
    }
  });

  it("renders doctrine_full as the config line a person would have written", () => {
    expect(variantConfigLines("doctrine_full")).toEqual(["[llm]", 'doctrineDelivery = "full"']);
  });
});

// ─── Tune rules ───

function retroOf(partial: Partial<RunRetro>): RunRetro {
  return {
    v: 1,
    at: "2026-09-02T00:00:00.000Z",
    scope: "session",
    outcome: "finished",
    steps: { total: 4, done: 4, unproven: 0, open: 0 },
    checks: { passed: 2, failed: 0 },
    tools: { calls: 10, failed: 1, byName: {} },
    gates: {},
    completions: 8,
    filesWritten: 2,
    cost: { usd: 0, listUsd: 0.5, inputTokens: 0, outputTokens: 0 },
    durationMs: 1000,
    lessons: [],
    ...partial,
  };
}

const sample = (model: string, partial: Partial<RunRetro>): RetroSample => ({
  retro: retroOf(partial),
  model,
  workspaceRoot: "/w",
  sessionId: "s",
});

/** n runs of one outcome, plus enough clean runs to clear the minRuns floor. */
function rowsFor(outcome: RunRetro["outcome"], bad: number, clean: number) {
  return scorecard(
    [
      ...Array.from({ length: bad }, () => sample("a", { outcome })),
      ...Array.from({ length: clean }, () => sample("a", {})),
    ],
    "model",
  );
}

describe("tune rules key on the failure modes that occur", () => {
  it("counts max_turns and halted separately from the residual", () => {
    const rows = scorecard(
      [
        sample("a", { outcome: "max_turns" }),
        sample("a", { outcome: "halted" }),
        sample("a", { outcome: "context_exhausted" }),
        sample("a", { outcome: "provider_lost" }),
      ],
      "model",
    );
    expect(rows[0].maxTurns).toBe(1);
    expect(rows[0].halted).toBe(1);
    expect(rows[0].other).toBe(2);
  });

  it("proposes doctrine_full when a quarter of runs are aborted by hand", () => {
    const props = tuneProposals(rowsFor("aborted", 3, 5));
    const p = props.find((x) => x.variant === "doctrine_full");
    expect(p).toBeDefined();
    expect(p!.signal).toContain("3 of 8 runs were aborted");
    expect(p!.config).toContain("doctrineDelivery");
  });

  it("proposes notebook_on when a fifth of runs end in an error", () => {
    const props = tuneProposals(rowsFor("error", 3, 7));
    const p = props.find((x) => x.variant === "notebook_on");
    expect(p).toBeDefined();
    expect(p!.signal).toContain("3 of 10 runs ended in an error");
  });

  it("proposes effort_ceiling when runs burn the turn ceiling", () => {
    const props = tuneProposals(rowsFor("max_turns", 3, 10));
    const p = props.find(
      (x) => x.variant === "effort_ceiling" && x.signal.includes("hit the turn ceiling"),
    );
    expect(p).toBeDefined();
  });

  it("refuses to name a variant for supervisor halts", () => {
    // The one rule that must NOT be actionable: no variant may touch Auto
    // mode, and a tuner that offered one would be proposing a mutation.
    const props = tuneProposals(rowsFor("halted", 2, 10));
    const p = props.find((x) => x.signal.includes("halted by the supervisor"));
    expect(p).toBeDefined();
    expect(p!.variant).toBeNull();
    expect(p!.proposal).toContain("no variant may touch Auto mode");
  });

  it("names a real variant wherever it names one at all", () => {
    const rows = scorecard(
      [
        ...Array.from({ length: 6 }, () => sample("a", { outcome: "aborted" })),
        ...Array.from({ length: 4 }, () => sample("a", { outcome: "error" })),
        ...Array.from({ length: 4 }, () => sample("a", { outcome: "max_turns" })),
        ...Array.from({ length: 3 }, () => sample("a", { outcome: "halted" })),
        ...Array.from({ length: 3 }, () =>
          sample("a", { outcome: "stalled", steps: { total: 3, done: 3, unproven: 3, open: 0 } }),
        ),
      ],
      "model",
    );
    const props = tuneProposals(rows);
    expect(props.map((p) => p.variant).sort()).toEqual([
      "doctrine_full",
      "effort_ceiling",
      "notebook_on",
      null,
    ]);
    for (const p of props) {
      if (p.variant !== null) expect(isVariantId(p.variant)).toBe(true);
      expect(p.config.length).toBeGreaterThan(0);
    }
  });

  it("still proposes nothing for a model that mostly finishes", () => {
    expect(tuneProposals(rowsFor("finished", 0, 8))).toHaveLength(0);
  });
});
