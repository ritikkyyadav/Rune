import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { Engine } from "@alan/orchestrator";
import type {
  PermissionDecision as BrokerDecision,
  UserPermissionDecision,
} from "@alan/orchestrator";

import { MockProvider, type Script } from "./mock-provider";

export interface EvalTask {
  name: string;
  description: string;
  category: "comprehension" | "fix-failing-test" | "multi-file-refactor" | "new-feature" | "tool-discipline" | "core";
  /** Required in mock mode; optional in real mode. */
  script?: Script;
  prompts: string[];
  /** Pre-populate the workspace before the agent runs. */
  setup?: (ctx: { workspace: string }) => Promise<void>;
  /** Customize permission handler responses for this task. Defaults to allow-once. */
  permissionResponses?: UserPermissionDecision[];
  /** Verify the outcome. Return { pass: false, reason } to fail. */
  verify: (ctx: {
    workspace: string;
    dbPath: string;
    engine: Engine;
    sessionId: string;
    /** Non-null only in mock mode (lets a verify introspect the scripted run). */
    mock: MockProvider | null;
    /** Concatenated assistant text the model produced across all turns. */
    finalText: string;
    /** True when driving a live model (mock === null). */
    real: boolean;
  }) => Promise<{ pass: boolean; reason?: string }>;
}

export interface TaskResult {
  name: string;
  category: string;
  pass: boolean;
  reason?: string;
  durationMs: number;
  cost: number;
  turns: number;
  model?: string;
  provider?: string;
  /**
   * True when the run was defeated by a provider rate/usage limit (429, quota,
   * "session usage limit") rather than a genuine capability miss. These are
   * EXCLUDED from the clean pass-rate so throttle noise can't masquerade as
   * failure — the exact contamination that poisoned the free-tier floor.
   */
  throttled?: boolean;
  /** Raw provider error messages captured from the stream (diagnostics). */
  errors?: string[];
  /** How many attempts ran (1 = no retry needed). */
  attempts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A provider error that means "slow down / out of quota", not "wrong answer". */
function isThrottleError(msg: string): boolean {
  return /rate.?limit|usage limit|429|throttl|quota|too many requests|no credits/i.test(msg);
}

/** Real-mode retry/pacing knobs (env-overridable). */
const MAX_ATTEMPTS = Math.max(1, Number(process.env.ALAN_EVAL_MAX_RETRIES ?? 3));
const RETRY_BASE_MS = Math.max(0, Number(process.env.ALAN_EVAL_RETRY_BASE_MS ?? 4000));
const TASK_DELAY_MS = Math.max(0, Number(process.env.ALAN_EVAL_TASK_DELAY_MS ?? 1500));

const TOOLS_BINARY =
  process.env.ALAN_TOOLS_BINARY ?? join(__dirname, "..", "..", "target", "release", "alan-tools");

/**
 * Legacy/default real-mode signal via env var. The runner now drives mode
 * explicitly through RunOptions.real, but we keep this export so callers that
 * only set the env var (e.g. the model-sweep path) still behave as before.
 */
const IS_REAL_MODE = process.env.ALAN_EVAL_REAL === "1";

export interface RunOptions {
  /** Drive a live model through the real engine/gateway instead of the mock. */
  real?: boolean;
  /** Provider for real mode (anthropic | openai | openrouter | google). */
  provider?: string;
  /** Model id for real mode. */
  model?: string;
}

export async function runTask(
  task: EvalTask,
  opts: RunOptions = {},
): Promise<TaskResult> {
  const real = opts.real ?? IS_REAL_MODE;

  // Mock mode needs a deterministic script; fail fast without spinning up.
  if (!real && !task.script) {
    return {
      name: task.name,
      category: task.category,
      pass: false,
      reason: "task.script is required in mock mode (use --real to drive a live model)",
      durationMs: 0,
      cost: 0,
      turns: 0,
      attempts: 0,
    };
  }

  // Retry loop: a run defeated purely by a provider rate/usage limit did no real
  // work, so re-run it (fresh workspace) after a backoff. Genuine pass/fail
  // returns immediately. Only --real runs retry — mock is deterministic.
  const maxAttempts = real ? MAX_ATTEMPTS : 1;
  let last: TaskResult | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await attemptTask(task, opts, real);
    result.attempts = attempt;
    last = result;
    if (!result.throttled) break; // genuine pass/fail — done
    if (attempt < maxAttempts) {
      // Exponential backoff; session/usage limits need real cool-down time.
      const wait = RETRY_BASE_MS * 2 ** (attempt - 1);
      await sleep(wait);
    }
  }
  return last!;
}

/** One full attempt at a task: fresh workspace, engine, chat, verify. */
async function attemptTask(
  task: EvalTask,
  opts: RunOptions,
  real: boolean,
): Promise<TaskResult> {
  const start = performance.now();
  const tmpRoot = await mkdtemp(join(tmpdir(), "alan-eval-"));
  const workspace = join(tmpRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const dbPath = join(tmpRoot, "alan.db");

  const provider =
    opts.provider ?? process.env.ALAN_EVAL_PROVIDER ?? process.env.ALAN_PROVIDER ?? "anthropic";
  const model =
    opts.model ?? process.env.ALAN_EVAL_MODEL ?? process.env.ALAN_MODEL ?? "mock-model";
  const errors: string[] = [];

  try {
    if (task.setup) {
      await task.setup({ workspace });
    }

    const engine = new Engine({
      model: real ? model : "mock-model",
      provider: real ? (provider as any) : "anthropic",
      workspaceRoot: workspace,
      dbPath,
      toolsBinaryPath: TOOLS_BINARY,
      yoloMode: false,
    });

    let mock: MockProvider | null = null;

    if (!real) {
      // Replace the real provider with the mock — reach inside via private access
      // since the engine doesn't expose this (eval-only override).
      mock = new MockProvider(task.script!);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gw: any = (engine as any).gateway;
      gw.providers.clear();
      gw.registerProvider(mock);
    }

    // Set up permission handler with scripted responses.
    // Real models are non-deterministic, so default to allow-once (a denial
    // would be a per-task invariant, never a blanket gate on the live run).
    let permIndex = 0;
    engine.setPermissionHandler(async () => {
      const responses = task.permissionResponses ?? [];
      const next = responses[permIndex++];
      return next ?? { kind: "allow_once" };
    });

    const sessionId = engine.createSession();
    let turns = 0;
    let finalText = "";

    for (const prompt of task.prompts) {
      // Drain the chat generator. Count one turn per agent round-trip
      // (turn_complete), accumulate streamed assistant text so verify() can
      // judge by content, and capture provider error events so a throttle
      // surfaces as the real reason instead of a misleading verify message.
      for await (const event of engine.chat(sessionId, prompt)) {
        const ev = event as any;
        if (ev.type === "turn_complete") turns++;
        if (ev.type === "text_delta" && typeof ev.text === "string") finalText += ev.text;
        if (ev.type === "error" && typeof ev.error === "string") errors.push(ev.error);
      }
    }

    const cost = engine.getCost();

    const verifyResult = await task.verify({
      workspace,
      dbPath,
      engine,
      sessionId,
      mock,
      finalText,
      real,
    });

    engine.close();

    // A run that produced no completed turn AND hit a throttle error is
    // throttle-contaminated, not a measured failure. Surface the real cause.
    const throttled =
      !verifyResult.pass && turns === 0 && errors.some(isThrottleError);
    const reason = throttled
      ? `rate-limited: ${errors.find(isThrottleError)}`
      : verifyResult.reason;

    return {
      name: task.name,
      category: task.category,
      pass: verifyResult.pass,
      reason,
      durationMs: Math.round(performance.now() - start),
      cost,
      turns,
      model: real ? model : "mock-model",
      provider: real ? provider : "mock",
      throttled,
      errors: errors.length ? errors : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    return {
      name: task.name,
      category: task.category,
      pass: false,
      reason: msg,
      durationMs: Math.round(performance.now() - start),
      cost: 0,
      turns: 0,
      model: real ? model : undefined,
      provider: real ? provider : undefined,
      throttled: isThrottleError(msg),
      errors,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

export async function runSuite(tasks: EvalTask[], opts: RunOptions = {}): Promise<TaskResult[]> {
  const real = opts.real ?? IS_REAL_MODE;
  const results: TaskResult[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const result = await runTask(tasks[i], opts);
    results.push(result);
    printResult(result);
    // Pace real runs to avoid tripping per-minute provider limits mid-suite —
    // the failure mode that contaminated the first floor run.
    if (real && TASK_DELAY_MS > 0 && i < tasks.length - 1) {
      await sleep(TASK_DELAY_MS);
    }
  }
  return results;
}

function printResult(r: TaskResult): void {
  // Throttled runs get a distinct ⚠ marker so they read as "not measured",
  // never as a capability failure.
  const mark = r.pass
    ? "\x1b[32m✓\x1b[0m"
    : r.throttled
      ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[31m✗\x1b[0m";
  const time = `\x1b[2m${r.durationMs}ms\x1b[0m`;
  const retry = (r.attempts ?? 1) > 1 ? `\x1b[2m ×${r.attempts}\x1b[0m` : "";
  const tag = `\x1b[2m${r.name}\x1b[0m`;
  console.log(`  ${mark} ${tag} ${time}${retry}`);
  if (!r.pass) {
    const label = r.throttled ? "\x1b[33mthrottled:\x1b[0m" : "\x1b[31mreason:\x1b[0m";
    console.log(`     ${label} ${r.reason ?? "(unspecified)"}`);
  }
}

// Re-export for tasks to use
export type { Script, BrokerDecision };
export { MockProvider };
export { IS_REAL_MODE };
