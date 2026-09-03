/**
 * The two shipped workflows, executed.
 *
 * An example workflow that has never run is a JSON file with opinions in it.
 * These two are the shapes the feature exists for — a multi-dimension review
 * and a four-worker greenfield build — and this drives them through the real
 * `gear workflow` command, so a graph that no longer parses, a `{{token}}` that
 * names a node nobody declared, or a wave order that silently changed is a
 * failing test rather than something the founder finds.
 *
 * `--mock` is the honest way to do that: a real run needs an engine, a provider
 * and money, none of which exercises the part the executor is responsible for.
 *
 * The last test is the one that matters most. Resume is the property that makes
 * a workflow worth having — a kill lands between two nodes far more often than
 * between two waves — so the run is stopped at a node in the MIDDLE of a middle
 * wave and started again, and the assertion is that the completed prefix is not
 * paid for twice.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowState } from "../../packages/orchestrator/src/workflow";

const CLI = join(import.meta.dir, "../../packages/orchestrator/src/bin/gear-cli.ts");
const EXAMPLES = join(import.meta.dir, "../../examples/workflows");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspace of its own, so `.gear/workflows/` is never the repo's. */
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "gear-wf-ex-"));
  dirs.push(d);
  return d;
}

async function workflow(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", CLI, "workflow", ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", GEAR_HOME: join(cwd, "home") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

function stateOf(cwd: string, name: string): WorkflowState {
  const path = join(cwd, ".gear", "workflows", `${name}.state.json`);
  expect(existsSync(path), `${name} wrote its resume state`).toBe(true);
  return JSON.parse(readFileSync(path, "utf8")) as WorkflowState;
}

const REVIEW = join(EXAMPLES, "review.workflow.json");
const GREENFIELD = join(EXAMPLES, "greenfield.workflow.json");

describe("P10.9 — the shipped example workflows run", () => {
  test("review: reviewers per dimension, then verifiers, then the report", async () => {
    const cwd = workspace();
    const dry = await workflow(cwd, [REVIEW, "--dry-run"]);
    expect(dry.code).toBe(0);
    // The shape is the point of the example: one scoping pass, four scoped
    // reviewers who cannot see each other's findings, two verifiers that judge
    // those findings against the tree, and only then a report.
    expect(dry.out).toContain("wave 1  scope");
    expect(dry.out).toContain("wave 2  correctness · security · tests · docs");
    expect(dry.out).toContain("wave 3  verify · gaps");
    expect(dry.out).toContain("wave 4  report");

    const run = await workflow(cwd, [REVIEW, "--mock"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("8 completed · 0 failed · 0 skipped");

    const state = stateOf(cwd, "review");
    expect(Object.keys(state.results).sort()).toEqual([
      "correctness",
      "docs",
      "gaps",
      "report",
      "scope",
      "security",
      "tests",
      "verify",
    ]);
    expect(Object.values(state.results).every((r) => r.status === "completed")).toBe(true);
  }, 120_000);

  test("greenfield: four owned slices in worktrees, then integration", async () => {
    const cwd = workspace();
    const dry = await workflow(cwd, [GREENFIELD, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("wave 1  shape");
    expect(dry.out).toContain("wave 2  backend · frontend · tests · docs");
    expect(dry.out).toContain("wave 3  integrate");
    expect(dry.out).toContain("wave 4  seams");

    const run = await workflow(cwd, [GREENFIELD, "--mock"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("7 completed · 0 failed · 0 skipped");

    // Every slice is a WORKER with files it exclusively owns — ownership is
    // what makes a worker safe, and a greenfield build with four workers
    // sharing a tree is the failure mode the `files` requirement exists for.
    const definition = JSON.parse(readFileSync(GREENFIELD, "utf8")) as {
      nodes: Array<{ id: string; kind: string; files?: string[] }>;
    };
    const workers = definition.nodes.filter((n) => n.kind === "worker");
    expect(workers.map((w) => w.id)).toEqual(["backend", "frontend", "tests", "docs", "integrate"]);
    expect(workers.every((w) => (w.files ?? []).length > 0)).toBe(true);
  }, 120_000);

  test("a kill at a middle node resumes without paying for the prefix twice", async () => {
    const cwd = workspace();
    // `backend` is one of four nodes in wave 2 of 4 — a kill between two nodes
    // inside a wave, which is where a kill actually lands. `--max-parallel 1`
    // makes the stop deterministic instead of a race with its three siblings.
    const killed = await workflow(cwd, [
      GREENFIELD,
      "--mock",
      "--max-parallel",
      "1",
      "--stop-after",
      "backend",
    ]);
    expect(killed.code).toBe(0);
    expect(killed.out).toContain("stopped after backend");

    const partial = stateOf(cwd, "greenfield");
    // Exactly the prefix, and nothing after it: state is written after every
    // NODE, not after every wave, which is the whole value of resuming.
    expect(Object.keys(partial.results).sort()).toEqual(["backend", "shape"]);

    const resumed = await workflow(cwd, [GREENFIELD, "--mock"]);
    expect(resumed.code).toBe(0);
    // The prefix comes back from cache; only the tail runs.
    expect(resumed.out).toContain("↺ shape cached");
    expect(resumed.out).toContain("↺ backend cached");
    expect(resumed.out).toContain("✓ integrate completed");
    expect(resumed.out).toContain("7 completed · 0 failed · 0 skipped");

    const full = stateOf(cwd, "greenfield");
    expect(Object.keys(full.results)).toHaveLength(7);
    expect(full.results.shape!.cached).toBe(true);
    expect(full.results.backend!.cached).toBe(true);
    expect(full.results.integrate!.cached).toBe(false);
    // The resumed nodes kept the output the killed run produced — a resume that
    // re-ran them silently would look identical from the outside.
    expect(full.results.backend!.output).toBe(partial.results.backend!.output);
  }, 120_000);

  test("--fresh ignores the saved state and re-runs everything", async () => {
    const cwd = workspace();
    await workflow(cwd, [REVIEW, "--mock"]);
    const again = await workflow(cwd, [REVIEW, "--mock", "--fresh"]);
    expect(again.code).toBe(0);
    // Nothing is reported as cached: `--fresh` is the escape from a cache that
    // is wrong for a reason the hash cannot see.
    expect(again.out).not.toContain("cached");
    expect(again.out).toContain("8 completed · 0 failed · 0 skipped");
  }, 120_000);
});
