import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";

import { Engine } from "@gear/orchestrator";
import type {
  PermissionDecision as BrokerDecision,
  UserPermissionDecision,
} from "@gear/orchestrator";

import { MockProvider, type Responder, type Script } from "./mock-provider";

export interface EvalTask {
  name: string;
  description: string;
  category:
    | "comprehension"
    | "fix-failing-test"
    | "multi-file-refactor"
    | "new-feature"
    | "tool-discipline"
    | "core";
  /** Required in mock mode; optional in real mode. */
  script?: Script;
  /**
   * Content-addressed responses for the parts of a task an index script cannot
   * express — anything PARALLEL, where concurrent loops interleave their
   * inference calls nondeterministically. Returning null falls through to
   * `script`, so a task can use a responder for its fan-out and a script for
   * the lead's own turns. Mock mode only.
   */
  responder?: Responder;
  prompts: string[];
  /** Pre-populate the workspace before the agent runs. */
  setup?: (ctx: { workspace: string }) => Promise<void>;
  /** Customize permission handler responses for this task. Defaults to allow-once. */
  permissionResponses?: UserPermissionDecision[];
  /**
   * Scripted answers for ask_user, consumed in order (one per question). When
   * absent, ask_user runs unwired and degrades to its proceed-on-judgment
   * error — set this for tasks that exercise the clarify-first behavior.
   */
  questionResponses?: string[];
  /**
   * Hard ceiling on completed turns (one per prompt) for this task. A run that
   * exceeds a cap is stopped and FAILED — burning unbounded work is itself the
   * failure, even if the artifact eventually appears.
   */
  maxTurns?: number;
  /**
   * Hard ceiling on tool calls across the whole task — the intra-turn runaway
   * guard (turn_complete only fires once per prompt, so a looping model never
   * trips maxTurns). Defaults: none in mock mode (scripts are finite),
   * GEAR_EVAL_TASK_MAX_TOOL_CALLS (40) in real mode.
   */
  maxToolCalls?: number;
  /** Hard ceiling on provider spend (USD) for this task; same semantics. */
  maxCost?: number;
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
  /** Metered-equivalent cost — what the task's tokens are worth at list rates. */
  listCost: number;
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
  /** True when the run was stopped by the turn/cost cap (reason says which). */
  capped?: boolean;
  /**
   * The run's own retro, read from the session log after the run: how it
   * ended, steps by evidence, checks, gates. The pass/fail above says whether
   * the artifact appeared; this says how the harness got there.
   */
  retro?: RetroSummary;
}

export interface RetroSummary {
  outcome: string;
  steps: { total: number; done: number; unproven: number; open: number };
  checks: { passed: number; failed: number };
  toolCalls: number;
  toolFailed: number;
  /** Gate refusals + unproven marks + dropped steps. */
  gates: number;
  completions: number;
  lessons: number;
}

/** The last `retro` event of a session, summarised for the result row. */
function lastRetro(dbPath: string, sessionId: string): RetroSummary | undefined {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare(
          "SELECT payload_json FROM events WHERE session_id = ? AND type = 'retro' ORDER BY seq DESC LIMIT 1",
        )
        .get(sessionId) as { payload_json: string } | null;
      if (!row) return undefined;
      const parsed = JSON.parse(row.payload_json) as { payload?: { retro?: any } };
      const r = parsed.payload?.retro;
      if (!r || r.v !== 1) return undefined;
      const gates = (r.gates?.gate ?? 0) + (r.gates?.unproven ?? 0) + (r.gates?.dropped ?? 0);
      return {
        outcome: String(r.outcome),
        steps: r.steps,
        checks: { passed: r.checks?.passed ?? 0, failed: r.checks?.failed ?? 0 },
        toolCalls: r.tools?.calls ?? 0,
        toolFailed: r.tools?.failed ?? 0,
        gates,
        completions: r.completions ?? 0,
        lessons: Array.isArray(r.lessons) ? r.lessons.length : 0,
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A provider error that means "slow down / out of quota", not "wrong answer". */
function isThrottleError(msg: string): boolean {
  return /rate.?limit|usage limit|429|throttl|quota|too many requests|no credits/i.test(msg);
}

/** Real-mode retry/pacing knobs (env-overridable). */
const MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.GEAR_EVAL_MAX_RETRIES ?? process.env.GEAR_EVAL_MAX_RETRIES ?? 3),
);
const RETRY_BASE_MS = Math.max(
  0,
  Number(process.env.GEAR_EVAL_RETRY_BASE_MS ?? process.env.GEAR_EVAL_RETRY_BASE_MS ?? 4000),
);
const TASK_DELAY_MS = Math.max(
  0,
  Number(process.env.GEAR_EVAL_TASK_DELAY_MS ?? process.env.GEAR_EVAL_TASK_DELAY_MS ?? 1500),
);

/**
 * Default per-task tool-call cap in REAL mode (mock scripts are finite by
 * design). A live model burning this many tool calls on a 2-file fixture is a
 * failure regardless of what it eventually produces.
 */
const REAL_DEFAULT_MAX_TOOL_CALLS = Math.max(
  1,
  Number(
    process.env.GEAR_EVAL_TASK_MAX_TOOL_CALLS ?? process.env.GEAR_EVAL_TASK_MAX_TOOL_CALLS ?? 40,
  ),
);
/** Default per-task spend cap (USD) in real mode; 0/unset disables. */
const REAL_DEFAULT_MAX_COST = Math.max(
  0,
  Number(process.env.GEAR_EVAL_TASK_MAX_COST ?? process.env.GEAR_EVAL_TASK_MAX_COST ?? 0),
);

const TOOLS_BINARY =
  process.env.GEAR_TOOLS_BINARY ??
  process.env.GEAR_TOOLS_BINARY ??
  join(__dirname, "..", "..", "target", "release", "gear-tools");

/**
 * Legacy/default real-mode signal via env var. The runner now drives mode
 * explicitly through RunOptions.real, but we keep this export so callers that
 * only set the env var (e.g. the model-sweep path) still behave as before.
 */
const IS_REAL_MODE = (process.env.GEAR_EVAL_REAL ?? process.env.GEAR_EVAL_REAL) === "1";

export interface RunOptions {
  /** Drive a live model through the real engine/gateway instead of the mock. */
  real?: boolean;
  /** Provider for real mode (anthropic | openai | openrouter | google). */
  provider?: string;
  /** Model id for real mode. */
  model?: string;
}

export async function runTask(task: EvalTask, opts: RunOptions = {}): Promise<TaskResult> {
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
      listCost: 0,
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
async function attemptTask(task: EvalTask, opts: RunOptions, real: boolean): Promise<TaskResult> {
  const start = performance.now();
  const tmpRoot = await mkdtemp(join(tmpdir(), "gear-eval-"));
  const workspace = join(tmpRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const dbPath = join(tmpRoot, "gear.db");

  const provider =
    opts.provider ??
    process.env.GEAR_EVAL_PROVIDER ??
    process.env.GEAR_EVAL_PROVIDER ??
    process.env.GEAR_PROVIDER ??
    process.env.GEAR_PROVIDER ??
    "anthropic";
  const model =
    opts.model ??
    process.env.GEAR_EVAL_MODEL ??
    process.env.GEAR_EVAL_MODEL ??
    process.env.GEAR_MODEL ??
    process.env.GEAR_MODEL ??
    "mock-model";
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
      mock = new MockProvider(task.script ?? []);
      if (task.responder) mock.setResponder(task.responder);
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

    // Scripted user answers for ask_user (clarify-first tasks).
    if (task.questionResponses) {
      let qIndex = 0;
      engine.setQuestionHandler(async (q: { question: string; options: string[] }) => {
        return task.questionResponses![qIndex++] ?? q.options[0] ?? "yes";
      });
    }

    const sessionId = engine.createSession();
    let turns = 0;
    let finalText = "";

    // Resolve caps: per-task values win; real mode gets a global default so a
    // looping live model can't burn a whole budget on one fixture.
    const maxToolCalls = task.maxToolCalls ?? (real ? REAL_DEFAULT_MAX_TOOL_CALLS : undefined);
    const maxCost =
      task.maxCost ?? (real && REAL_DEFAULT_MAX_COST > 0 ? REAL_DEFAULT_MAX_COST : undefined);
    let toolCalls = 0;
    let cappedReason: string | null = null;

    outer: for (const prompt of task.prompts) {
      // Drain the chat generator. Count one turn per agent round-trip
      // (turn_complete), accumulate streamed assistant text so verify() can
      // judge by content, and capture provider error events so a throttle
      // surfaces as the real reason instead of a misleading verify message.
      for await (const event of engine.chat(sessionId, prompt)) {
        const ev = event as any;
        if (ev.type === "turn_complete") turns++;
        if (ev.type === "tool_call_end") toolCalls++;
        if (ev.type === "text_delta" && typeof ev.text === "string") finalText += ev.text;
        if (ev.type === "error" && typeof ev.error === "string") errors.push(ev.error);
        if (task.maxTurns !== undefined && turns >= task.maxTurns) {
          cappedReason = `exceeded turn cap (${task.maxTurns})`;
          break outer; // breaking the for-await closes the generator cleanly
        }
        if (maxToolCalls !== undefined && toolCalls > maxToolCalls) {
          cappedReason = `exceeded tool-call cap (${maxToolCalls})`;
          break outer;
        }
        // Capped on the METERED-EQUIVALENT cost, not actual spend. Eval runs
        // ride subscription and free routes where actual spend is $0 by
        // definition, so a cap on getCost() can never fire — the guard would
        // pass every task no matter how much work it burned. List cost
        // measures the work regardless of who paid for it.
        if (maxCost !== undefined && engine.getListCost() > maxCost) {
          cappedReason = `exceeded cost cap ($${maxCost.toFixed(2)}; used $${engine.getListCost().toFixed(4)} metered-equivalent)`;
          break outer;
        }
      }
    }

    // Recorded per task so the suite can report cost alongside pass/fail —
    // the two numbers have never been captured together.
    const cost = engine.getCost();
    const listCost = engine.getListCost();
    // The run's retro is in the session log by the time chat() returns.
    const retro = lastRetro(dbPath, sessionId);

    if (cappedReason) {
      engine.close();
      return {
        name: task.name,
        category: task.category,
        pass: false,
        reason: cappedReason,
        durationMs: Math.round(performance.now() - start),
        cost,
        listCost,
        turns,
        model: real ? model : "mock-model",
        provider: real ? provider : "mock",
        capped: true,
        errors: errors.length ? errors : undefined,
        retro,
      };
    }

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
    const throttled = !verifyResult.pass && turns === 0 && errors.some(isThrottleError);
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
      listCost,
      turns,
      model: real ? model : "mock-model",
      provider: real ? provider : "mock",
      throttled,
      errors: errors.length ? errors : undefined,
      retro,
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
      listCost: 0,
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
  const mark = r.pass ? "\x1b[32m✓\x1b[0m" : r.throttled ? "\x1b[33m⚠\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const time = `\x1b[2m${r.durationMs}ms\x1b[0m`;
  const retry = (r.attempts ?? 1) > 1 ? `\x1b[2m ×${r.attempts}\x1b[0m` : "";
  const tag = `\x1b[2m${r.name}\x1b[0m`;
  // How the harness got there, next to whether the artifact appeared.
  const rt = r.retro;
  const how = rt
    ? `\x1b[2m · ${rt.outcome} · steps ${rt.steps.done}/${rt.steps.total}${rt.steps.unproven > 0 ? ` ~${rt.steps.unproven}` : ""} · checks ${rt.checks.passed}/${rt.checks.failed}${rt.gates > 0 ? ` · gates ${rt.gates}` : ""}\x1b[0m`
    : "";
  console.log(`  ${mark} ${tag} ${time}${retry}${how}`);
  if (!r.pass) {
    const label = r.throttled ? "\x1b[33mthrottled:\x1b[0m" : "\x1b[31mreason:\x1b[0m";
    console.log(`     ${label} ${r.reason ?? "(unspecified)"}`);
  }
}

// Re-export for tasks to use
export type { Script, BrokerDecision };
export { MockProvider };
export { IS_REAL_MODE };
