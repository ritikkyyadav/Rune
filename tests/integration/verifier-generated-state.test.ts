/**
 * What Rune's own end-of-turn check leaves in the tree — through a real Engine.
 *
 * `verifier-generated-state.test.ts` (unit) holds the rule; the loop test holds
 * the reporting. This joins them where B1 found the problem: a run edits a
 * file, the turn ends, the engine runs the project's declared `typecheck`, and
 * that check builds. Afterwards the tree holds the run's edit and nothing else,
 * the event says what was taken away, and the session's own record does too.
 *
 * And the switch: `verifyKeepGenerated` — what `[verify] keepGenerated` sets —
 * leaves the build where the check put it.
 *
 * A real Engine, the native tools, a scripted model. Zero live model calls.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import { resolveRuneToolsBinary } from "../helpers/native-binary";
import { UsageProvider } from "../helpers/usage-provider";

const native = resolveRuneToolsBinary();

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** The project's `typecheck`: it builds, as `turbo typecheck` does. */
const BUILDS = `import { mkdirSync, writeFileSync } from "node:fs";
for (const dir of [".turbo/cache", "dist", "packages/a/dist"]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/out.js", "generated\\n");
}
`;

function git(root: string, args: string[]): string {
  const res = spawnSync(
    "git",
    ["-c", "user.name=G", "-c", "user.email=g@localhost", "-c", "commit.gpgSign=false", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
  // Not `trim`: a status line begins with its two-column code, and one may be a space.
  return res.stdout.trimEnd();
}

function fixture(config: Record<string, unknown> = {}): { dir: string; engine: Engine } {
  const dir = mkdtempSync(join(tmpdir(), "generated-ws-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "generated-home-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previous;
  });
  for (const [name, text] of Object.entries({
    ".gitignore": "dist/\n.turbo/\n.rune/\n",
    "package.json": JSON.stringify({
      name: "fixture",
      type: "module",
      scripts: { typecheck: "node builds.mjs" },
    }),
    "bun.lock": "",
    "builds.mjs": BUILDS,
    "src/a.ts": "export const a = 1;\n",
    "packages/a/index.ts": "export const b = 1;\n",
  })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(home, "rune.db"),
    toolsBinaryPath: native.path,
    permissionMode: "gear-4",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
    ...config,
  } as ConstructorParameters<typeof Engine>[0]);
  cleanup.push(() => engine.close());
  return { dir, engine };
}

/** One message: the model edits `src/a.ts`, then says it is done. */
async function editAndFinish(engine: Engine) {
  const provider = new UsageProvider();
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  const script: ContentBlock[][] = [
    [
      {
        type: "tool_use",
        toolCallId: "g1",
        toolName: "write_file",
        toolInput: { path: "src/a.ts", content: "export const a = 2;\n" },
      },
    ],
  ];
  provider.onRequest = (_request, index) => script[index - 1] ?? [{ type: "text", text: "Done." }];
  const session = engine.createSession();
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(session, "Set a to 2 in src/a.ts.")) events.push(event);
  const rows = (
    engine as unknown as {
      sessions: {
        getEvents(
          id: string,
          from: number,
        ): Array<{ event: { type: string; payload: Record<string, unknown> } }>;
      };
    }
  ).sessions.getEvents(session, 0);
  const state = rows.filter((row) => row.event.type === "task_state").at(-1)?.event.payload
    .state as { log?: Array<{ kind: string; text: string }> } | undefined;
  return {
    completed: events.filter((event) => event.type === "verification_completed"),
    trail: (state?.log ?? []).filter((entry) => entry.kind === "check").map((entry) => entry.text),
  };
}

describe.skipIf(!native.exists)("the check Rune ran at the end of a turn", () => {
  test("built, and the tree is left holding the run's edit and nothing else", async () => {
    const { dir, engine } = fixture();
    const { completed, trail } = await editAndFinish(engine);

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      status: "passed",
      report: "$ bun run typecheck  (ok)",
      removed: [".turbo/", "dist/", "packages/a/dist/"],
    });
    for (const built of [".turbo", "dist", "packages/a/dist"]) {
      expect([built, existsSync(join(dir, built))]).toEqual([built, false]);
    }
    // What git sees — ignored paths included, Rune's own folder aside — is the
    // one change the run made.
    const seen = git(dir, ["status", "--porcelain", "--ignored"])
      .split("\n")
      .filter((line) => !line.endsWith(".rune/"));
    expect(seen).toEqual([" M src/a.ts"]);
    expect(trail).toContain(
      "removed 3 git-ignored paths the checks generated: .turbo/, dist/, packages/a/dist/",
    );
  }, 60_000);

  test("with `[verify] keepGenerated`, what it built stays where it built it", async () => {
    const { dir, engine } = fixture({ verifyKeepGenerated: true });
    const { completed, trail } = await editAndFinish(engine);

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "passed" });
    expect("removed" in completed[0]).toBe(false);
    for (const built of [".turbo/cache/out.js", "dist/out.js", "packages/a/dist/out.js"]) {
      expect([built, existsSync(join(dir, built))]).toEqual([built, true]);
    }
    expect(trail.filter((line) => line.startsWith("removed"))).toEqual([]);
  }, 60_000);
});
