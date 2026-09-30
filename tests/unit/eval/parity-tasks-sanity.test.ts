// ─── The parity supplement's sanity check ───
//
// tests/eval/parity-tasks holds tasks written in the frozen corpus's on-disk
// layout, so that the parity gate has three tasks in each of F2–F6 without the
// corpus changing (its protocol forbids adding a task without the scripted
// offline scenarios). An acceptance file nobody has seen pass is an assertion,
// not an oracle, so this suite holds the supplement to what the corpus's own
// sanity check holds the corpus to, through the two loaders that will read it:
//
//   · the layout — tasks.json is exactly the task directories, each task.json
//     names a family the gate maps, every file it lists exists, and nothing of
//     the acceptance reaches the prompt;
//   · runner.ts `corpusTasks` (the live comparison rig) and corpus-source's
//     `corpusParityTasks` (the parity index) both read it, given this
//     directory in place of the corpus's, with the families intended;
//   · each fixture seeds and commits cleanly, and a dirty-worktree task's
//     uncommitted work is still uncommitted when the arm starts;
//   · through corpus-source's own grader: every `solution/` scores quality 1,
//     every `variants/wrong/` scores below 1 by failing the criteria it was
//     written to fail, and the untouched fixture is not a solution.
//
// The frontend task needs a browser. Without `RUNE_BENCH_PLAYWRIGHT` its
// solution and wrong trees are SKIPPED, never counted as passing, and what is
// checked instead is the part that needs no browser: that each of its criteria
// comes back IMPOSSIBLE (the checks' own PLAYWRIGHT_UNAVAILABLE marker) rather
// than failed, so a missing Chromium can never be scored as a broken page.
//
// Zero model calls: nothing here constructs an Engine or spawns an arm.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { corpusTasks } from "../../eval/comparison/runner";
import { CORPUS_DIR, IMPOSSIBLE_MARKER, corpusParityTasks } from "../../eval/parity/corpus-source";
import { CORPUS_FAMILY, quality, type Family, type Outcome } from "../../eval/parity/types";
import { rmTemp } from "../../helpers/tmp";

const SUPPLEMENT = resolve(import.meta.dir, "../../eval/parity-tasks");

/**
 * The supplement, in its pinned order: each task's intended family, and the
 * criteria its wrong variant is written to fail. Pinning the failures, not just
 * "at least one", means an acceptance that quietly softens shows up here as a
 * changed list rather than as a still-green suite.
 */
const TASKS: Record<string, { family: Family; wrongFails: string[] }> = {
  "json-output-flag": { family: "F2", wrongFails: ["c3"] },
  "rename-quantity-field": { family: "F3", wrongFails: ["c2"] },
  // Its wrong variant differs from the solution only in the comparison table
  // (pinned below without a browser), so in one it fails the 390 layout alone.
  "pricing-page-mobile": { family: "F4", wrongFails: ["c2"] },
  "review-invoice-rules": { family: "F5", wrongFails: ["c1", "c3"] },
  "wip-due-dates": { family: "F6", wrongFails: ["c2", "c3"] },
  "finish-utils-split": { family: "F6", wrongFails: ["c4"] },
};
const IDS = Object.keys(TASKS);

const hasBrowser = Boolean(process.env.RUNE_BENCH_PLAYWRIGHT);

const scratch: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch.splice(0)) rmTemp(dir);
});

interface Meta {
  id: string;
  family: string;
  prompt: string;
  files: string[];
  untracked?: string[];
  browser?: boolean;
  constraints?: string[];
  notes?: string;
}
interface Criterion {
  id: string;
  text: string;
  command: string;
}

const readJson = <T>(...path: string[]): T =>
  JSON.parse(readFileSync(join(SUPPLEMENT, ...path), "utf8")) as T;
const meta = (id: string) => readJson<Meta>(id, "task.json");
const acceptance = (id: string) => readJson<Criterion[]>(id, "acceptance.json");

/** Every file under `root`, as sorted forward-slash paths relative to it. */
function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function git(root: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout;
}

const parity = corpusParityTasks(SUPPLEMENT);
const taskOf = (id: string) => {
  const task = parity.find((row) => row.id === id);
  if (!task) throw new Error(`the supplement has no task ${id}`);
  return task;
};

interface Graded {
  outcome: Outcome;
  /** What each criterion's check did, as corpus-source recorded it. */
  checks: Array<{ id: string; status: number; tail: string }>;
  workspace: string;
}

/** Seed a task through corpus-source, overlay one of its trees, and grade it there. */
async function grade(
  id: string,
  tree?: "solution" | "variants/wrong",
  edit?: (workspace: string) => void,
): Promise<Graded> {
  const task = taskOf(id);
  const dir = temp(`parity-supplement-${id}-`);
  const workspace = join(dir, "workspace");
  const evidence = join(dir, "evidence");
  await task.prepare(workspace);
  if (tree) cpSync(join(SUPPLEMENT, id, tree), workspace, { recursive: true });
  edit?.(workspace);
  const outcome = await task.grade(workspace, evidence);
  const checks = JSON.parse(readFileSync(join(evidence, "grade.json"), "utf8"));
  return { outcome, checks, workspace };
}

const failed = (graded: Graded) =>
  graded.checks.filter((check) => check.status === 1).map((check) => check.id);
const explain = (graded: Graded) =>
  graded.checks
    .filter((check) => check.status !== 0)
    .map((check) => `${check.id}: ${check.tail}`)
    .join("\n");

describe("the supplement is well-formed tasks in the corpus's layout", () => {
  test("tasks.json is exactly the task directories, in the pinned order", () => {
    const dirs = readdirSync(SUPPLEMENT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const listed = readJson<string[]>("tasks.json");
    expect([...listed].sort()).toEqual(dirs);
    expect(listed).toEqual(IDS);
  });

  test("each task.json parses, with a family the gate maps and files that exist", () => {
    for (const id of IDS) {
      const task = meta(id);
      expect(task.id).toBe(id);
      expect(CORPUS_FAMILY[task.family]).toBe(TASKS[id]!.family);
      expect(task.prompt.length).toBeGreaterThan(80);
      expect((task.notes ?? "").length).toBeGreaterThan(20);
      // The fixture and untracked trees hold exactly the files the task lists:
      // a stray file would be data no loader reads, a missing one a crash.
      expect(listFiles(join(SUPPLEMENT, id, "fixture"))).toEqual([...task.files].sort());
      expect(listFiles(join(SUPPLEMENT, id, "untracked"))).toEqual(
        [...(task.untracked ?? [])].sort(),
      );
      expect(listFiles(join(SUPPLEMENT, id, "solution")).length).toBeGreaterThan(0);
      expect(listFiles(join(SUPPLEMENT, id, "variants", "wrong")).length).toBeGreaterThan(0);
      expect(existsSync(join(SUPPLEMENT, id, "checks", "check.mjs"))).toBe(true);
      expect(existsSync(join(SUPPLEMENT, id, "checks", "browser.mjs"))).toBe(Boolean(task.browser));
    }
  });

  test("each criterion runs a named check, and none of it reaches the prompt", () => {
    for (const id of IDS) {
      const { prompt } = meta(id);
      const script = readFileSync(join(SUPPLEMENT, id, "checks", "check.mjs"), "utf8");
      const criteria = acceptance(id);
      expect(criteria.length).toBeGreaterThanOrEqual(3);
      expect(new Set(criteria.map((c) => c.id)).size).toBe(criteria.length);
      for (const criterion of criteria) {
        expect(criterion.text.length).toBeGreaterThan(10);
        const name = /^bun \.rune-acceptance\/check\.mjs (\w+)$/.exec(criterion.command)?.[1];
        expect({ id, command: criterion.command, name }).toEqual({
          id,
          command: criterion.command,
          name: expect.any(String),
        });
        expect(script).toMatch(new RegExp(`^  (?:async )?${name}\\(\\)`, "m"));
        // Hidden means hidden: the model is never told what is checked.
        expect(prompt).not.toContain(criterion.text);
      }
      expect(prompt).not.toMatch(/rune-acceptance|check\.mjs|acceptance/i);
    }
  });
});

describe("both loaders read the supplement", () => {
  test("runner.ts corpusTasks: every task, its bytes intact", () => {
    const comparison = corpusTasks(SUPPLEMENT);
    expect(comparison.map((task) => task.id)).toEqual(IDS);
    for (const task of comparison) {
      const { prompt, files, untracked, browser } = meta(task.id);
      expect(task.prompt).toBe(prompt);
      expect(Object.keys(task.files).sort()).toEqual([...files].sort());
      for (const [path, value] of Object.entries(task.files))
        expect(value).toBe(readFileSync(join(SUPPLEMENT, task.id, "fixture", path), "utf8"));
      expect(Object.keys(task.untracked ?? {}).sort()).toEqual([...(untracked ?? [])].sort());
      for (const [path, value] of Object.entries(task.untracked ?? {}))
        expect(value).toBe(readFileSync(join(SUPPLEMENT, task.id, "untracked", path), "utf8"));
      expect(Boolean(task.browser)).toBe(Boolean(browser));
      // The live rig's grader copies THIS task's checks, not the corpus's.
      expect(task.checks).toContain(JSON.stringify(join(SUPPLEMENT, task.id, "checks")));
    }
  });

  test("corpus-source corpusParityTasks: the families intended, and what no-code means", () => {
    expect(parity.map((task) => `${task.id}:${task.family}`)).toEqual(
      IDS.map((id) => `${id}:${TASKS[id]!.family}`),
    );
    for (const task of parity) {
      expect(task.size).toBe("small");
      expect(task.prompt.startsWith(meta(task.id).prompt)).toBe(true);
      expect(task.prompt).toContain("Work autonomously in this fixture");
      expect(task.criteria).toEqual(
        acceptance(task.id).map(({ id, text, command }) => ({ id, text, command })),
      );
    }
    expect(parity.filter((task) => task.browser).map((task) => task.id)).toEqual(
      IDS.filter((id) => meta(id).browser),
    );
    // No-code comes from the task's own constraint and the file it may create
    // from its own prompt: the review task, and only it, with REVIEW.md alone.
    expect(
      parity.filter((task) => task.noCode).map((task) => [task.id, task.expectedNewFiles]),
    ).toEqual([["review-invoice-rules", ["REVIEW.md"]]]);
    expect(parity.filter((task) => task.expectedNewFiles && !task.noCode)).toEqual([]);
    // The ids are the supplement's own: none shadows a corpus task.
    const corpusIds = new Set(corpusParityTasks(CORPUS_DIR).map((task) => task.id));
    expect(IDS.filter((id) => corpusIds.has(id))).toEqual([]);
  });

  test("with the frozen corpus, every family the two share has three tasks", () => {
    const count = (tasks: Array<{ family: Family }>) => {
      const counts: Partial<Record<Family, number>> = {};
      for (const task of tasks) counts[task.family] = (counts[task.family] ?? 0) + 1;
      return counts;
    };
    // The corpus as frozen, then the supplement's one F2–F5 and two F6.
    expect(count(corpusParityTasks(CORPUS_DIR))).toEqual({
      F1: 3,
      F2: 2,
      F3: 2,
      F4: 2,
      F5: 2,
      F6: 1,
    });
    expect(count(parity)).toEqual({ F2: 1, F3: 1, F4: 1, F5: 1, F6: 2 });
    expect(count([...corpusParityTasks(CORPUS_DIR), ...parity])).toEqual({
      F1: 3,
      F2: 3,
      F3: 3,
      F4: 3,
      F5: 3,
      F6: 3,
    });
  });
});

describe("each fixture seeds and commits cleanly", () => {
  for (const id of IDS)
    test(id, async () => {
      const task = meta(id);
      const workspace = join(temp(`parity-supplement-seed-${id}-`), "workspace");
      await taskOf(id).prepare(workspace);
      // One commit, holding exactly the fixture (and the rig's .gitignore).
      expect(git(workspace, "rev-list", "--count", "HEAD").trim()).toBe("1");
      expect(git(workspace, "ls-files").trim().split("\n").sort()).toEqual(
        [...task.files, ".gitignore"].sort(),
      );
      // The uncommitted work is uncommitted: a modified tracked file shows as
      // modified, a new one as untracked, and nothing else moved.
      const expected = (task.untracked ?? [])
        .map((path) => `${task.files.includes(path) ? " M" : "??"} ${path}`)
        .sort();
      const status = git(workspace, "status", "--porcelain", "--untracked-files=all");
      expect(status.split("\n").filter(Boolean).sort()).toEqual(expected);
      for (const path of task.untracked ?? [])
        expect(readFileSync(join(workspace, path), "utf8")).toBe(
          readFileSync(join(SUPPLEMENT, id, "untracked", path), "utf8"),
        );
    });
});

describe("graded by corpus-source: each solution passes, each wrong variant does not", () => {
  for (const id of IDS) {
    const browser = Boolean(meta(id).browser);
    const runner = browser && !hasBrowser ? test.skip : test;

    runner(
      `${id}: the solution scores quality 1${browser ? " [browser]" : ""}`,
      async () => {
        const graded = await grade(id, "solution");
        expect(explain(graded)).toBe("");
        expect(graded.outcome.impossible).toEqual([]);
        expect(quality(graded.outcome)).toBe(1);
      },
      240_000,
    );

    runner(
      `${id}: the wrong variant scores below 1, failing ${TASKS[id]!.wrongFails.join(", ")}${browser ? " [browser]" : ""}`,
      async () => {
        const graded = await grade(id, "variants/wrong");
        expect(failed(graded)).toEqual(TASKS[id]!.wrongFails);
        expect(graded.outcome.impossible).toEqual([]);
        expect(quality(graded.outcome)).toBeLessThan(1);
      },
      240_000,
    );

    if (!browser)
      test(`${id}: the untouched fixture is not a solution`, async () => {
        const graded = await grade(id);
        expect(quality(graded.outcome)).toBeLessThan(1);
      }, 240_000);
  }
});

/**
 * The review task's c1 and c2 read the review's CALLS, evaluated against the
 * code as given and against that code with one defect repaired, never its
 * words. Three reviews a keyword grader would pass, each pinned to the
 * criterion that has to catch it.
 */
describe("review-invoice-rules reads what a review shows, not what it says", () => {
  const id = "review-invoice-rules";
  const reviewing =
    (...lines: string[]) =>
    (workspace: string) =>
      writeFileSync(
        join(workspace, "REVIEW.md"),
        `# Review of invoice.ts\n\n${lines.join("\n\n")}\n`,
      );

  test("every function named, every rule quoted, and no call on which the code is wrong", async () => {
    const graded = await grade(
      id,
      undefined,
      reviewing(
        '`lineTotal({ description: "Pens", quantity: 2, unitCents: 150 })` returns 300, but a quantity below 1 must throw.',
        "`applyDiscount(1000, 10)` returns 900; the discount has to round half up, so it should return 900.",
        '`invoiceTotal([{ description: "Desk", quantity: 1, unitCents: 10000 }], 0, 800)` taxes before the discount; it should return 10800.',
      ),
    );
    expect(failed(graded)).toEqual(["c1", "c2"]);
  }, 240_000);

  test("the right calls with the wrong corrected results fail c2 alone", async () => {
    const graded = await grade(
      id,
      undefined,
      reviewing(
        '`lineTotal({ description: "Pens", quantity: 0, unitCents: 150 })` returns 0; it should return 150.',
        "`applyDiscount(1005, 10)` returns 905; the rules make it 906.",
        '`invoiceTotal([{ description: "Desk", quantity: 1, unitCents: 10000 }], 10, 800)` returns 9800 and should be 9000.',
      ),
    );
    expect(failed(graded)).toEqual(["c2"]);
  }, 240_000);

  test("the solution's review over a touched test file fails c3 alone", async () => {
    const graded = await grade(id, "solution", (workspace) =>
      appendFileSync(join(workspace, "invoice.test.ts"), "\n"),
    );
    expect(failed(graded)).toEqual(["c3"]);
  }, 240_000);
});

/**
 * The frontend task, without a browser.
 *
 * Chromium could not start where the supplement was written, so its solution
 * and wrong trees have not been graded in one: the tests above SKIP them until
 * `RUNE_BENCH_PLAYWRIGHT` names a runtime. What needs no browser is pinned here:
 * the plumbing is the corpus's proven helper; with no runtime every criterion is
 * IMPOSSIBLE (so the pair leaves the denominator) rather than failed; the page
 * holds what the checks look for and its script opens and closes the menu; and
 * the wrong variant is the solution with only the comparison table left at
 * desktop width, which is the argument that in a browser it fails c2 alone.
 */
describe("pricing-page-mobile, without a browser", () => {
  const id = "pricing-page-mobile";
  const dir = join(SUPPLEMENT, id);
  const page = (tree: string) => readFileSync(join(dir, tree, "index.html"), "utf8");

  test("its browser helper is the corpus's, byte for byte", () => {
    const helper = readFileSync(join(dir, "checks", "browser.mjs"), "utf8");
    for (const corpusTask of ["signup-form-states", "responsive-project-board"])
      expect(helper).toBe(
        readFileSync(join(CORPUS_DIR, corpusTask, "checks", "browser.mjs"), "utf8"),
      );
  });

  test.skipIf(hasBrowser)(
    "with no runtime, every criterion is impossible for every tree, never failed",
    async () => {
      for (const tree of [undefined, "solution", "variants/wrong"] as const) {
        const graded = await grade(id, tree);
        expect(graded.outcome).toEqual({
          hiddenPassed: 0,
          hiddenTotal: 0,
          regressionsIntroduced: 0,
          buildBroken: false,
          impossible: ["c1", "c2", "c3"],
        });
        expect(quality(graded.outcome)).toBeNull();
        for (const check of graded.checks) expect(check.tail).toContain(IMPOSSIBLE_MARKER);
      }
    },
    240_000,
  );

  test("an unknown criterion fails rather than passing", () => {
    const run = spawnSync(process.execPath, [join(dir, "checks", "check.mjs"), "nope"], {
      cwd: temp("parity-supplement-unknown-"),
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("acceptance failed: unknown criterion nope");
  });

  test("the solution's page holds what the checks look for, and the fixture's does not", () => {
    const solution = page("solution");
    expect([...solution.matchAll(/data-plan="(\w+)"/g)].map((match) => match[1])).toEqual([
      "starter",
      "team",
      "enterprise",
    ]);
    const button = /<button\b([^>]*)>\s*Menu\s*<\/button>/.exec(solution)?.[1] ?? "";
    expect(button).toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/.exec(button)?.[1] ?? "";
    // The element the button names exists, and holds the header's links.
    const panel = new RegExp(`<(\\w+)[^>]*\\bid="${controls}"[^>]*>([\\s\\S]*?)</\\1>`).exec(
      solution,
    );
    expect(panel?.[2] ?? "").toContain(">Docs</a>");
    expect(solution).toMatch(/@media \(max-width: 719px\)/);
    const fixture = page("fixture");
    expect(fixture).not.toContain("<button");
    expect(fixture).not.toContain("@media");
  });

  test("the solution's script opens and closes the menu, run against a stub DOM", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(page("solution"))?.[1] ?? "";
    const attributes = new Map([
      ["aria-expanded", "false"],
      ["aria-controls", "site-links"],
    ]);
    const classes = new Set<string>();
    let onClick: (() => void) | undefined;
    const button = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
      addEventListener: (type: string, handler: () => void) => {
        if (type === "click") onClick = handler;
      },
    };
    const links = {
      classList: {
        toggle: (name: string, on: boolean) => {
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        },
      },
    };
    const stubDocument = {
      querySelector: (selector: string) => (selector === ".menu-toggle" ? button : null),
      getElementById: (name: string) => (name === "site-links" ? links : null),
    };
    new Function("document", script)(stubDocument);
    expect(onClick).toBeDefined();
    onClick!();
    expect([attributes.get("aria-expanded"), classes.has("open")]).toEqual(["true", true]);
    onClick!();
    expect([attributes.get("aria-expanded"), classes.has("open")]).toEqual(["false", false]);
  });

  test("the wrong variant is the solution with the comparison table left at desktop width", () => {
    const solution = page("solution");
    const wrong = page("variants/wrong");
    const part = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? `(no ${pattern})`;
    // What c1 and c3 read is byte-identical: the header and its menu, the
    // script, the small-screen rules and the plan cards…
    for (const pattern of [
      /<header>[\s\S]*?<\/header>/,
      /<script>[\s\S]*?<\/script>/,
      /@media[\s\S]*?\n {6}\}\n/,
      /<section class="plans"[\s\S]*?<\/section>/,
    ])
      expect(part(wrong, pattern)).toBe(part(solution, pattern));
    // …and what c2 reads is not: a 1052px table with nothing to scroll it in.
    expect(wrong).toMatch(/\.compare table \{\s*width: 1052px;/);
    expect(wrong).not.toContain("overflow-x");
    expect(solution).toContain("overflow-x: auto");
  });
});
