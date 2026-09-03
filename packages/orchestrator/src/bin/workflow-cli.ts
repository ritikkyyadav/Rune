// ─── `gear workflow <file>`: run a deterministic multi-agent DAG ───
//
// `research.ts` was the only DAG in this repository and it was hardcoded.
// Everything good about it — the fan-out, the bounded concurrency, the fixed
// shape — was trapped inside one feature, and any other repeatable shape had to
// be expressed as a prompt asking the model to please do five things in order.
// This is that shape as a file.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  defaultStatePath,
  loadState,
  parseWorkflow,
  runWorkflow,
  topologicalWaves,
  type NodeResult,
  type WorkflowNode,
} from "../workflow";
import { accent, danger, dim, info, ok, text, warn } from "./ui/theme";

const say = (s = ""): void => {
  process.stdout.write(s + "\n");
};

function usage(): void {
  say(`
  ${text("gear workflow")} ${dim("<file.workflow.json>")}

  Run a deterministic multi-agent workflow: a node list executed in topological
  waves, resumable from the last completed node, each node's result cached by
  content hash.

  ${dim("--dry-run")}      print the waves and exit without running anything
  ${dim("--fresh")}        ignore saved state and re-run every node
  ${dim("--state <path>")} where resume state lives (default .gear/workflows/<name>.state.json)
  ${dim("--max-parallel")} concurrency within a wave
  ${dim("--json")}         machine-readable result
  ${dim("--mock")}         run without a model: every node returns a deterministic stub
  ${dim("--stop-after <id>")} stop the mock run once that node completes, and leave the
                    state on disk — a kill you can aim, for proving resume
`);
}

/** A node runner with no model behind it. Makes the executor testable and the CLI demoable. */
function mockRunner(node: WorkflowNode, prompt: string) {
  return Promise.resolve({
    output: `[mock ${node.kind} ${node.id}] ${prompt.slice(0, 120).replace(/\s+/g, " ")}`,
    structured: {
      summary: `mock result for ${node.id}`,
      findings: [],
      filesExamined: [],
      filesChanged: node.files ?? [],
      checks: "not_run",
      confidence: "low",
      unresolved: [],
      stopReason: "end_turn",
      toolCallCount: 0,
    },
  });
}

export async function runWorkflowCommand(
  args: string[],
  values: Record<string, unknown>,
): Promise<number> {
  const file = args[0];
  if (!file || values.help) {
    usage();
    return file ? 0 : 1;
  }
  const workspaceRoot = process.cwd();
  const path = isAbsolute(file) ? file : resolve(workspaceRoot, file);
  if (!existsSync(path)) {
    say(`  ${danger("!")} no such workflow file: ${path}`);
    return 1;
  }

  let definition;
  try {
    definition = parseWorkflow(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    say(`  ${danger("!")} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let waves;
  try {
    waves = topologicalWaves(definition.nodes);
  } catch (err) {
    // A cycle is named, not merely reported: "workflow did not finish" is a far
    // worse message than "a and b depend on each other".
    say(`  ${danger("!")} ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const statePath =
    typeof values.state === "string" && values.state
      ? resolve(workspaceRoot, values.state)
      : defaultStatePath(workspaceRoot, definition.name);

  if (values["dry-run"]) {
    say(`\n  ${text(definition.name)}  ${dim(definition.description ?? "")}`);
    for (const [i, wave] of waves.entries()) {
      say(`  ${dim(`wave ${i + 1}`)}  ${wave.map((n) => accent(n.id)).join(dim(" · "))}`);
    }
    const prior = loadState(statePath);
    if (prior) {
      const done = Object.values(prior.results).filter((r) => r.status === "completed").length;
      say(`  ${dim(`resume state: ${done}/${definition.nodes.length} completed`)}`);
    }
    say();
    return 0;
  }

  // `--mock` is the honest way to demonstrate and to test the executor: real
  // delegation needs an engine, a provider and money, and none of that is
  // exercising the part this file is responsible for.
  if (!values.mock) {
    say(
      `  ${warn("!")} live workflow execution runs inside a session (the \`workflow\` tool).\n` +
        `    From the CLI, use ${info("--mock")} to validate the graph, resume and caching,\n` +
        `    or ${info("--dry-run")} to print the waves.`,
    );
    return 1;
  }

  const effectiveStatePath = values.fresh ? undefined : statePath;
  const results: NodeResult[] = [];
  const maxParallel = Math.max(0, Math.floor(Number(values["max-parallel"] ?? 0)) || 0);

  // A kill you can aim.
  //
  // Resume is the property a workflow is worth having, and the only honest way
  // to check it is to stop a run in the middle and start it again. Timing a
  // signal at a mock run whose nodes return instantly is a race; naming the
  // node is not. The state file is written after every node either way, so
  // this exercises exactly the path an abrupt death does.
  const stopAfter = typeof values["stop-after"] === "string" ? values["stop-after"] : "";
  const stopper = new AbortController();
  if (stopAfter && !definition.nodes.some((n) => n.id === stopAfter)) {
    say(`  ${danger("!")} --stop-after: no node "${stopAfter}" in this workflow`);
    return 1;
  }

  const state = await runWorkflow(definition, {
    runNode: mockRunner,
    ...(effectiveStatePath ? { statePath: effectiveStatePath } : {}),
    ...(stopAfter ? { signal: stopper.signal } : {}),
    // parseArgs hands this back as a STRING, and `Number.isFinite("2")` is
    // false — so the flag parsed, printed in the usage text, and did nothing.
    ...(maxParallel > 0 ? { maxParallel } : {}),
    onEvent: (event) => {
      if (event.type === "node_done" && event.id === stopAfter) {
        // Aborted the instant the named node lands, so the state file holds
        // exactly the prefix that completed and nothing after it.
        stopper.abort();
      }
      if (values.json) return;
      if (event.type === "wave_start") {
        say(`\n  ${dim(`wave ${event.wave + 1}`)}  ${event.nodes.map(accent).join(dim(" · "))}`);
      } else if (event.type === "node_cached") {
        say(`    ${dim("↺")} ${text(event.id)} ${dim("cached")}`);
      } else if (event.type === "node_done") {
        results.push(event.result);
        const mark =
          event.result.status === "completed"
            ? ok("✓")
            : event.result.status === "failed"
              ? danger("✗")
              : warn("–");
        say(
          `    ${mark} ${text(event.id)} ${dim(
            `${event.result.status}${event.result.attempts > 1 ? ` after ${event.result.attempts} attempts` : ""}` +
              `${event.result.error ? ` — ${event.result.error}` : ""}`,
          )}`,
        );
      } else if (event.type === "workflow_done") {
        say(
          `\n  ${event.failed === 0 && event.skipped === 0 ? ok("✓") : warn("!")} ` +
            `${event.completed} completed · ${event.failed} failed · ${event.skipped} skipped\n`,
        );
      }
    },
  });

  if (values.json) say(JSON.stringify(state, null, 2));
  if (stopAfter) {
    // An aimed stop is not a failure, and reporting it as one would make the
    // resume it exists to demonstrate look like a recovery from a bug.
    const done = Object.values(state.results).filter((r) => r.status === "completed").length;
    say(
      `  ${warn("!")} stopped after ${text(stopAfter)} ${dim(
        `— ${done}/${definition.nodes.length} completed, state kept at ${statePath}`,
      )}\n`,
    );
    return 0;
  }
  const failed = Object.values(state.results).filter((r) => r.status !== "completed").length;
  return failed === 0 ? 0 : 1;
}
