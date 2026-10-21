/**
 * The request check (A3) through the real Engine and the native tools: a
 * scripted model writes a file, the end-of-turn check passes, and the change
 * is read against the request before the run may say `done`.
 *
 * What only this level can show: the checker is given exactly what the RUN
 * changed — the file history's before-image to the file as it now stands —
 * and never the person's own uncommitted work from before the run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import type {
  ContentBlock,
  InferenceRequest,
  InferenceResponse,
} from "../../packages/llm-gateway/src/types";
import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import { Engine } from "../../packages/orchestrator/src/engine";
import { UsageProvider } from "../helpers/usage-provider";
import { resolveRuneToolsBinary } from "../helpers/native-binary";

const nativeBinary = resolveRuneToolsBinary();
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const PROMPT =
  "Add a tags field to the notes list in notes.ts, and add a line about it to CHANGELOG.md.";

/** The scripted model, plus the checker's own answers for `request_check` calls. */
class Scripted extends UsageProvider {
  readonly checks: string[] = [];
  constructor(private readonly answers: string[]) {
    super();
  }
  override async infer(request: InferenceRequest): Promise<InferenceResponse> {
    if (request.role !== "request_check") return super.infer(request);
    const sent = request.messages
      .map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""))
      .join("\n");
    this.checks.push(sent);
    const answer = this.answers[Math.min(this.checks.length - 1, this.answers.length - 1)]!;
    return {
      id: "request-check",
      model: request.model,
      content: [{ type: "text", text: answer }],
      stopReason: "end_turn",
      usage: this.usage,
    };
  }
}

const write = (id: string, path: string, content: string): ContentBlock[] => [
  { type: "tool_use", toolCallId: id, toolName: "write_file", toolInput: { path, content } },
];
const say = (text: string): ContentBlock[] => [{ type: "text", text }];
const FOUND = JSON.stringify({
  asks: [
    { ask: "add a tags field", done: true, evidence: "notes.ts" },
    { ask: "a changelog line", done: true, evidence: "CHANGELOG.md" },
  ],
});
const NO_CHANGELOG = JSON.stringify({
  asks: [
    { ask: "add a tags field", done: true, evidence: "notes.ts" },
    { ask: "a changelog line", done: false, evidence: "CHANGELOG.md is not in the change" },
  ],
});

async function run(turns: ContentBlock[][], answers: string[]) {
  const base = mkdtempSync(join(tmpdir(), "rune-request-check-e2e-"));
  scratch.push(base);
  const root = join(base, "ws");
  const home = join(base, "home");
  spawnSync("mkdir", ["-p", root, home]);
  const git = (...args: string[]) =>
    spawnSync(
      "git",
      ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
      { encoding: "utf8" },
    );
  git("init", "-q");
  writeFileSync(join(root, "notes.ts"), "export const notes = [];\n");
  writeFileSync(join(root, "other.ts"), "export const other = 1;\n");
  writeFileSync(join(root, "check.mjs"), "process.exit(0);\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  // The person's own uncommitted work, from before the run.
  writeFileSync(join(root, "other.ts"), "export const other = 2; // MINE, not the run's\n");
  const before = new Date(Date.now() - 60_000);
  utimesSync(join(root, "other.ts"), before, before);

  const previousHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: root,
    dbPath: join(home, "rune.db"),
    toolsBinaryPath: nativeBinary.path,
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: true,
    verifyCommand: ["node check.mjs"],
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as ConstructorParameters<typeof Engine>[0]);
  const provider = new Scripted(answers);
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  let turn = 0;
  const seen: InferenceRequest[] = [];
  provider.onRequest = (request) => {
    seen.push(request);
    return turns[turn++] ?? say("Done.");
  };
  const events: AgentTurnEvent[] = [];
  try {
    for await (const event of engine.chat(engine.createSession(), PROMPT)) events.push(event);
  } finally {
    engine.close();
    if (previousHome === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previousHome;
  }
  const verdict = (
    events.filter((e) => e.type === "turn_complete").at(-1) as
      { verdict?: { kind: string; gaps?: Array<{ criterion: string; why: string }> } } | undefined
  )?.verdict;
  const notices = events
    .filter((e) => e.type === "notice")
    .map((e) => (e as { message: string }).message);
  return { verdict, notices, checks: provider.checks, seen };
}

describe.skipIf(!nativeBinary.exists)("the request check, through the engine", () => {
  test("every ask found: done — and the checker saw the run's change, not the person's", async () => {
    const r = await run(
      [
        write("w1", "notes.ts", "export const notes: { tags: string[] }[] = [];\n"),
        write("w2", "CHANGELOG.md", "- Notes have tags.\n"),
        say("Done."),
      ],
      [FOUND],
    );
    expect(r.checks).toHaveLength(1);
    const sent = r.checks[0]!;
    expect(sent).toContain(PROMPT);
    expect(sent).toContain("+export const notes: { tags: string[] }[] = [];");
    expect(sent).toContain("+- Notes have tags.");
    expect(sent).not.toContain("MINE, not the run's");
    // Not shown, and not named as a file the run changed either.
    expect(sent).not.toContain("other.ts");
    expect(r.verdict?.kind).toBe("done");
  }, 120_000);

  test("a file a shell command wrote is named to the checker", async () => {
    const r = await run(
      [
        [
          {
            type: "tool_use",
            toolCallId: "b1",
            toolName: "bash",
            toolInput: { command: "node -e \"require('fs').writeFileSync('gen.json', '{}')\"" },
          },
        ],
        write("w1", "notes.ts", "export const notes: { tags: string[] }[] = [];\n"),
        write("w2", "CHANGELOG.md", "- Notes have tags.\n"),
        say("Done."),
      ],
      [FOUND],
    );
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toContain("These files also changed");
    expect(r.checks[0]).toContain("gen.json");
  }, 120_000);

  test("an ask not found: one re-prompt names it, the run finishes it, and then done", async () => {
    const r = await run(
      [
        write("w1", "notes.ts", "export const notes: { tags: string[] }[] = [];\n"),
        say("Done."),
        write("w2", "CHANGELOG.md", "- Notes have tags.\n"),
        say("Done, with the changelog."),
      ],
      [NO_CHANGELOG, FOUND],
    );
    expect(r.notices).toContain(
      "The request check found 1 part of the request not done — asking once to finish it.",
    );
    const reprompted = r.seen.some((request) =>
      JSON.stringify(request.messages).includes(
        "a changelog line — CHANGELOG.md is not in the change",
      ),
    );
    expect(reprompted).toBe(true);
    expect(r.checks).toHaveLength(2);
    expect(r.verdict?.kind).toBe("done");
  }, 120_000);

  test("still missing after the re-prompt: partial, with the ask named", async () => {
    const r = await run(
      [
        write("w1", "notes.ts", "export const notes: { tags: string[] }[] = [];\n"),
        say("Done."),
        write("w2", "notes.ts", "export const notes: { tags: string[] }[] = []; // again\n"),
        say("Done."),
      ],
      [NO_CHANGELOG, NO_CHANGELOG],
    );
    expect(r.verdict?.kind).toBe("partial");
    expect(r.verdict?.gaps?.some((g) => g.criterion === "the request")).toBe(true);
  }, 120_000);
});
