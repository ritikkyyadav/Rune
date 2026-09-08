#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadAnchor } from "../anchors";
import { prepareHarness, runeCost } from "./harness";
import { runProcess } from "./process";
import type { PilotOptions } from "./runner";

export interface SWEInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
}
export interface Prediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

export function loadInstances(path: string): SWEInstance[] {
  const seen = new Set<string>();
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as SWEInstance;
      if (
        !/^[\w.-]+__[\w.-]+-\d+$/.test(row.instance_id) ||
        !/^[\w.-]+\/[\w.-]+$/.test(row.repo) ||
        !/^[a-f0-9]{40}$/.test(row.base_commit) ||
        !row.problem_statement?.trim() ||
        seen.has(row.instance_id)
      ) {
        throw new Error(
          "Invalid or duplicate SWE-bench instance; export the official dataset unchanged as JSONL.",
        );
      }
      seen.add(row.instance_id);
      return row;
    });
}

/** Capture real tracked, deleted and newly created files without changing the
 * user's Git index. Agent prose is never treated as a patch. */
export function predictionFor(root: string, instance: SWEInstance, model: string): Prediction {
  git(root, ["cat-file", "-e", `${instance.base_commit}^{commit}`]);
  const scratch = mkdtempSync(join(tmpdir(), "rune-prediction-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    git(root, ["read-tree", instance.base_commit], env);
    git(root, ["add", "-A", "--", "."], env);
    return {
      instance_id: instance.instance_id,
      model_name_or_path: model,
      model_patch: git(root, ["diff", "--cached", "--binary", instance.base_commit, "--"], env),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function runSWE(
  options: PilotOptions & { dataset: string; repos: string; anchor?: string },
) {
  if (existsSync(options.out))
    throw new Error("Use a fresh output directory; predictions must not overwrite an earlier run.");
  if (!(options.budgetUsd > 0 && Number.isFinite(options.budgetUsd) && options.timeoutMs > 0))
    throw new Error("Positive budget and timeout required.");
  const ids = new Set(loadAnchor(options.anchor ?? "swe-bench-verified-50").task_ids);
  const all = loadInstances(options.dataset);
  const instances = all.filter((row) => ids.has(row.instance_id));
  if (instances.length !== ids.size)
    throw new Error(
      "Dataset is missing pinned instance IDs; do not silently substitute or shrink the anchor.",
    );
  // Repositories are pre-provisioned by the operator. No checkout, reset,
  // clone, dataset download or container lifecycle is hidden in this runner.
  for (const row of instances) {
    const root = join(options.repos, row.instance_id);
    if (
      git(root, ["rev-parse", "HEAD"]).trim() !== row.base_commit ||
      git(root, ["status", "--porcelain"]).trim()
    )
      throw new Error(
        `${row.instance_id}: provide a clean disposable checkout at ${row.base_commit}`,
      );
    const origin = git(root, ["config", "--get", "remote.origin.url"])
      .trim()
      .replace(/\.git$/, "");
    if (!origin.endsWith(`/${row.repo}`) && !origin.endsWith(`:${row.repo}`))
      throw new Error(`${row.instance_id}: repository origin mismatch`);
  }
  mkdirSync(options.out, { recursive: true });
  const predictions: Prediction[] = [],
    results: Array<Record<string, unknown>> = [];
  writeFileSync(
    join(options.out, "provenance.json"),
    JSON.stringify(
      {
        datasetSha256: sha(readFileSync(options.dataset, "utf8")),
        runeHead: git(resolve(import.meta.dir, "../../.."), ["rev-parse", "HEAD"]).trim(),
        arm: "pristine",
        command: options.runeCommand,
        model: options.model,
        provider: options.runeProvider,
        limits: { usd: options.budgetUsd, timeoutMs: options.timeoutMs },
        instanceIds: [...ids],
      },
      null,
      2,
    ),
  );
  for (const row of instances) {
    const dir = join(options.out, row.instance_id),
      root = join(options.repos, row.instance_id);
    mkdirSync(dir, { recursive: true });
    const prompt = `Resolve this repository issue. Keep the public API compatible. Do not change the existing tests or inspect external benchmark tests.\n\n${row.problem_statement}`;
    const { command, env } = prepareHarness("rune", options, dir, root, prompt);
    const processResult = await runProcess({
      command,
      env,
      cwd: root,
      timeoutMs: options.timeoutMs,
      stdoutPath: join(dir, "events.jsonl"),
      stderrPath: join(dir, "stderr.log"),
    });
    const cost = runeCost(join(dir, "profile"));
    // Export even a partial/empty patch. Official evaluation decides resolution;
    // an inference error is separately recorded, never a manufactured pass.
    const prediction = predictionFor(root, row, `rune/${options.runeProvider}/${options.model}`);
    predictions.push(prediction);
    results.push({
      instance_id: row.instance_id,
      ...processResult,
      ...cost,
      patchSha256: sha(prediction.model_patch),
      inferenceAvailable: cost.entries > 0,
      onBudget: cost.listUsd !== null && cost.listUsd <= options.budgetUsd,
    });
    writeFileSync(
      join(options.out, "predictions.jsonl"),
      predictions.map((p) => JSON.stringify(p)).join("\n") + "\n",
    );
    writeFileSync(join(options.out, "runs.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(
      `${row.instance_id}: patch exported, ${cost.entries} metered requests (not yet scored)`,
    );
    if (!cost.entries)
      throw new Error(
        "No provider usage. Stopping the anchor as infrastructure unavailable; completed evidence is preserved.",
      );
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2),
    get = (name: string) => {
      const at = argv.indexOf(`--${name}`);
      return at < 0 ? undefined : argv[at + 1];
    };
  if (!argv.includes("--real"))
    console.log(
      "SWE prediction generation: --real --dataset-jsonl <official-export> --repos-root <disposable-checkouts> --model <id> --out <fresh-dir> [--provider codex] [--budget-usd 2] [--timeout-seconds 600]. This runs the pinned pristine arm. Score predictions.jsonl with the official SWE-bench harness.",
    );
  else {
    for (const name of ["dataset-jsonl", "repos-root", "model", "out"])
      if (!get(name)) throw new Error(`--${name} required`);
    await runSWE({
      dataset: resolve(get("dataset-jsonl")!),
      repos: resolve(get("repos-root")!),
      out: resolve(get("out")!),
      model: get("model")!,
      runeProvider: get("provider") ?? "codex",
      opencodeProvider: "openai",
      runs: 1,
      budgetUsd: Number(get("budget-usd") ?? 2),
      timeoutMs: Number(get("timeout-seconds") ?? 600) * 1000,
      runeCommand: get("rune-bin")
        ? [get("rune-bin")!]
        : [
            process.execPath,
            resolve(import.meta.dir, "../../../packages/orchestrator/src/bin/rune-cli.ts"),
          ],
      opencodeCommand: [],
    });
  }
}
