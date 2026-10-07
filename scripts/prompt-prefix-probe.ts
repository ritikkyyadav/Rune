#!/usr/bin/env bun
/**
 * Where the system prompt stops being the same from one process to the next.
 *
 * A provider's prompt cache serves an exact prefix. Rune's system prompt is
 * stable text, then an `# Environment` block — today's date, a `git status`
 * snapshot, the recent commits — then more stable text. Inside one process the
 * block is computed once, so it costs nothing. A NEW process (a resume) computes
 * it again, and whatever follows it is past the end of the reusable prefix.
 *
 * This prints how much that is: bytes before the block, the block, and after.
 *
 *   bun --preload ./tests/scratch-home.ts scripts/prompt-prefix-probe.ts
 *
 * What it does NOT measure: a cache hit rate. That follows from repeated real
 * requests against a real provider inside its retention window, not from byte
 * counts. This is the size of the question, not its answer.
 *
 * A real Engine on a throwaway workspace and home, and a provider that answers
 * one line. Zero model calls, zero network; writes nothing outside the temp dir.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../packages/orchestrator/src/engine";

const dir = mkdtempSync(join(tmpdir(), "rune-prefix-ws-"));
const home = mkdtempSync(join(tmpdir(), "rune-prefix-home-"));
process.env.RUNE_HOME = home;
writeFileSync(join(dir, "README.md"), "# fixture\n");
for (const args of [
  ["init", "--initial-branch=main"],
  ["add", "."],
  ["-c", "user.name=Probe", "-c", "user.email=probe@localhost", "commit", "-m", "base"],
]) {
  spawnSync("git", args, { cwd: dir });
}

const systems: string[] = [];
const provider = {
  name: "anthropic",
  infer: async (request: { model: string }) => ({
    id: "probe",
    model: request.model,
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
  async *inferStream(request: { system?: unknown }) {
    systems.push(
      typeof request.system === "string" ? request.system : JSON.stringify(request.system),
    );
    yield { type: "message_start", messageId: "m" };
    yield { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text: "Done." } };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  },
  countTokens: async () => 1,
  healthCheck: async () => true,
};

const engine = new Engine({
  model: "claude-sonnet-5",
  provider: "anthropic",
  workspaceRoot: dir,
  dbPath: join(home, "rune.db"),
  permissionMode: "gear-4",
  enableCheckpoints: false,
  enableHooks: false,
  enableMcp: false,
  enableVerification: false,
  memory: { enabled: false },
} as never);
(engine as unknown as { gateway: { registerProvider(p: unknown): void } }).gateway.registerProvider(
  provider,
);
const session = engine.createSession();
for await (const _event of engine.chat(session, "Fix the bug in README.md.")) {
  // drained
}
engine.close();

const system = systems[0] ?? "";
const at = system.indexOf("# Environment");
const end = at < 0 ? -1 : system.indexOf("\n\n", at);
const bytes = (text: string): number => Buffer.byteLength(text);
console.log(
  JSON.stringify(
    {
      schema: "rune-prompt-prefix@1",
      modelCalls: 0,
      requests: systems.length,
      systemBytes: bytes(system),
      bytesBeforeEnvironment: at < 0 ? null : bytes(system.slice(0, at)),
      environmentBytes: at < 0 || end < 0 ? null : bytes(system.slice(at, end)),
      bytesAfterEnvironment: end < 0 ? null : bytes(system.slice(end)),
      firstSectionAfter: end < 0 ? null : system.slice(end).trim().split("\n")[0],
    },
    null,
    2,
  ),
);
rmSync(dir, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
process.exit(0);
