#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CostTracker } from "../../../packages/llm-gateway/src/cost-tracker";
import { runProcess } from "./process";
import { runeCost, opencodeCost, prepareHarness } from "./harness";
import { COMPARISON_TASKS, type ComparisonTask } from "./tasks";

export type Arm = "rune" | "opencode";
export interface PilotOptions {
  out: string;
  model: string;
  runeProvider: string;
  opencodeProvider: string;
  budgetUsd: number;
  timeoutMs: number;
  runs: number;
  tasks?: string[];
  runeCommand: string[];
  opencodeCommand: string[];
  /** Read the tasks from a frozen corpus directory instead of COMPARISON_TASKS. */
  corpus?: string;
  /**
   * What this run's arms are pointed at. `live` demands the spend
   * authorisation; `scripted` declares arms that reach no provider. Left unset
   * the runner INFERS it from the commands (see `pilotSpendRoute`), so a caller
   * never has to remember a flag to be refused — only to be let through.
   */
  route?: SpendRoute;
}

export type SpendRoute = "live" | "scripted";

/**
 * The frozen corpus as live comparison tasks.
 *
 * Same fixtures, same prompts, and the SAME acceptance files the offline
 * runner uses — each task's `acceptance.json` becomes the grader, so an offline
 * row and a live row are answering one question. The acceptance scripts are
 * copied beside the workspace at check time, exactly as the offline side does,
 * and the model never sees them.
 */
export function corpusTasks(dir: string): ComparisonTask[] {
  const root = resolve(dir);
  const ids = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8")) as string[];
  return ids.map((id) => {
    const taskDir = join(root, id);
    const meta = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")) as {
      prompt: string;
      files: string[];
      untracked?: string[];
      browser?: boolean;
    };
    const acceptance = JSON.parse(readFileSync(join(taskDir, "acceptance.json"), "utf8")) as Array<{
      id?: string;
      text: string;
      command?: string;
    }>;
    const read = (kind: string, path: string) => readFileSync(join(taskDir, kind, path), "utf8");
    return {
      id,
      prompt: meta.prompt,
      files: Object.fromEntries(meta.files.map((path) => [path, read("fixture", path)])),
      ...(meta.untracked
        ? { untracked: Object.fromEntries(meta.untracked.map((p) => [p, read("untracked", p)])) }
        : {}),
      ...(meta.browser ? { browser: true } : {}),
      // The grader copies the evaluator's own scripts in, then runs each
      // acceptance command in the workspace and fails on the first non-zero.
      checks: `cpSync(${JSON.stringify(join(taskDir, "checks"))}, join(root, ".rune-acceptance"), {recursive:true});
        for (const step of ${JSON.stringify(acceptance.map((c) => ({ id: c.id, command: c.command })))}) {
          const run = spawnSync(step.command, {cwd: root, shell: true, encoding: "utf8", timeout: 240000});
          assert.equal(run.status, 0, step.id + ": " + ((run.stdout ?? "") + (run.stderr ?? "")).trim().slice(-400));
        }`,
    };
  });
}

/** Only terminal provider errors affect scoring. Tool failures and prose that
 * discuss quotas are task evidence, not evidence of a provider outage. Return
 * a category rather than publishing provider error headers or response bodies. */
export function providerFailureReason(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return;
  const row = event as Record<string, unknown>;
  if (row.type !== "error") return;
  const error = row.error;
  const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const data =
    detail.data && typeof detail.data === "object" ? (detail.data as Record<string, unknown>) : {};
  const status = data.statusCode ?? detail.statusCode;
  const message = [
    typeof error === "string" ? error : "",
    row.message,
    detail.message,
    data.message,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (status === 429 || /quota exceeded|usage limit|rate.?limit|too many requests/i.test(message))
    return "provider_quota";
  if (status === 401 || /invalid api.?key|authentication failed|not authenticated/i.test(message))
    return "provider_authentication";
  if (typeof status === "number" && status >= 500) return "provider_unavailable";
  return undefined;
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const repo = resolve(import.meta.dir, "../../..");
function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
function sourceDigest(): string {
  const files = git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((path) => /^(?:packages|crates|skills)\//.test(path))
    .sort();
  const hash = createHash("sha256");
  for (const path of files) {
    const full = join(repo, path);
    if (existsSync(full) && lstatSync(full).isFile())
      hash.update(path + "\0").update(readFileSync(full));
  }
  return hash.digest("hex");
}
function write(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
export function seedTask(task: ComparisonTask, root: string): void {
  mkdirSync(root, { recursive: true });
  for (const [path, value] of Object.entries(task.files)) write(join(root, path), value);
  write(join(root, ".gitignore"), ".rune/\n.opencode/\nnode_modules/\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Benchmark",
    "-c",
    "user.email=benchmark@localhost",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--no-verify",
    "-qm",
    "fixture",
  ]);
  for (const [path, value] of Object.entries(task.untracked ?? {})) write(join(root, path), value);
}
export function checkTask(
  task: ComparisonTask,
  root: string,
  artifactDir: string,
): { passed: boolean; detail: string } {
  const grader = join(artifactDir, "acceptance.ts");
  write(
    grader,
    `import assert from "node:assert/strict"; import {join} from "node:path"; import {pathToFileURL} from "node:url";
    import {cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs"; import {tmpdir} from "node:os"; import {spawnSync} from "node:child_process";
    const root = ${JSON.stringify(root)};\n${task.checks}\nconsole.log("acceptance passed");`,
  );
  const result = spawnSync(process.execPath, [grader], {
    cwd: artifactDir,
    encoding: "utf8",
    timeout: task.browser ? 60_000 : 30_000,
  });
  const protectedSource = Object.entries(task.untracked ?? {}).every(
    ([path, value]) =>
      existsSync(join(root, path)) && readFileSync(join(root, path), "utf8") === value,
  );
  const detail = [
    result.stdout,
    result.stderr,
    !protectedSource ? "Protected working-tree API was modified" : "",
  ]
    .filter(Boolean)
    .join("\n");
  write(join(artifactDir, "acceptance.log"), detail);
  return { passed: result.status === 0 && protectedSource, detail: detail.slice(-1500) };
}
/**
 * The OpenCode arm's LIVE spend cap.
 *
 * Extracted from `runPilot`'s stdout callback so it can be compiled and tested
 * on its own. It could not be, before: the accounting sat in an inline closure
 * inside a `catch { return false; }`, in a workspace with no typecheck, so when
 * `CostTracker.record`'s signature changed the stale call throwing at runtime
 * read as "this line is not a step" — the ledger stayed at zero and the cap
 * could never fire. On a paid route that is an uncapped-spend path.
 *
 * `observe` never throws: a shape it does not recognise is not a step, and a
 * benchmark's stdout is not a contract.
 */
export function openCodeBudgetWatcher(
  model: string,
  budgetUsd: number,
): { observe(event: unknown): boolean; totalListCostUsd(): number } {
  const monitor = new CostTracker();
  return {
    observe(event: unknown): boolean {
      const row = event && typeof event === "object" ? (event as Record<string, any>) : null;
      if (row?.type !== "step_finish") return false;
      const t = row.part?.tokens;
      if (!t) return false;
      monitor.record(
        model,
        "openai",
        {
          inputTokens: t.input ?? 0,
          outputTokens: (t.output ?? 0) + (t.reasoning ?? 0),
          cacheReadTokens: t.cache?.read ?? 0,
          cacheCreationTokens: t.cache?.write ?? 0,
        },
        // Every OpenCode step is the competitor's own turn as far as this side
        // can tell — the same reading `opencodeCost` takes of its database.
        // Stated rather than inherited (P3B I1).
        { role: "primary" },
      );
      return monitor.getLedger().totalListCostUsd >= budgetUsd;
    },
    totalListCostUsd: () => monitor.getLedger().totalListCostUsd,
  };
}

/**
 * The LIVE spend authorisation.
 *
 * A live arm costs real money on the founder's account, and the corpus's whole
 * point is that its offline half costs nothing — which makes it exactly the
 * kind of runner somebody points at a live route "just to see". So the live
 * pilot refuses to start unless `RUNE_EVAL_BUDGET_USD` names a positive number
 * of dollars that somebody decided to spend. `--budget-usd` is a PER-TASK
 * ceiling the runner enforces on the way; this is the authorisation for the
 * run existing at all, and an unset variable is a no, not a default.
 *
 * Returns the authorised ceiling; throws with the reason otherwise.
 */
export function authorisedBudgetUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RUNE_EVAL_BUDGET_USD;
  if (raw === undefined || raw.trim() === "")
    throw new Error(
      "Live evaluation spends real money and is not authorised here. Set RUNE_EVAL_BUDGET_USD " +
        "to the number of dollars you have decided to spend on this run. The offline corpus " +
        "(tests/eval/corpus/run-offline.ts) needs no budget and makes no model calls.",
    );
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`RUNE_EVAL_BUDGET_USD must be a positive number of dollars, not ${raw}.`);
  return value;
}

/**
 * The command shapes that can reach a provider.
 *
 * A pilot run is two spawns. Money is spent by a spawn of a REAL harness — the
 * rune CLI, or `opencode` — against real credentials; a spawn of a fixture
 * script that writes a sqlite row and exits cannot spend, whatever the
 * environment says. The pattern matches the argv the `--real` block below
 * builds (`bun …/bin/rune-cli.ts`, `--rune-bin …/rune`, `opencode`), on any
 * token of the command, so the recogniser sees the harness whether it is
 * argv0 or the script argv1.
 */
const LIVE_HARNESS_COMMAND = /(^|[/\\])(rune|rune-cli\.ts|rune-cli|opencode)$/;

/**
 * Can this run spend?
 *
 * The refusal has to sit in front of the runs that CAN spend and nowhere else:
 * a guard that also refuses a scripted, zero-dollar run is not a safety
 * property, it is a red unit gate (V6 finding 6), and a red gate is the thing
 * that gets guards deleted. Declared `route` wins; otherwise a run is live iff
 * one of its arm commands names a real harness.
 */
export function pilotSpendRoute(
  options: Pick<PilotOptions, "runeCommand" | "opencodeCommand" | "route">,
): SpendRoute {
  if (options.route) return options.route;
  const live = [...(options.runeCommand ?? []), ...(options.opencodeCommand ?? [])].some((token) =>
    LIVE_HARNESS_COMMAND.test(token),
  );
  return live ? "live" : "scripted";
}

export async function runPilot(options: PilotOptions) {
  // `authorisedBudgetUsd` is the authorisation for spending; this is the prior
  // question of whether spending is even possible. A scripted route asks
  // neither, and its `--budget-usd` is then only the per-task ceiling below.
  const authorised = pilotSpendRoute(options) === "live" ? authorisedBudgetUsd() : null;
  const catalogue = options.corpus ? corpusTasks(options.corpus) : COMPARISON_TASKS;
  const tasks = catalogue.filter((task) => !options.tasks || options.tasks.includes(task.id));
  if (authorised !== null && options.budgetUsd > authorised)
    throw new Error(
      `--budget-usd ${options.budgetUsd} is above the authorised RUNE_EVAL_BUDGET_USD ${authorised}.`,
    );
  if (
    !tasks.length ||
    options.runs < 1 ||
    !Number.isInteger(options.runs) ||
    options.budgetUsd <= 0 ||
    !Number.isFinite(options.budgetUsd) ||
    options.timeoutMs <= 0
  )
    throw new Error("Choose existing tasks, positive runs, budget and timeout.");
  if (existsSync(join(options.out, "report.json")))
    throw new Error(
      "Report already exists. Use a fresh output directory so evidence is never overwritten.",
    );
  mkdirSync(options.out, { recursive: true });
  if (tasks.some((task) => task.browser)) {
    const modulePath = process.env.RUNE_BENCH_PLAYWRIGHT;
    if (!modulePath)
      throw new Error(
        "Frontend evaluation requires RUNE_BENCH_PLAYWRIGHT pointing to an installed Playwright module.",
      );
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        `const {chromium}=await import(${JSON.stringify(modulePath)}); const browser=await chromium.launch({headless:true}); await browser.close();`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (probe.status !== 0)
      throw new Error("Browser preflight failed before inference: " + probe.stderr.slice(-500));
  }
  const report = {
    schema: 1,
    kind: "local-live-pilot",
    startedAt: new Date().toISOString(),
    limits: { perTaskListUsd: options.budgetUsd, timeoutMs: options.timeoutMs, runs: options.runs },
    model: options.model,
    providers: { rune: options.runeProvider, opencode: options.opencodeProvider },
    provenance: {
      runeSha: git(repo, ["rev-parse", "HEAD"]).trim(),
      dirtyPatchSha256: sha(git(repo, ["diff", "HEAD", "--binary"])),
      taskDigest: sha(JSON.stringify(tasks)),
      runeExecutableSha256:
        options.runeCommand.length === 1 && existsSync(options.runeCommand[0]!)
          ? sha(readFileSync(options.runeCommand[0]!))
          : null,
      runeCommand: options.runeCommand,
      opencodeCommand: options.opencodeCommand,
      versions: Object.fromEntries(
        (["rune", "opencode"] as const).map((arm) => [
          arm,
          spawnSync(
            (arm === "rune" ? options.runeCommand : options.opencodeCommand)[0]!,
            [
              ...(arm === "rune" ? options.runeCommand : options.opencodeCommand).slice(1),
              "--version",
            ],
            { encoding: "utf8" },
          ).stdout?.trim(),
        ]),
      ),
    },
    limitations: [
      "Small internally authored pilot; not SWE-bench or Terminal-Bench and not an overall capability score.",
      "Same selected primary model and high reasoning; each harness retains its own tools, orchestration, prompts and helper routing.",
      "Dollar figures use Rune's shared versioned pricing table, not subscription invoices. Unknown prices stay null.",
      "Rune reserves dollars before requests; OpenCode is stopped after a reported step crosses the common ceiling. Any overshoot is recorded and cannot count as an on-budget success.",
    ],
    results: [] as Array<Record<string, unknown>>,
  };
  const persist = () =>
    write(join(options.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  persist();
  tasksRun: for (let run = 0; run < options.runs; run++)
    for (const [index, task] of tasks.entries()) {
      // Alternate the first arm, including across repetitions.
      const arms: Arm[] = (run + index) % 2 ? ["opencode", "rune"] : ["rune", "opencode"];
      for (const arm of arms) {
        const dir = join(options.out, `${task.id}-${run + 1}-${arm}`),
          root = join(dir, "workspace"),
          profile = join(dir, "profile"),
          data = join(dir, "data");
        seedTask(task, root);
        mkdirSync(profile, { recursive: true });
        const prompt = `${task.prompt}${task.browser ? `\nPlaywright module path (also available if the shell filters environment variables): ${process.env.RUNE_BENCH_PLAYWRIGHT}.` : ""}\n\nWork autonomously in this fixture, make the changes and verify them. No deployment, external messages or unrelated files. This is a fresh task; do not inspect other runs or benchmark infrastructure.`;
        write(join(dir, "prompt.txt"), prompt);
        const { command, env } = prepareHarness(arm, options, dir, root, prompt);
        console.log(`${task.id} run ${run + 1}: ${arm}`);
        const budget = openCodeBudgetWatcher(options.model, options.budgetUsd);
        let providerFailure: string | undefined;
        const sourceBefore =
          options.runeCommand.length === 1 && existsSync(options.runeCommand[0]!)
            ? sha(readFileSync(options.runeCommand[0]!))
            : sourceDigest();
        const processResult = await runProcess({
          command,
          cwd: root,
          env,
          timeoutMs: options.timeoutMs,
          stdoutPath: join(dir, "events.jsonl"),
          stderrPath: join(dir, "stderr.log"),
          onLine(line) {
            // The `try` covers the PARSE and nothing else. It used to wrap the
            // accounting too, which is how a wrong-arity `record` call turned
            // this arm's live spend cap off without a word (V-L0 #2/#3).
            let event: unknown;
            try {
              event = JSON.parse(line);
            } catch {
              // Harnesses interleave plain log lines with their event stream.
              return false;
            }
            providerFailure = providerFailureReason(event) ?? providerFailure;
            if (arm !== "opencode") return false;
            return budget.observe(event);
          },
        });
        let cost: ReturnType<typeof runeCost>;
        let costError: string | undefined;
        try {
          cost = arm === "rune" ? runeCost(profile) : opencodeCost(data, options.model);
        } catch (error) {
          cost = { listUsd: null, models: [], entries: 0, estimated: false };
          costError = String(error);
        }
        const check = checkTask(task, root, dir);
        const sourceAfter =
          options.runeCommand.length === 1 && existsSync(options.runeCommand[0]!)
            ? sha(readFileSync(options.runeCommand[0]!))
            : sourceDigest();
        const sourceChanged = arm === "rune" && sourceBefore !== sourceAfter;
        const unscoredReason = sourceChanged
          ? "source_changed"
          : processResult.exitCode !== 0 && providerFailure
            ? providerFailure
            : cost.entries === 0
              ? "no_model_usage"
              : undefined;
        const infrastructure = unscoredReason !== undefined;
        const onBudget =
          cost.listUsd !== null && cost.listUsd <= options.budgetUsd && !processResult.stopped;
        git(root, ["add", "-N", "."]);
        report.results.push({
          sourceBefore,
          sourceChanged,
          task: task.id,
          run: run + 1,
          arm,
          ...processResult,
          ...cost,
          costError,
          scored: !infrastructure,
          unscoredReason,
          acceptancePassed: check.passed,
          onBudget,
          success: !infrastructure && check.passed && onBudget && processResult.exitCode === 0,
          evidence: dir,
          patchSha256: sha(git(root, ["diff", "--binary", "HEAD"])),
          completedAt: new Date().toISOString(),
        });
        persist();
        console.log(
          `${arm}: ${infrastructure ? `UNSCORED (${unscoredReason})` : check.passed ? "acceptance passed" : "acceptance failed"}; ${cost.listUsd === null ? "cost unknown" : `$${cost.listUsd.toFixed(4)} list`}; ${(processResult.durationMs / 1000).toFixed(1)}s`,
        );
        if (infrastructure) break tasksRun;
      }
    }
  return report;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (key: string) => {
    const at = args.indexOf(`--${key}`);
    return at < 0 ? undefined : args[at + 1];
  };
  if (!args.includes("--real")) {
    console.log(
      "Live comparison requires --real --model <id> --out <fresh-dir> [--tasks id,id] [--runs 1] [--budget-usd 2] [--timeout-seconds 300] [--corpus tests/eval/corpus]. Uses existing credentials; runs both harnesses on identical isolated fixtures.",
    );
    console.log(
      "It also requires RUNE_EVAL_BUDGET_USD: live evaluation spends real money and an unset variable is a refusal, not a default. The offline corpus needs no budget.",
    );
    console.log(COMPARISON_TASKS.map((task) => task.id).join("\n"));
  } else {
    const model = get("model"),
      out = get("out");
    if (!model || !out) throw new Error("--model and --out are required");
    await runPilot({
      // `--real` IS the live route; it never depends on the recogniser.
      route: "live",
      out: resolve(out),
      model,
      runeProvider: get("rune-provider") ?? "codex",
      opencodeProvider: get("opencode-provider") ?? "openai",
      budgetUsd: Number(get("budget-usd") ?? 2),
      timeoutMs: Number(get("timeout-seconds") ?? 300) * 1000,
      runs: Number(get("runs") ?? 1),
      tasks: get("tasks")?.split(","),
      ...(get("corpus") ? { corpus: get("corpus")! } : {}),
      runeCommand: get("rune-bin")
        ? [get("rune-bin")!]
        : [process.execPath, join(repo, "packages/orchestrator/src/bin/rune-cli.ts")],
      opencodeCommand: [get("opencode-bin") ?? "opencode"],
    });
  }
}
