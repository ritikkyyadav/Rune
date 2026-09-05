/**
 * P7.5 — promotion, revert, and every refusal between a measurement and a
 * change to how the agent behaves.
 *
 * Everything here runs against a TEMPORARY RUNE_HOME. A test that writes the
 * developer's real `~/.rune/config.toml` would be the same class of mistake the
 * whole phase is about: a machine changing its own configuration without a
 * human deciding.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configHash } from "../../../packages/orchestrator/src/evolve/config-hash";
import {
  activePromotions,
  appendLedger,
  haltState,
  readLedger,
  type LedgerEntry,
} from "../../../packages/orchestrator/src/evolve/ledger";
import {
  promote,
  renderConfigBlock,
  resume,
  revert,
  spliceConfigBlock,
} from "../../../packages/orchestrator/src/evolve/promote";
import { variantConfig } from "../../../packages/orchestrator/src/evolve/variants";

let home: string;

const YARD = { yardstick: "aaaa11112222", blessedYardstick: "aaaa11112222" };

/** A passing A/B for `variant` at its current configuration. */
function seedWin(
  variant: "doctrine_full" | "effort_ceiling" | "notebook_on",
  at = "2026-01-01T00:00:00.000Z",
) {
  const entry: LedgerEntry = {
    v: 1,
    at,
    kind: "measurement",
    subject: variant,
    controlConfigHash: configHash({}),
    treatmentConfigHash: configHash(variantConfig(variant)),
    yardstick: YARD.yardstick,
    mode: "real",
    win: true,
    rateDelta: 0.12,
    costDelta: 0.02,
    compared: 44,
    fixes: ["a"],
    regressions: [],
    refusals: [],
  };
  appendLedger(entry, home);
  return entry;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rune-evolve-home-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("promote refuses without evidence about THIS change", () => {
  it("refuses when the variant was never measured", () => {
    const r = promote("doctrine_full", { home, ...YARD });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("no passing A/B in the ledger");
  });

  it("refuses when the last measurement lost", () => {
    appendLedger(
      {
        v: 1,
        at: "2026-01-01T00:00:00.000Z",
        kind: "measurement",
        subject: "doctrine_full",
        controlConfigHash: configHash({}),
        treatmentConfigHash: configHash(variantConfig("doctrine_full")),
        win: false,
        refusals: ["equal is not a win"],
      },
      home,
    );
    expect(promote("doctrine_full", { home, ...YARD }).ok).toBe(false);
  });

  it("refuses a win recorded against a DIFFERENT configuration", () => {
    // The hash pair is the whole guard: a measurement taken before someone
    // widened the variant is evidence about a different change.
    appendLedger(
      {
        v: 1,
        at: "2026-01-01T00:00:00.000Z",
        kind: "measurement",
        subject: "doctrine_full",
        controlConfigHash: configHash({}),
        treatmentConfigHash: "stalehash1234",
        win: true,
      },
      home,
    );
    const r = promote("doctrine_full", { home, ...YARD });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("this exact configuration");
  });

  it("refuses an id that is not a declared variant", () => {
    const r = promote("sandbox_off", { home, ...YARD });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("not a declared variant");
  });
});

describe("promote refuses when the yardstick moved", () => {
  it("refuses when the eval suite differs from the blessed digest", () => {
    seedWin("doctrine_full");
    const r = promote("doctrine_full", {
      home,
      yardstick: "bbbb33334444",
      blessedYardstick: "aaaa11112222",
    });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("grading its own exam");
  });

  it("refuses when nothing has ever been blessed", () => {
    seedWin("doctrine_full");
    const r = promote("doctrine_full", {
      home,
      yardstick: "aaaa11112222",
      blessedYardstick: null,
    });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("never been blessed");
  });
});

describe("promote writes a fenced block and a ledger row", () => {
  it("writes the variant's lines and records the promotion", () => {
    seedWin("doctrine_full");
    const r = promote("doctrine_full", { home, ...YARD });
    expect(r.ok).toBe(true);
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml).toContain("rune:evolve:start");
    expect(toml).toContain('doctrineDelivery = "full"');
    expect(toml).toContain("rune:evolve:end");
    const rows = readLedger(home);
    expect(rows.filter((e) => e.kind === "promotion")).toHaveLength(1);
    expect(activePromotions(rows).map((e) => e.subject)).toEqual(["doctrine_full"]);
  });

  it("keeps everything a person wrote outside the markers", () => {
    writeFileSync(join(home, "config.toml"), '[llm]\nmodel = "mine"\n\n[ui]\ntheme = "paper"\n');
    seedWin("doctrine_full");
    expect(promote("doctrine_full", { home, ...YARD }).ok).toBe(true);
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml).toContain('model = "mine"');
    expect(toml).toContain('theme = "paper"');
    // The block goes LAST, because the config parser lets later keys win —
    // that is what makes a promotion an override rather than a hope.
    expect(toml.indexOf("rune:evolve:start")).toBeGreaterThan(toml.indexOf('theme = "paper"'));
  });

  it("refuses a second promotion inside the interval", () => {
    seedWin("doctrine_full");
    seedWin("effort_ceiling");
    expect(
      promote("doctrine_full", { home, ...YARD, now: new Date("2026-02-01T00:00:00Z") }).ok,
    ).toBe(true);
    const second = promote("effort_ceiling", {
      home,
      ...YARD,
      now: new Date("2026-02-01T06:00:00Z"),
    });
    expect(second.ok).toBe(false);
    expect(second.refusals.join(" ")).toContain("cannot be attributed");
  });

  it("allows the next promotion once the interval has passed", () => {
    seedWin("doctrine_full");
    seedWin("effort_ceiling");
    promote("doctrine_full", { home, ...YARD, now: new Date("2026-02-01T00:00:00Z") });
    const second = promote("effort_ceiling", {
      home,
      ...YARD,
      now: new Date("2026-02-03T00:00:00Z"),
    });
    expect(second.ok).toBe(true);
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml).toContain('doctrineDelivery = "full"');
    expect(toml).toContain('effortRouting = "off"');
  });

  it("refuses to promote what is already promoted", () => {
    seedWin("doctrine_full");
    promote("doctrine_full", { home, ...YARD, now: new Date("2026-02-01T00:00:00Z") });
    const again = promote("doctrine_full", {
      home,
      ...YARD,
      now: new Date("2026-02-05T00:00:00Z"),
    });
    expect(again.ok).toBe(false);
    expect(again.refusals.join(" ")).toContain("already promoted");
  });
});

describe("revert", () => {
  it("removes the block and records a row rather than deleting the history", () => {
    seedWin("doctrine_full");
    promote("doctrine_full", { home, ...YARD });
    const r = revert(1, { home });
    expect(r.ok).toBe(true);
    expect(r.reverted).toEqual(["doctrine_full"]);
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml).not.toContain("doctrineDelivery");
    const rows = readLedger(home);
    // The promotion row is STILL THERE. A ledger you can rewrite is a ledger
    // that can be made to say the change was justified.
    expect(rows.filter((e) => e.kind === "promotion")).toHaveLength(1);
    expect(rows.filter((e) => e.kind === "revert")).toHaveLength(1);
    expect(activePromotions(rows)).toHaveLength(0);
  });

  it("refuses when nothing is standing", () => {
    const r = revert(1, { home });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("nothing to revert");
  });

  it("halts the loop after two consecutive reverts, and a human clears it", () => {
    seedWin("doctrine_full");
    seedWin("effort_ceiling");
    promote("doctrine_full", { home, ...YARD, now: new Date("2026-02-01T00:00:00Z") });
    const first = revert(1, { home, now: new Date("2026-02-01T01:00:00Z") });
    expect(first.halted).toBe(false);

    promote("effort_ceiling", { home, ...YARD, now: new Date("2026-02-03T00:00:00Z") });
    const second = revert(1, { home, now: new Date("2026-02-03T01:00:00Z") });
    expect(second.halted).toBe(true);
    expect(second.haltReason).toContain("broken fitness function");

    // While halted, nothing may be promoted — even with fresh evidence.
    seedWin("notebook_on", "2026-02-04T00:00:00.000Z");
    const blocked = promote("notebook_on", {
      home,
      ...YARD,
      now: new Date("2026-02-05T00:00:00Z"),
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.refusals.join(" ")).toContain("the loop is halted");

    expect(resume({ home, now: new Date("2026-02-05T01:00:00Z") })).toBe(true);
    expect(haltState(readLedger(home)).halted).toBe(false);
    expect(
      promote("notebook_on", { home, ...YARD, now: new Date("2026-02-06T00:00:00Z") }).ok,
    ).toBe(true);
  });

  it("does not halt when a promotion in between was left standing", () => {
    // P1 reverted, P2 kept, P3 reverted is two reverts and not a streak: the
    // human agreed with something in between.
    seedWin("doctrine_full");
    seedWin("effort_ceiling");
    seedWin("notebook_on");
    promote("doctrine_full", { home, ...YARD, now: new Date("2026-02-01T00:00:00Z") });
    revert(1, { home, now: new Date("2026-02-01T01:00:00Z") });
    promote("effort_ceiling", { home, ...YARD, now: new Date("2026-02-03T00:00:00Z") });
    promote("notebook_on", { home, ...YARD, now: new Date("2026-02-05T00:00:00Z") });
    const r = revert(1, { home, now: new Date("2026-02-05T01:00:00Z") });
    expect(r.reverted).toEqual(["notebook_on"]);
    expect(r.halted).toBe(false);
  });
});

describe("the config block", () => {
  it("is empty when nothing is promoted, and the splice leaves the file clean", () => {
    expect(renderConfigBlock([])).toBe("");
    expect(spliceConfigBlock('[ui]\ntheme = "paper"\n', "")).toBe('[ui]\ntheme = "paper"\n');
  });

  it("replaces an existing block instead of stacking them", () => {
    const first = spliceConfigBlock("", renderConfigBlock([fakePromotion("doctrine_full")]));
    const second = spliceConfigBlock(first, renderConfigBlock([fakePromotion("effort_ceiling")]));
    expect(second.match(/rune:evolve:start/g)).toHaveLength(1);
  });

  it("replaces a block written under the previous name", () => {
    const first = spliceConfigBlock("", renderConfigBlock([fakePromotion("doctrine_full")]));
    const legacy = first.replaceAll("rune:evolve:", "gear:evolve:");
    const second = spliceConfigBlock(legacy, renderConfigBlock([fakePromotion("effort_ceiling")]));
    expect(second).not.toContain("gear:evolve:");
    expect(second.match(/rune:evolve:start/g)).toHaveLength(1);
    expect(second).not.toContain("doctrineDelivery");
    expect(second).toContain("effortRouting");
  });
});

function fakePromotion(subject: string): LedgerEntry {
  return {
    v: 1,
    at: "2026-01-01T00:00:00.000Z",
    kind: "promotion",
    subject,
    configLines:
      subject === "doctrine_full"
        ? ["[llm]", 'doctrineDelivery = "full"']
        : ["[llm]", 'effortRouting = "off"'],
  };
}
