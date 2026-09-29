// ─── Which commits the serious-task miner considers ───
//
// tests/eval/serious/mine.ts defines a candidate as a commit that changes a
// package's src AND adds or changes a unit or integration test. It then skips
// three kinds without running them. These tests pin each rule on synthetic name
// lists, plus one check against this repo's own history: the three commits the
// method was first proven on by hand are candidates, and none of them is
// skipped.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import {
  isCandidate,
  listCandidates,
  MAX_SRC_FILES,
  parseLog,
  parseNameStatus,
  screen,
  toCandidate,
  type NameStatus,
} from "../../eval/serious/mine";
import { repoRootOf } from "../../eval/serious/source";

const commit = {
  sha: "a".repeat(40),
  parent: "b".repeat(40),
  date: "2026-09-27",
  subject: "fix: x",
};
const entries = (...rows: [string, string][]): NameStatus[] =>
  rows.map(([status, path]) => ({ status, path }));

describe("a commit's changes", () => {
  test("git's name-status lines are read, and nothing else is", () => {
    expect(parseNameStatus("M\tpackages/a/src/x.ts\n\nA\ttests/unit/a b.test.ts\nnoise\n")).toEqual(
      entries(["M", "packages/a/src/x.ts"], ["A", "tests/unit/a b.test.ts"]),
    );
  });

  test("one git log is split into commits, each with its own changes", () => {
    const log = [
      `\x1e${"1".repeat(40)}\x1f${"2".repeat(40)}\x1f2026-09-27T20:42:03+05:30\x1fconfig: a: b`,
      "",
      "M\tpackages/shared/src/config.ts",
      "A\ttests/unit/shared/config-toml.test.ts",
      `\x1e${"3".repeat(40)}\x1f\x1f2026-06-01T00:00:00+05:30\x1froot commit`,
      "",
      "A\tREADME.md",
      "",
    ].join("\n");
    expect(parseLog(log)).toEqual([
      {
        commit: {
          sha: "1".repeat(40),
          parent: "2".repeat(40),
          date: "2026-09-27T20:42:03+05:30",
          subject: "config: a: b",
        },
        changes: entries(
          ["M", "packages/shared/src/config.ts"],
          ["A", "tests/unit/shared/config-toml.test.ts"],
        ),
      },
    ]);
  });

  const c = toCandidate(
    commit,
    entries(
      ["M", "packages/orchestrator/src/engine.ts"],
      ["D", "packages/shared/src/old.ts"],
      ["M", "packages/shared/package.json"],
      ["M", "tests/unit/orchestrator/engine.test.ts"],
      ["A", "tests/integration/flow.test.ts"],
      ["D", "tests/unit/gone.test.ts"],
      ["A", "tests/helpers/rig.ts"],
      ["M", "tests/fixtures/data.json"],
      ["M", "tests/eval/corpus/x.test.ts"],
      ["M", "docs/missions.md"],
    ),
  );

  test("src files are packages/<pkg>/src/**, deleted ones included; the fix is all of packages/**", () => {
    expect(c.srcFiles).toEqual([
      "packages/orchestrator/src/engine.ts",
      "packages/shared/src/old.ts",
    ]);
    expect(c.fixFiles).toEqual([
      "packages/orchestrator/src/engine.ts",
      "packages/shared/src/old.ts",
      "packages/shared/package.json",
    ]);
    expect(c.packages).toEqual(["orchestrator", "shared"]);
  });

  test("hidden files are added or changed tests, helpers and fixtures; deleted ones and eval files are not", () => {
    expect(c.hiddenFiles).toEqual([
      "tests/unit/orchestrator/engine.test.ts",
      "tests/integration/flow.test.ts",
      "tests/helpers/rig.ts",
      "tests/fixtures/data.json",
    ]);
    expect(c.testFiles).toEqual([
      "tests/unit/orchestrator/engine.test.ts",
      "tests/integration/flow.test.ts",
    ]);
  });

  test("a candidate needs a src change and a unit or integration test file", () => {
    expect(isCandidate(c)).toBe(true);
    const noSrc = toCandidate(
      commit,
      entries(["M", "packages/a/package.json"], ["M", "tests/unit/a.test.ts"]),
    );
    expect(isCandidate(noSrc)).toBe(false);
    const onlyDeletedTest = toCandidate(
      commit,
      entries(["M", "packages/a/src/x.ts"], ["D", "tests/unit/a.test.ts"]),
    );
    expect(isCandidate(onlyDeletedTest)).toBe(false);
    const onlyHelper = toCandidate(
      commit,
      entries(["M", "packages/a/src/x.ts"], ["M", "tests/helpers/rig.ts"]),
    );
    expect(isCandidate(onlyHelper)).toBe(false);
  });
});

describe("candidates skipped without a run", () => {
  const base = entries(["M", "packages/a/src/x.ts"], ["M", "tests/unit/a.test.ts"]);

  test("a lockfile that differs from the parent's", () => {
    expect(screen(toCandidate(commit, [...base, { status: "M", path: "bun.lock" }]))).toBe(
      "lockfile-changed",
    );
    expect(
      screen(toCandidate(commit, [...base, { status: "M", path: "packages/a/bun.lock" }])),
    ).toBeNull();
  });

  test("more than six src files", () => {
    const src = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ status: "M", path: `packages/a/src/f${i}.ts` }));
    const at = (n: number) =>
      screen(toCandidate(commit, [...src(n), { status: "M", path: "tests/unit/a.test.ts" }]));
    expect(at(MAX_SRC_FILES)).toBeNull();
    expect(at(MAX_SRC_FILES + 1)).toBe("too-many-src-files");
  });

  test("release: and docs: commits", () => {
    for (const subject of [
      "release: Rune is 1.3.1",
      "docs: the pilot",
      "docs(program): x",
      "Release: y",
    ])
      expect(screen(toCandidate({ ...commit, subject }, base))).toBe("release-or-docs");
    for (const subject of ["fix: docs are read", "config: releases the lock", "missions: x"])
      expect(screen(toCandidate({ ...commit, subject }, base))).toBeNull();
  });
});

const repoRoot = repoRootOf();
const hasHistory =
  spawnSync("git", ["-C", repoRoot, "cat-file", "-e", "653698d^{commit}"]).status === 0;

describe("this repository's history", () => {
  test.skipIf(!hasHistory)(
    "the three hand-proven seeds are candidates, and none is skipped",
    () => {
      const listing = listCandidates(repoRoot);
      for (const seed of ["653698d", "88758b3", "a36ca74"])
        expect(listing.toValidate.some((c) => c.sha.startsWith(seed))).toBe(true);
      expect(listing.candidates.every(isCandidate)).toBe(true);
      expect(listing.toValidate.every((c) => screen(c) === null)).toBe(true);
    },
  );
});
