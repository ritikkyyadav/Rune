// ─── The corpus's acceptance, attacked ───
//
// Promoted from tests/verification/v6-m5-acceptance-passes-wrong-solutions.ts
// and v6-m5-cache-plan-omission-is-shape-only.ts (V6 findings 8 and 20).
//
// The corpus reported `0 / 48` false completions and the record read it as
// "the acceptance oracle does the job it was built for". It was not: an
// adversarial pass wrote a wrong solution for three of the three families it
// attacked, and each one passed EVERY acceptance criterion of its task while
// breaking a requirement the prompt states in words —
//
//   csv-state-machine              trims unquoted fields and strips a BOM
//                                  anywhere ("Keep whitespace inside cells
//                                  exactly"; "an optional LEADING BOM").
//   health-endpoint-and-changelog  reports the wall clock as `uptimeMs`, and a
//                                  changelog that says "No routes were added or
//                                  changed" satisfied a /health/i grep.
//   dependent-migration            saves without a temporary file and reads
//                                  {version:99} as a v2 store ("Save
//                                  atomically…"; "invalid shape must throw").
//
// — while `cache-plan`'s omission arm was caught by its step COUNT, not by its
// omission: the same omission padded to three well-shaped steps passed.
//
// Those four solutions are now `variants/wrong-v6/` arms of the corpus, so they
// are in the false-completion denominator rather than in a footnote. This test
// is the pin that the hardened acceptance still catches them: it runs each
// task's own criteria over its own attack tree and requires at least one to
// fail. It lives in the unit gate because the corpus's sanity suite is not in
// one, and an acceptance that quietly softens is the whole finding again.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyTree,
  armsFor,
  loadAcceptance,
  loadScenario,
  loadTask,
  materialise,
} from "../../eval/corpus/corpus";

const ATTACKED = [
  "csv-state-machine",
  "health-endpoint-and-changelog",
  "dependent-migration",
  "cache-plan",
] as const;

for (const id of ATTACKED)
  test(`${id}: the wrong-v6 arm fails the acceptance it used to pass`, () => {
    const task = loadTask(id);
    // The arm is declared, so it is driven by the offline runner and counted.
    expect(armsFor(task)).toContain("wrong-v6");
    expect(loadScenario(task, "wrong-v6").note.length).toBeGreaterThan(10);

    const root = mkdtempSync(join(tmpdir(), `corpus-attack-${id}-`));
    try {
      materialise(task, root);
      const written = applyTree(task, root, "variants/wrong-v6");
      expect(written.length).toBeGreaterThan(0);
      const failed = loadAcceptance(task).filter(
        (criterion) =>
          spawnSync("bash", ["-lc", criterion.command!], { cwd: root, encoding: "utf8" }).status !==
          0,
      );
      expect(failed.map((criterion) => criterion.id)).not.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("cache-plan's content criterion reads content, not shape", () => {
  // The padded plan is three well-shaped numbered steps, each naming a file and
  // a check, with the same omission the `omission` arm declares. `c1` cannot
  // see it; `c2` is the criterion that names it.
  const task = loadTask("cache-plan");
  const root = mkdtempSync(join(tmpdir(), "corpus-cache-plan-"));
  try {
    materialise(task, root);
    applyTree(task, root, "variants/wrong-v6");
    const status = (command: string) =>
      spawnSync("bash", ["-lc", command], { cwd: root, encoding: "utf8" }).status;
    const criteria = loadAcceptance(task);
    expect(status(criteria.find((c) => c.id === "c1")!.command!)).toBe(0);
    expect(status(criteria.find((c) => c.id === "c2")!.command!)).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
