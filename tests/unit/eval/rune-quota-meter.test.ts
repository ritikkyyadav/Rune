// ─── The quota gate can see: Rune's rows carry the provider's meter ───
//
// Until fae16ab no Rune build read a provider's window headers, so the pair
// runner's RUNE_EVAL_QUOTA_PCT gate was blind and a series authorised by it
// alone stopped after one pair. The gateway now puts Codex's meter on every
// response (`capacity`: a five-hour `primary` window and a weekly `secondary`
// one), the engine writes it into rune.db with the cost row, and this file
// holds the rig's side of the join:
//
//   · the ledger reads the FULLEST window, not only the five-hour one — a week
//     run dry strands the founder for days;
//   · the highest reading of the run, not the last;
//   · the stream and the ledger both count, and the fuller one wins;
//   · no meter anywhere is still `null`, so the gate still knows it is blind.
//
// Nothing here reaches a model: rune.db is a scratch SQLite file with only the
// `events` rows the reader queries.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMPTY_LEDGER, parseRuneOutput } from "../../eval/comparison/arms/rune";
import type { ArmCapture } from "../../eval/comparison/arms/types";
import { fullestWindowPct, runeCost } from "../../eval/comparison/harness";

const scratch = mkdtempSync(join(tmpdir(), "rune-quota-meter-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const meter = (primary?: number, secondary?: number) => ({
  capacity: {
    ...(primary === undefined ? {} : { primary: { usedPercent: primary } }),
    ...(secondary === undefined ? {} : { secondary: { usedPercent: secondary } }),
  },
});

/** A profile whose rune.db holds these cost payloads, as the engine writes them. */
function profileWith(name: string, payloads: Array<Record<string, unknown>>): string {
  const profile = join(scratch, name);
  mkdirSync(profile, { recursive: true });
  const db = new Database(join(profile, "rune.db"));
  db.run("CREATE TABLE events (payload_json TEXT)");
  for (const payload of payloads)
    db.run("INSERT INTO events (payload_json) VALUES (?)", [
      JSON.stringify({ type: "cost", payload }),
    ]);
  db.close();
  return profile;
}

const cost = (extra: Record<string, unknown> = {}) => ({
  provider: "codex",
  model: "gpt-6-sol",
  priced: true,
  listCostUsd: 0.01,
  estimated: false,
  ...extra,
});

const capture = (lines: unknown[]): ArmCapture => ({
  stdout: [
    ...lines.map((line) => JSON.stringify(line)),
    JSON.stringify({ ok: true, text: "done" }),
  ].join("\n"),
  stderr: "",
  exitCode: 0,
  durationMs: 1,
});

describe("the fullest window", () => {
  test("the weekly window gates when it is the fuller one", () => {
    expect(fullestWindowPct(meter(40, 91))).toBe(91);
    expect(fullestWindowPct(meter(62, 10))).toBe(62);
  });

  test("one window alone is read; no meter, or no numbers, is nothing", () => {
    expect(fullestWindowPct(meter(55))).toBe(55);
    expect(fullestWindowPct(meter(undefined, 20))).toBe(20);
    expect(fullestWindowPct({})).toBeUndefined();
    expect(fullestWindowPct({ capacity: { primary: { usedPercent: "90" } } })).toBeUndefined();
    expect(fullestWindowPct(null)).toBeUndefined();
  });
});

describe("the ledger (rune.db cost rows)", () => {
  test("quotaPct is the highest reading of the run, over both windows", () => {
    const profile = profileWith("rising", [
      cost(meter(40, 70)),
      cost(meter(55, 10)),
      cost(), // a row from before the meter, or from a provider without one
    ]);
    expect(runeCost(profile).quotaPct).toBe(70);
  });

  test("the highest, not the last: a later, lower row does not lower it", () => {
    const profile = profileWith("reset-mid-run", [cost(meter(88)), cost(meter(3))]);
    expect(runeCost(profile).quotaPct).toBe(88);
  });

  test("no row carried a meter: no quotaPct at all, and the rest is unchanged", () => {
    const ledger = runeCost(profileWith("unmetered", [cost(), cost()]));
    expect("quotaPct" in ledger).toBe(false);
    expect(ledger.entries).toBe(2);
    expect(ledger.listUsd).toBeCloseTo(0.02);
  });
});

describe("the Rune row", () => {
  test("the ledger's reading reaches the row when the stream carried none", () => {
    const parsed = parseRuneOutput(capture([{ type: "usage" }]), {
      ...EMPTY_LEDGER,
      entries: 1,
      quotaPct: 70,
    });
    expect(parsed.quotaPct).toBe(70);
  });

  test("a meter on a stream event is read, and the fuller of stream and ledger wins", () => {
    const streamed = capture([{ type: "usage", payload: meter(81, 12) }]);
    expect(parseRuneOutput(streamed, { ...EMPTY_LEDGER, quotaPct: 70 }).quotaPct).toBe(81);
    expect(parseRuneOutput(streamed, { ...EMPTY_LEDGER, quotaPct: 95 }).quotaPct).toBe(95);
  });

  test("no meter anywhere stays null, so the gate still knows it is blind", () => {
    expect(parseRuneOutput(capture([{ type: "usage" }]), EMPTY_LEDGER).quotaPct).toBeNull();
  });
});
