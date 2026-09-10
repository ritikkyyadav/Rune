import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { RunRetro } from "../../packages/orchestrator/src/retro";
import type { TaskState } from "../../packages/orchestrator/src/task-state";
import type { SessionManager } from "../../packages/shared/src/session";
import { UsageProvider } from "../helpers/usage-provider";
import { describeNativeBinary, resolveRuneToolsBinary } from "../helpers/native-binary";

// An exported RUNE_TOOLS_BINARY/RUNE_TOOLS_BIN wins over anything under
// target/, and a variable pointing nowhere throws instead of skipping.
const nativeBinary = resolveRuneToolsBinary();
const binary = nativeBinary.path;
const available = nativeBinary.exists;
if (!available)
  console.warn(`[engine-command-evidence] skipped: ${describeNativeBinary(nativeBinary)}`);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

// Real Engine, registry, native shell and persisted receipts; only the provider
// is scripted. A green tool transport must not disguise a red process exit.
for (const scenario of [
  "pass",
  "fail",
  "compound-pass",
  "compound-fail",
  "later-write",
  "write-after-close",
  "echo",
  "inline-check",
  "same-batch",
  "open-step",
  "unrelated-check",
] as const) {
  test.skipIf(!available)(
    `command evidence stays consistent across the plan, citation and retro: ${scenario}`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rune-command-evidence-"));
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
      const previousHome = process.env.RUNE_HOME;
      process.env.RUNE_HOME = join(dir, "profile");
      cleanup.push(() => {
        if (previousHome === undefined) delete process.env.RUNE_HOME;
        else process.env.RUNE_HOME = previousHome;
      });
      writeFileSync(join(dir, "output.txt"), scenario === "fail" ? "broken" : "ready");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { check: "node browser-test.mjs" } }),
      );
      writeFileSync(
        join(dir, "browser-test.mjs"),
        'import assert from "node:assert/strict";\n' +
          'import { readFileSync } from "node:fs";\n' +
          'assert.equal(readFileSync("output.txt", "utf8"), "ready");\n' +
          'console.log("1 check passed");\n',
      );
      const command =
        scenario === "echo"
          ? "echo test"
          : // A real inline assertion that names nothing: it ran, and its own
            // verdict decided the exit code, but there is no reading of it
            // under which it is about the step that was open (Lane A2).
            scenario === "unrelated-check"
            ? `bun -e "if (1 + 1 !== 2) throw new Error('math')"`
            : scenario === "inline-check"
              ? `bun -e 'import assert from "node:assert/strict"; assert.equal(await Bun.file("output.txt").text(), "ready")'`
              : scenario === "same-batch" || scenario === "open-step"
                ? "node browser-test.mjs"
                : scenario.startsWith("compound-")
                  ? `test "$(cat output.txt | tr -d '\\n')" = ${scenario === "compound-pass" ? "ready" : "wrong"} && node browser-test.mjs`
                  : scenario === "fail"
                    ? "bun run check"
                    : "node browser-test.mjs";
      const engine = new Engine({
        model: "claude-sonnet-5",
        provider: "anthropic",
        workspaceRoot: dir,
        dbPath: join(dir, "rune.db"),
        toolsBinaryPath: binary,
        permissionMode: "gear-4",
        enableCheckpoints: false,
        enableSecurity: false,
        enableRateLimiting: false,
        enableHooks: false,
        enableMcp: false,
        enableSkills: false,
        enableVerification: false,
        context: { repoMap: false },
        evolve: { playbook: false },
      });
      cleanup.push(() => engine.close());
      const runtime = engine as unknown as { gateway: LlmGateway; sessions: SessionManager };
      const provider = new UsageProvider();
      runtime.gateway.registerProvider(provider);
      let call = 0;
      const tool = (name: string, args: Record<string, unknown>): ContentBlock => ({
        type: "tool_use",
        toolCallId: `check-${++call}`,
        toolName: name,
        toolInput: args,
      });
      const plan = (status: string) =>
        tool("todo_write", {
          items: [{ content: "Verify the generated output", kind: "verify", status }],
        });
      // Each entry is one completion; "same-batch" runs the check and cites
      // it in ONE response, "open-step" never closes the plan.
      const cite = tool(
        "record_evidence",
        // The unrelated case cites the STEP by number, which is the path
        // where `record_evidence` can judge relatedness at all.
        scenario === "unrelated-check"
          ? { criterion: 0, command }
          : { claim: "the output passes the check", command },
      );
      const script: ContentBlock[][] =
        scenario === "same-batch"
          ? [[plan("in_progress")], [tool("bash", { command }), cite], [plan("completed")]]
          : scenario === "open-step"
            ? [[plan("in_progress")], [tool("bash", { command })], [cite]]
            : [
                [plan("in_progress")],
                [tool("bash", { command })],
                [cite],
                ...(scenario === "later-write"
                  ? [
                      [
                        tool("write_file", {
                          path: "output.txt",
                          content: "changed after checking",
                        }),
                      ],
                    ]
                  : []),
                [plan("completed")],
                ...(scenario === "write-after-close"
                  ? [
                      [
                        tool("write_file", {
                          path: "output.txt",
                          content: "changed after closing the checked step",
                        }),
                      ],
                    ]
                  : []),
              ];
      provider.onRequest = (_request, index) =>
        script[index - 1] ?? [{ type: "text", text: "The check result is recorded." }];
      const session = engine.createSession();
      const events = [];
      for await (const event of engine.chat(
        session,
        "Run the existing check and record its result.",
      ))
        events.push(event);
      const ends = events.filter((e) => e.type === "tool_call_end");
      const shell = ends.find((e) => e.output.toolName === "bash")!;
      expect(shell.output.success).toBe(true);
      expect(JSON.parse(shell.output.result).exit_code).toBe(scenario.endsWith("fail") ? 1 : 0);
      const citation = ends.find((e) => e.output.toolName === "record_evidence")!;
      const rows = runtime.sessions.getEvents(session, 1);
      const state = rows.filter((r) => r.event.type === "task_state").at(-1)!.event.payload
        .state as unknown as TaskState;
      const retro = rows.find((r) => r.event.type === "retro")!.event.payload
        .retro as unknown as RunRetro;
      if (scenario === "write-after-close") {
        const gateRows = rows.filter(
          (r) =>
            r.event.type === "user_msg" && r.event.payload.harness === "gate:execution-evidence",
        );
        expect(gateRows).toHaveLength(1);
        expect(provider.requests).toHaveLength(script.length + 2);
        expect(citation.output.result).toContain("observed");
        expect(state.todos[0].status).toBe("completed");
        expect(state.todos[0].evidence?.lastCheck?.passed).toBe(true);
        return;
      }
      if (scenario === "unrelated-check") {
        // It RAN: the citation gets the runtime's real verdict on it, the
        // retro counts it, and the check ledger keeps it.
        expect(citation.output.result).toContain("observed");
        expect(citation.output.result).toContain("does not speak to that step");
        expect(citation.output.result).not.toContain("never ran");
        expect(citation.output.result).not.toContain("nothing on record");
        expect(retro.checks).toMatchObject({ passed: 1, failed: 0, lastPassed: command });
        expect(state.checks?.map((c) => c.command)).toEqual([command]);
        expect(state.checks?.[0]?.source).toBe("model");
        // It did not close the step: no lastCheck, and the completion the
        // model submitted stands as unproven in the check's own words.
        expect(state.todos[0].evidence?.lastCheck).toBeUndefined();
        expect(state.todos[0].evidence?.checksPassed).toBe(0);
        expect(state.todos[0].evidence?.runs).toBe(1);
        expect(state.todos[0].unproven).toBe("no_evidence");
        expect(state.todos[0].unprovenReason).toContain("no passing check");
        // The run's own log says why, and the reply the user reads never
        // claims the command was not executed.
        expect(
          (state.log ?? []).some(
            (e) => e.kind === "check" && /does not speak to/.test(String(e.text)),
          ),
        ).toBe(true);
        return;
      }
      if (scenario === "open-step") {
        // The plan was left open: the open-steps gate refused the finish once,
        // and the session log says so — as a harness-tagged user event.
        const gateRows = rows.filter(
          (r) => r.event.type === "user_msg" && r.event.payload.harness === "gate:open-steps",
        );
        expect(gateRows).toHaveLength(1);
        expect(String(gateRows[0]!.event.payload.content)).toContain("planned steps still open");
        expect(provider.requests).toHaveLength(script.length + 2);
        expect(citation.output.result).toContain("observed");
        return;
      }
      // Editing after the check correctly adds one execution-evidence nudge.
      // A same-response citation costs one completion fewer than a separate one.
      expect(provider.requests).toHaveLength(script.length + (scenario === "later-write" ? 2 : 1));
      if (
        scenario === "pass" ||
        scenario === "compound-pass" ||
        scenario === "later-write" ||
        scenario === "same-batch" ||
        // A real inline assertion IS the executed check: it ran, and its own
        // verdict decided the exit code. Before `9984109` it was refused as
        // "nothing on record" and cost Pilot J three completions; the honest
        // resolution is a real verdict here, not a weaker expectation.
        scenario === "inline-check"
      ) {
        expect(citation.output.result).toContain("observed");
        expect(retro.checks).toMatchObject({ passed: 1, failed: 0, lastPassed: command });
        expect(state.todos[0].evidence?.lastCheck?.passed).toBe(true);
        if (scenario !== "later-write") expect(state.todos[0].unproven).toBeUndefined();
        else expect(state.todos[0].unproven).toBe("no_evidence");
      } else if (scenario === "fail" || scenario === "compound-fail") {
        expect(citation.output.result).toContain("last FAILED");
        expect(retro.checks).toEqual({ passed: 0, failed: 1 });
        expect(state.todos[0].unproven).toBe("check_failed");
        expect(retro.lessons.some((lesson) => lesson.kind === "check")).toBe(false);
      } else {
        expect(citation.output.result).toContain("execution receipt only");
        expect(citation.output.result).not.toContain("never ran");
        expect(retro.checks).toEqual({ passed: 0, failed: 0 });
        expect(state.todos[0].unproven).toBe("no_evidence");
      }
    },
    20_000,
  );
}
