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
  script: Script;
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
    mock: MockProvider;
  }) => Promise<{ pass: boolean; reason?: string }>;
}

export interface TaskResult {
  name: string;
  pass: boolean;
  reason?: string;
  durationMs: number;
}

const TOOLS_BINARY =
  process.env.ALAN_TOOLS_BINARY ??
  join(__dirname, "..", "..", "target", "release", "alan-tools");

export async function runTask(task: EvalTask): Promise<TaskResult> {
  const start = performance.now();
  const tmpRoot = await mkdtemp(join(tmpdir(), "alan-eval-"));
  const workspace = join(tmpRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const dbPath = join(tmpRoot, "alan.db");

  try {
    if (task.setup) {
      await task.setup({ workspace });
    }

    const engine = new Engine({
      model: "mock-model",
      provider: "anthropic",
      workspaceRoot: workspace,
      dbPath,
      toolsBinaryPath: TOOLS_BINARY,
      yoloMode: false,
    });

    // Replace the real provider with the mock — reach inside via private access
    // since the engine doesn't expose this (eval-only override).
    const mock = new MockProvider(task.script);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gw: any = (engine as any).gateway;
    gw.providers.clear();
    gw.registerProvider(mock);

    // Set up permission handler with scripted responses
    let permIndex = 0;
    engine.setPermissionHandler(async () => {
      const responses = task.permissionResponses ?? [];
      const next = responses[permIndex++];
      return next ?? { kind: "allow_once" };
    });

    const sessionId = engine.createSession();

    for (const prompt of task.prompts) {
      // Drain the chat generator
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of engine.chat(sessionId, prompt)) {
        // intentionally consume all events
      }
    }

    const verifyResult = await task.verify({
      workspace,
      dbPath,
      engine,
      sessionId,
      mock,
    });

    engine.close();

    return {
      name: task.name,
      pass: verifyResult.pass,
      reason: verifyResult.reason,
      durationMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      name: task.name,
      pass: false,
      reason: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - start),
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

export async function runSuite(tasks: EvalTask[]): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const task of tasks) {
    const result = await runTask(task);
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
