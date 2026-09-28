/**
 * The Parity Index report: inputs validated and hashed, pairs formed, one Rune
 * build per mode, product mode as the gate, and a CLI that never overwrites.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ParityInputError,
  consistencyProblems,
  loadResults,
  pairRows,
  validateRow,
} from "../../eval/parity/aggregate";
import { DEFAULT_SEED } from "../../eval/parity/bootstrap";
import {
  REPORT_JSON,
  REPORT_MD,
  buildReport,
  main,
  parseArgs,
  renderMarkdown,
  type ParityReport,
} from "../../eval/parity/report";
import {
  GOLDEN,
  GOLDEN_HARNESS_E,
  RUNE_SHA,
  RUNE_SHA_2,
  goldenFile,
  mixedRuneFile,
  row,
  toJsonl,
} from "../../fixtures/parity/rows";

const FIXTURES = join(import.meta.dir, "../../fixtures/parity");
const GOLDEN_FILE = join(FIXTURES, "golden.jsonl");
const MIXED_FILE = join(FIXTURES, "mixed-rune.jsonl");
const INVALID_FILE = join(FIXTURES, "invalid.jsonl");

const scratch = mkdtempSync(join(tmpdir(), "parity-report-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const B = 400;
const NOW = new Date("2026-09-28T12:00:00.000Z");

const quiet = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (s: string) => out.push(s), error: (s: string) => err.push(s) }, out, err };
};

describe("the checked-in fixtures are what rows.ts builds", () => {
  test("golden.jsonl and mixed-rune.jsonl", () => {
    expect(readFileSync(GOLDEN_FILE, "utf8")).toBe(toJsonl(goldenFile()));
    expect(readFileSync(MIXED_FILE, "utf8")).toBe(toJsonl(mixedRuneFile()));
  });
});

describe("reading results", () => {
  test("every row is validated against the contract, and every bad line named", () => {
    let error: unknown;
    try {
      loadResults([INVALID_FILE]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ParityInputError);
    const problems = (error as ParityInputError).problems;
    const at = (line: number, text: string) =>
      problems.some((p) => p.startsWith(`${INVALID_FILE}:${line}: `) && p.includes(text));
    expect(at(1, 'schema is "parity-run/0"')).toBe(true);
    expect(at(2, "not JSON")).toBe(true);
    expect(at(4, "version missing")).toBe(true);
    expect(at(4, "hiddenPassed exceeds")).toBe(true);
    expect(at(5, "unscoredReason")).toBe(true);
    expect(at(5, "scope must be 0, 0.5 or 1")).toBe(true);
    expect(problems.some((p) => p.startsWith(`${INVALID_FILE}:3:`))).toBe(false);
  });

  test("a valid row has no problems; a scored row may not carry an unscoredReason", () => {
    expect(validateRow(row({ task: "a", run: 1, arm: "rune" }))).toEqual([]);
    const r = { ...row({ task: "a", run: 1, arm: "rune" }), unscoredReason: "provider_auth" };
    expect(validateRow(r)).toContain("a scored row carries an unscoredReason");
  });

  test("inputs are hashed from their bytes", () => {
    const { inputs, rows } = loadResults([GOLDEN_FILE]);
    const bytes = readFileSync(GOLDEN_FILE);
    expect(inputs).toEqual([
      {
        path: GOLDEN_FILE,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        rows: goldenFile().length,
      },
    ]);
    expect(rows.length).toBe(goldenFile().length);
  });

  test("two rows for one (mode, arm, task, run), or a task under two families, are refused", () => {
    const dup = [row({ task: "a", run: 1, arm: "rune" }), row({ task: "a", run: 1, arm: "rune" })];
    expect(consistencyProblems(dup)[0]).toMatch(/2 rows for rune on a run 1 \(product\)/);
    const split = [
      row({ task: "a", run: 1, arm: "rune", family: "F1" }),
      row({ task: "a", run: 2, arm: "rune", family: "F2" }),
    ];
    expect(consistencyProblems(split)).toEqual(["task a is filed under F1 and F2"]);
    const path = join(scratch, "dup.jsonl");
    writeFileSync(path, toJsonl(dup));
    expect(() => loadResults([path])).toThrow(ParityInputError);
  });

  test("pairs are (task, run, mode) across Rune and the comparator; the rest is counted", () => {
    const p = pairRows(goldenFile(), "product", "claude-code");
    expect(p.pairs.length).toBe(11);
    expect(p.unpaired).toEqual({ rune: ["f#1"], comparator: [] });
    expect(p.otherArmRows).toBe(1);
    const o = pairRows(goldenFile(), "product", "opencode");
    expect(o.pairs.map((x) => `${x.task}#${x.run}`)).toEqual(["a#1"]);
    expect(o.pairs[0]!.comparator.arm).toBe("opencode");
  });
});

describe("the report", () => {
  const { inputs, rows } = loadResults([GOLDEN_FILE]);
  const report = buildReport({ rows, inputs, now: NOW, b: B });
  const f1 = report.modes.product.families[0]!;

  test("identifies itself and records what it was made from", () => {
    expect(report.kind).toBe("parity-report");
    expect(report.schema).toBe("parity-report/1");
    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(report.comparator).toBe("claude-code");
    expect(report.seed).toBe(DEFAULT_SEED);
    expect(report.inputs).toEqual(inputs);
    expect(report.bootstrap).toEqual({
      b: B,
      quantiles: [0.1, 0.9],
      stratifiedBy: "task",
      prng: "mulberry32",
    });
  });

  test("product F1 carries the golden numbers", () => {
    expect(f1.n).toBe(6);
    expect(f1.tasks).toEqual(["a", "b", "c"]);
    expect(f1.axes!.O).toBeCloseTo(GOLDEN.O, 9);
    expect(f1.axes!.E).toBeCloseTo(GOLDEN.E, 9);
    expect(f1.axes!.R).toBeCloseTo(GOLDEN.R, 9);
    expect(f1.axes!.S).toBe(100);
    expect(f1.uncapped!.S).toBeCloseTo(1.1, 9);
    expect(f1.PI).toBeCloseTo(GOLDEN.PI, 9);
    expect(f1.excluded).toEqual({
      unscoredPairs: 2,
      noHiddenChecks: 2,
      tooHardPairs: 1,
      tooHardTasks: ["e"],
    });
  });

  test("the headline is the weakest product family; the rest are unmeasured", () => {
    expect(report.headline).toEqual({ mode: "product", family: "F1", name: "fix", PI: f1.PI! });
    expect(report.modes.product.families.slice(1).every((f) => f.status === "UNMEASURED")).toBe(
      true,
    );
    // Unmeasured families hold the overall status at PROVISIONAL at best.
    expect(report.status).toBe(f1.status === "FAIL" ? "FAIL" : "PROVISIONAL");
    expect(report.reasons).toContain("F2 unmeasured");
  });

  test("an unpaired row is reported, not scored", () => {
    expect(report.modes.product.unpaired).toEqual({ rune: ["f#1"], comparator: [] });
    expect(report.reasons.some((r) => r.includes("1 Rune row(s)"))).toBe(true);
  });

  test("harness mode is scored separately, and the model gap is harness − product", () => {
    const h = report.modes.harness.families[0]!;
    expect(h.axes!.E).toBeCloseTo(GOLDEN_HARNESS_E, 9);
    expect(report.modelGap.F1).toBeCloseTo(25 * (2 ** (-3 / 28) - 2 ** (-1 / 8)), 9);
    expect(report.modelGap.F2).toBeNull();
  });

  test("versions seen per arm and mode", () => {
    expect(report.versions.product.rune).toEqual([
      { version: "1.3.1", binarySha256: RUNE_SHA, models: ["model-r"], rows: 12 },
    ]);
    expect(report.versions.product.opencode).toEqual([
      { version: "0.9.0", binarySha256: null, models: ["model-o"], rows: 1 },
    ]);
    expect(report.versions.harness.rune![0]!.models).toEqual(["model-h"]);
    expect(report.mixedVersions).toEqual([]);
  });

  test("the seed is the caller's, is recorded, and never moves the point", () => {
    const other = buildReport({ rows, inputs, now: NOW, b: B, seed: 7 });
    expect(other.seed).toBe(7);
    expect(other.modes.product.families[0]!.PI).toBe(f1.PI);
    // Same seed, same interval: the report can be re-derived from what it records.
    const again = buildReport({ rows, inputs, now: NOW, b: B });
    expect(again.modes.product.families[0]!.interval).toEqual(f1.interval);
  });

  test("the comparator can be OpenCode", () => {
    const oc = buildReport({ rows, inputs, now: NOW, b: B, comparator: "opencode" });
    expect(oc.comparator).toBe("opencode");
    expect(oc.modes.product.families[0]!.n).toBe(1);
    // Claude Code's eleven product rows are now the third arm.
    expect(oc.modes.product.otherArmRows).toBe(11);
  });

  test("the Markdown carries the same numbers", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("# Parity Index — Rune vs claude-code");
    expect(md).toContain(`**Status: ${report.status}**`);
    expect(md).toContain(
      `| F1 fix | 6 | 3 | 95.7 | 91.7 | 80.0 | 100.0 | 92.2 | ${f1.interval!.PI!.lo.toFixed(1)}–${f1.interval!.PI!.hi.toFixed(1)} | ${f1.status} |`,
    );
    expect(md).toContain("| F1 | 0.96× | 0.92× | 0.80× | 1.10× |");
    expect(md).toContain("## Harness mode — attribution only, never a gate");
    expect(md).toContain(`seed ${DEFAULT_SEED}`);
    expect(md).toContain(report.inputs[0]!.sha256);
  });
});

describe("one Rune build per mode", () => {
  const { inputs, rows } = loadResults([MIXED_FILE]);

  test("two Rune binaries in one mode are refused", () => {
    expect(() => buildReport({ rows, inputs, b: B })).toThrow(/product mode mixes 2 Rune binaries/);
  });

  test("two Rune --version strings in one mode are refused too", () => {
    const vs = [
      row({ task: "a", run: 1, arm: "rune" }, { version: "1.3.0" }),
      row({ task: "a", run: 2, arm: "rune" }, { version: "1.3.1" }),
    ];
    expect(() => buildReport({ rows: vs, inputs: [], b: B })).toThrow(/mixes 2 Rune versions/);
  });

  test("--allow-mixed-versions reports across them, and says so", () => {
    const r = buildReport({ rows, inputs, b: B, allowMixedVersions: true });
    expect(r.mixedVersions.length).toBe(1);
    expect(r.reasons.some((x) => x.includes("allowed by --allow-mixed-versions"))).toBe(true);
    expect(r.versions.product.rune!.map((v) => v.binarySha256)).toEqual([RUNE_SHA, RUNE_SHA_2]);
  });

  test("the same binary in both modes is not mixing", () => {
    const both = [
      row({ task: "a", run: 1, arm: "rune" }),
      row({ task: "a", run: 1, arm: "rune", mode: "harness" }),
    ];
    expect(() => buildReport({ rows: both, inputs: [], b: B })).not.toThrow();
  });
});

describe("the CLI", () => {
  test("arguments", () => {
    expect(parseArgs(["--results", "a", "b", "--out", "o"])).toEqual({
      results: ["a", "b"],
      out: "o",
      comparator: "claude-code",
      seed: DEFAULT_SEED,
      allowMixedVersions: false,
    });
    expect(parseArgs(["--results", "a", "--out", "o", "--comparator", "codex"])).toHaveProperty(
      "error",
    );
    expect(parseArgs(["--results", "a", "--out", "o", "--seed", "-1"])).toHaveProperty("error");
    expect(parseArgs(["--out", "o"])).toHaveProperty("error");
  });

  test("writes the JSON and the Markdown, then refuses to overwrite either", () => {
    const out = join(scratch, "cli");
    const q = quiet();
    expect(main(["--results", GOLDEN_FILE, "--out", out, "--seed", "5"], q.io)).toBe(0);
    const json = JSON.parse(readFileSync(join(out, REPORT_JSON), "utf8")) as ParityReport;
    expect(json.kind).toBe("parity-report");
    expect(json.seed).toBe(5);
    expect(json.bootstrap.b).toBe(2000);
    expect(readFileSync(join(out, REPORT_MD), "utf8")).toContain("# Parity Index");
    const before = readFileSync(join(out, REPORT_JSON), "utf8");

    const again = quiet();
    expect(main(["--results", GOLDEN_FILE, "--out", out], again.io)).toBe(1);
    expect(again.err.join("\n")).toMatch(/refusing to overwrite/);
    expect(readFileSync(join(out, REPORT_JSON), "utf8")).toBe(before);
  });

  test("one existing output file is enough to write nothing", () => {
    const out = join(scratch, "half");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, REPORT_MD), "mine\n");
    expect(main(["--results", GOLDEN_FILE, "--out", out], quiet().io)).toBe(1);
    expect(existsSync(join(out, REPORT_JSON))).toBe(false);
    expect(readFileSync(join(out, REPORT_MD), "utf8")).toBe("mine\n");
  });

  test("refused inputs write nothing and exit 1", () => {
    const out = join(scratch, "refused");
    const q = quiet();
    expect(main(["--results", MIXED_FILE, "--out", out], q.io)).toBe(1);
    expect(q.err.join("\n")).toMatch(/mixes 2 Rune binaries/);
    expect(existsSync(join(out, REPORT_JSON))).toBe(false);
    expect(main(["--results", INVALID_FILE, "--out", out], quiet().io)).toBe(1);
    expect(main(["--out", out], quiet().io)).toBe(2);
  });

  test("runs as a script", () => {
    const out = join(scratch, "script");
    const script = join(import.meta.dir, "../../eval/parity/report.ts");
    const proc = Bun.spawnSync([process.execPath, script, "--results", GOLDEN_FILE, "--out", out], {
      env: process.env,
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toMatch(/^parity: (PASS|PROVISIONAL|FAIL)/);
    expect(existsSync(join(out, REPORT_JSON))).toBe(true);
  });
});
