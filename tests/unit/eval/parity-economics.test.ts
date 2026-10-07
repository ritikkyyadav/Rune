import { describe, expect, test } from "bun:test";

import { pairRows } from "../../eval/parity/aggregate";
import { modeEconomics } from "../../eval/parity/economics";
import { buildReport, renderMarkdown } from "../../eval/parity/report";
import { row } from "../../fixtures/parity/rows";

describe("descriptive attempt economics", () => {
  const rows = [
    row(
      { task: "a", run: 1, arm: "rune", attempt: 1 },
      {
        scored: false,
        unscoredReason: "provider_outage",
        wallMs: 60_000,
        listUsd: 4,
      },
    ),
    row({ task: "a", run: 1, arm: "rune", attempt: 2 }, { wallMs: 120_000, listUsd: 2 }),
    row({ task: "a", run: 1, arm: "claude-code" }, { wallMs: 60_000, listUsd: 1 }),
    row({ task: "b", run: 1, arm: "rune" }, { wallMs: 180_000, listUsd: 3 }),
    row({ task: "b", run: 1, arm: "claude-code" }, { wallMs: 120_000, listUsd: 2 }),
  ];

  test("charges a failed first attempt and reports wall distributions and paired ratios", () => {
    const e = modeEconomics(pairRows(rows, "product", "claude-code"));
    expect(e.rune).toEqual({
      attempts: 3,
      cleanCompletions: 2,
      knownListUsd: 9,
      unknownPriceAttempts: 0,
      usdPerCleanCompletion: 4.5,
      medianWallMs: 120_000,
      p90WallMs: 180_000,
    });
    expect(e.comparator.usdPerCleanCompletion).toBe(1.5);
    expect(e.jointlyCleanPairs).toBe(2);
    expect(e.pairedCostRatio).toBe(1.75); // median of 2/1 and 3/2; retry cost stays in arm total
    expect(e.pairedWallRatio).toBe(1.75);
  });

  test("unknown prices never become zero-cost completions or a paired claim", () => {
    const missing = rows.map((r) =>
      r.task === "b" && r.arm === "rune" ? { ...r, listUsd: null } : r,
    );
    const e = modeEconomics(pairRows(missing, "product", "claude-code"));
    expect(e.rune.knownListUsd).toBe(6);
    expect(e.rune.unknownPriceAttempts).toBe(1);
    expect(e.rune.usdPerCleanCompletion).toBeNull();
    expect(e.pairedCostRatio).toBeNull();
    expect(e.pairedWallRatio).toBe(1.75);
  });

  test("zero clean completions or zero comparison denominator has no ratio", () => {
    const failures = rows.map((r) => ({ ...r, outcome: { ...r.outcome, hiddenPassed: 0 } }));
    const empty = modeEconomics(pairRows(failures, "product", "claude-code"));
    expect(empty.rune.usdPerCleanCompletion).toBeNull();
    expect(empty.jointlyCleanPairs).toBe(0);
    expect(empty.pairedCostRatio).toBeNull();
    expect(empty.pairedWallRatio).toBeNull();

    const freeComparator = rows.map((r) => (r.arm === "claude-code" ? { ...r, listUsd: 0 } : r));
    const e = modeEconomics(pairRows(freeComparator, "product", "claude-code"));
    expect(e.comparator.knownListUsd).toBe(0);
    expect(e.pairedCostRatio).toBeNull();
  });

  test("report writes the table without changing the gate", () => {
    const report = buildReport({ rows, inputs: [], b: 20 });
    expect(report.modes.product.economics?.rune.usdPerCleanCompletion).toBe(4.5);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("| Rune | 3 | 2 | $9 | 0 | $4.5 | 2.0 min | 3.0 min |");
    expect(markdown).toContain("Jointly clean completed pairs: 2.");
    expect(report.status).toBe(report.modes.product.status);
  });

  test("an override that mixes configurations suppresses pooled economics", () => {
    const mixed = rows.map((r) =>
      r.task === "b" && r.arm === "rune" ? { ...r, model: "other-model" } : r,
    );
    const report = buildReport({ rows: mixed, inputs: [], b: 20, allowMixedConfig: true });
    expect(report.modes.product.economics).toBeNull();
    expect(renderMarkdown(report)).toContain(
      "Attempt economics: unavailable because this mode combines configurations or builds",
    );
  });
});
