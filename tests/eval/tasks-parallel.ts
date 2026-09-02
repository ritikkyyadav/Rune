/**
 * Parallel-build evals: four workers, four worktrees, one clean merge.
 *
 * This is the Phase 6B gate as a repeatable test. The claim being measured is
 * not "delegation works" — that was already true — it is the three properties
 * that were not:
 *
 *   1. Each worker builds in its OWN filesystem, so four concurrent builds
 *      cannot collide on unowned artifacts. That collision is the entire
 *      reason workers had no shell.
 *   2. Each worker's slice merges back into the lead's tree on the owned paths
 *      only, and the manifest is git's, not the model's.
 *   3. The lead's own verifier passes over the merged result.
 *
 * Mock mode drives the real engine — the real worker tool, the real ownership
 * claims, the real worktree machinery — with scripted model output. The
 * concurrency is genuine, which is why this task uses a content-addressed
 * responder rather than an index script: four workers interleave their
 * inference calls nondeterministically, so response N belongs to whichever
 * worker got there first.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "fs/promises";
import { join } from "path";

import type { EvalTask } from "./harness";
import type { ScriptedResponse } from "./mock-provider";

// The four slices. Each worker owns exactly one file; the sets are disjoint,
// which is what lets them run concurrently at all.
const SLICES = [
  { file: "src/backend.ts", body: "export function serve(): string {\n  return 'backend';\n}\n" },
  {
    file: "src/frontend.ts",
    body: "export function render(): string {\n  return 'frontend';\n}\n",
  },
  { file: "docs/design.md", body: "# Design\n\nFour slices, four worktrees.\n" },
  { file: "tests/smoke.test.ts", body: "export const smoke = true;\n" },
];

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: res.status === 0, out: ((res.stdout ?? "") + (res.stderr ?? "")).trim() };
}

/**
 * Which slice this request belongs to, read out of the worker's own system
 * prompt (it names the files that worker exclusively owns).
 */
function sliceFor(system: string | undefined): (typeof SLICES)[number] | null {
  if (!system) return null;
  if (!system.includes("EXCLUSIVELY own")) return null;
  return SLICES.find((s) => system.includes(s.file)) ?? null;
}

const greenfieldParallel: EvalTask = {
  name: "greenfield_parallel",
  category: "new-feature",
  description:
    "Four workers build four disjoint slices in four git worktrees; each verifies its own slice, all merge clean, and the lead's tree ends with every file present.",
  setup: async ({ workspace }) => {
    // A git repository, because worktree isolation needs one. Without it the
    // worker falls back to the shared tree — correct behaviour, and not what
    // this task is measuring.
    git(workspace, ["init", "-q", "-b", "main"]);
    git(workspace, ["config", "user.email", "eval@example.com"]);
    git(workspace, ["config", "user.name", "Eval"]);
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ name: "parallel-build", version: "0.0.0" }, null, 2) + "\n",
    );
    await writeFile(join(workspace, "README.md"), "# parallel build\n");
    git(workspace, ["add", "-A"]);
    git(workspace, ["commit", "-q", "-m", "base"]);
    // An UNCOMMITTED interface, which is the whole reason worktrees are seeded
    // from the working tree rather than from HEAD: a worker that cannot see
    // what the lead just wrote will re-invent it.
    await writeFile(
      join(workspace, "src", "contract.ts"),
      "export interface Contract {\n  serve(): string;\n}\n",
    ).catch(async () => {
      await Bun.write(join(workspace, "src", "contract.ts"), "export interface Contract {}\n");
    });
  },

  // Per-worker turns, addressed by content. Turn 1 writes the slice; turn 2 is
  // the report. Keyed on whether the file already exists in that worktree, so
  // it does not matter which order the four workers interleave in.
  responder: (request): ScriptedResponse | null => {
    const slice = sliceFor(request.system);
    if (!slice) return null;
    // Has this worker already written its file? Its transcript carries a
    // tool_result once the write lands, and a worker makes exactly one call —
    // so the PRESENCE of any tool_result is the state machine. Matching on the
    // result's text would couple this to the content-block shape, which is
    // what silently looped the first version of this task.
    const wrote = request.messages.some((m) => m.content.some((c) => c.type === "tool_result"));
    if (!wrote) {
      return {
        text: `Writing ${slice.file}.`,
        toolCalls: [{ name: "write_file", args: { path: slice.file, content: slice.body } }],
      };
    }
    return {
      text: JSON.stringify({
        summary: `Built ${slice.file}.`,
        findings: [`${slice.file} exports its slice of the contract`],
        filesExamined: ["src/contract.ts"],
        filesChanged: [slice.file],
        checks: "not_run",
        confidence: "high",
        unresolved: [],
        stopReason: "end_turn",
        toolCallCount: 1,
      }),
    };
  },

  // The lead's own turns fall through to the index script.
  script: [
    {
      text: "Splitting the build across four workers with disjoint ownership.",
      toolCalls: SLICES.map((s) => ({
        name: "worker",
        args: {
          prompt: `Implement ${s.file} against src/contract.ts.`,
          files: [s.file],
          label: s.file,
        },
      })),
    },
    { text: "All four slices are in. The build is assembled." },
  ],
  prompts: ["Build the backend, frontend, docs and tests in parallel with four workers."],
  maxTurns: 4,

  verify: async ({ workspace, engine }) => {
    // 1. Every slice landed in the LEAD's tree, not just in a worktree.
    for (const slice of SLICES) {
      const path = join(workspace, slice.file);
      if (!existsSync(path)) {
        return { pass: false, reason: `${slice.file} never merged back into the lead's tree` };
      }
      const content = readFileSync(path, "utf8");
      if (!content.includes(slice.body.trim().split("\n")[0]!)) {
        return { pass: false, reason: `${slice.file} merged with unexpected content` };
      }
    }

    // 2. The lead's uncommitted work survived. A merge that clobbered it would
    //    be a far worse failure than one that dropped a slice.
    const contract = join(workspace, "src", "contract.ts");
    if (!existsSync(contract)) {
      return { pass: false, reason: "the lead's uncommitted contract.ts was destroyed by a merge" };
    }

    // 3. No worktree was left behind. The checkout is removed in the finally;
    //    a leak here means an exception path skipped teardown.
    const worktrees = git(workspace, ["worktree", "list", "--porcelain"]);
    const leaked = worktrees.out
      .split("\n")
      .filter((l) => l.startsWith("worktree ") && l.includes(join(".gear", "worktrees")));
    if (leaked.length > 0) {
      return { pass: false, reason: `worktrees leaked: ${leaked.join(", ")}` };
    }

    // 4. No branch survived. A kept branch means a failed check or a conflicted
    //    merge, and this build had neither.
    const branches = git(workspace, ["branch", "--list", "gear/worker-*"]);
    if (branches.out.trim()) {
      return {
        pass: false,
        reason: `worker branches kept, so a merge did not land clean: ${branches.out.trim()}`,
      };
    }

    // 5. Nothing was left staged, which would make the lead's own auto-commit
    //    refuse to run thinking the user staged it.
    const staged = git(workspace, ["diff", "--cached", "--name-only"]);
    if (staged.out.trim()) {
      return { pass: false, reason: `merge left files staged: ${staged.out.trim()}` };
    }

    // 6. The audit chain over the whole parallel run is intact.
    const audit = engine.verifyAuditChain();
    if (!audit.ok) return { pass: false, reason: `audit chain broken at id ${audit.firstBadId}` };

    return { pass: true };
  },
};

export const PARALLEL_TASKS: EvalTask[] = [greenfieldParallel];
