import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { RunRetro } from "../../packages/orchestrator/src/retro";
import type { TaskState } from "../../packages/orchestrator/src/task-state";
import type { SessionManager } from "../../packages/shared/src/session";
import { UsageProvider } from "../helpers/usage-provider";

const binary = resolve(
  process.env.RUNE_TOOLS_BINARY ??
    `target/debug/rune-tools${process.platform === "win32" ? ".exe" : ""}`,
);
const available = existsSync(binary);
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
  "echo",
  "same-batch",
  "open-step",
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
      const cite = tool("record_evidence", { claim: "the output passes the check", command });
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
        scenario === "same-batch"
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
        expect(citation.output.result).toContain("nothing on record");
        expect(retro.checks).toEqual({ passed: 0, failed: 0 });
        expect(state.todos[0].unproven).toBe("no_evidence");
      }
    },
    20_000,
  );
}
