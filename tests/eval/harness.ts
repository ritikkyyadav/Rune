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
}

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
  const start = performance.now();
  const tmpRoot = await mkdtemp(join(tmpdir(), "alan-eval-"));
  const workspace = join(tmpRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const dbPath = join(tmpRoot, "alan.db");

  // In mock mode, a deterministic script is required.
  if (!real && !task.script) {
    return {
      name: task.name,
      category: task.category,
      pass: false,
      reason: "task.script is required in mock mode (use --real to drive a live model)",
      durationMs: 0,
      cost: 0,
      turns: 0,
    };
  }

  try {
    if (task.setup) {
      await task.setup({ workspace });
    }

    const provider =
      opts.provider ?? process.env.ALAN_EVAL_PROVIDER ?? process.env.ALAN_PROVIDER ?? "anthropic";
    const model =
      opts.model ?? process.env.ALAN_EVAL_MODEL ?? process.env.ALAN_MODEL ?? "mock-model";

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
      // (turn_complete) and accumulate streamed assistant text so verify()
      // can judge a real model's answer by content.
      for await (const event of engine.chat(sessionId, prompt)) {
        const ev = event as any;
        if (ev.type === "turn_complete") turns++;
        if (ev.type === "text_delta" && typeof ev.text === "string") finalText += ev.text;
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

    return {
      name: task.name,
      category: task.category,
      pass: verifyResult.pass,
      reason: verifyResult.reason,
      durationMs: Math.round(performance.now() - start),
      cost,
      turns,
      model: real ? model : "mock-model",
      provider: real ? provider : "mock",
    };
  } catch (err) {
    return {
      name: task.name,
      category: task.category,
      pass: false,
      reason: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - start),
      cost: 0,
      turns: 0,
      model: opts.model,
      provider: opts.provider,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

export async function runSuite(tasks: EvalTask[], opts: RunOptions = {}): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const task of tasks) {
    const result = await runTask(task, opts);
    results.push(result);
    printResult(result);
  }
  return results;
}

function printResult(r: TaskResult): void {
  const mark = r.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const time = `\x1b[2m${r.durationMs}ms\x1b[0m`;
  const tag = `\x1b[2m${r.name}\x1b[0m`;
  if (r.pass) {
    console.log(`  ${mark} ${tag} ${time}`);
  } else {
    console.log(`  ${mark} ${tag} ${time}`);
    console.log(`     \x1b[31mreason:\x1b[0m ${r.reason ?? "(unspecified)"}`);
  }
}

// Re-export for tasks to use
export type { Script, BrokerDecision };
export { MockProvider };
export { IS_REAL_MODE };
