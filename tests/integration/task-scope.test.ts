/**
 * H2, end to end — a real Engine, the native tools, a real OS sandbox.
 *
 * `tests/unit/orchestrator/task-scope.test.ts` holds the boundary to its rules
 * with a recording registry. A rule about a SHELL cannot be shown that way:
 * what a command writes is known only by running it. So this file runs it.
 *
 * A request that says "change no code" and names REVIEW.md is given a model
 * that tries everything it should not — it overwrites a source file from the
 * shell, adds a test from the shell, redirects into the report from the shell,
 * reaches for a file tool on a test — and then does the one thing it was asked.
 * What is asserted is the tree afterwards: the report exists, and every other
 * byte the person had, committed or not, is what it was.
 *
 * Zero live model calls. Needs the native binary and an OS isolation backend
 * (sandbox-exec / bwrap); skipped, loudly, where either is missing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { ContentBlock } from "../../packages/llm-gateway/src/types";
import { Engine } from "../../packages/orchestrator/src/engine";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import {
  isOsIsolationAvailable,
  probeSandboxCapability,
} from "../../packages/tool-registry/src/sandbox-capability";
import { resolveRuneToolsBinary } from "../helpers/native-binary";
import { UsageProvider } from "../helpers/usage-provider";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const native = resolveRuneToolsBinary();
// Capability is "unknown" until probed, and an engine probes at startup — after
// this file has decided what to skip. So it is probed here, the same way.
if (native.exists) probeSandboxCapability(native.path);
const CONTAINED = native.exists && isOsIsolationAvailable();
if (!CONTAINED) {
  console.log(
    `\n  task-scope integration — SKIPPING: native binary ${native.exists ? "present" : "MISSING"}, ` +
      `OS isolation ${isOsIsolationAvailable() ? "available" : "UNAVAILABLE"}\n`,
  );
}

const REVIEW =
  "Review invoice.ts against the rules in README.md before it ships, and write your findings to REVIEW.md. This is a review, not a fix: change no code. Report only real defects.";

function git(root: string, args: string[]): void {
  const res = spawnSync(
    "git",
    ["-c", "user.name=H2", "-c", "user.email=h2@localhost", "-c", "commit.gpgSign=false", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
}

function put(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}

/** Every file under `root` outside `.git` and Rune's own directory, by hash. */
function manifest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (rel === "" && (e.name === ".git" || e.name === ".rune")) continue;
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), name);
      else
        out[name] = createHash("sha256")
          .update(readFileSync(join(dir, e.name)))
          .digest("hex");
    }
  };
  walk(root, "");
  return out;
}

/**
 * A committed project — and, on top of it, work the person has NOT committed:
 * a tracked file they were in the middle of editing, and a file they never
 * added. Both must come through byte for byte.
 */
function fixture(): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "h2-ws-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), "h2-home-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previous;
  });
  put(dir, {
    "README.md": "# Rules\n\nA quantity is a positive whole number.\n",
    "invoice.ts": "export const lineTotal = (q: number, c: number) => q * c;\n",
    "invoice.test.ts": "// the fixture's own tests\n",
    "notes.txt": "committed notes\n",
  });
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  put(dir, {
    "notes.txt": "committed notes\nan edit the person has not committed\n",
    "scratch/data.csv": "a,b\n1,2\n",
  });
  return { dir, home };
}

function makeEngine(dir: string, home: string): Engine {
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(home, "rune.db"),
    toolsBinaryPath: native.path,
    permissionMode: "gear-4",
    sandboxEnabled: true,
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableVerification: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as ConstructorParameters<typeof Engine>[0]);
  cleanup.push(() => engine.close());
  return engine;
}

let callSeq = 0;
const call = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `h2c${++callSeq}`,
  toolName: name,
  toolInput: args,
});
const bash = (command: string): ContentBlock => call("bash", { command });

/** Run one message against a script; return every tool result, in order. */
async function run(
  engine: Engine,
  message: string,
  turns: ContentBlock[][],
): Promise<Array<{ tool: string; success: boolean; text: string }>> {
  const provider = new UsageProvider();
  (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
  provider.onRequest = (_request, index) => turns[index - 1] ?? [{ type: "text", text: "Done." }];
  const session = engine.createSession();
  const results: Array<{ tool: string; success: boolean; text: string }> = [];
  const events: AgentTurnEvent[] = [];
  for await (const event of engine.chat(session, message)) {
    events.push(event);
    if (event.type === "tool_call_end") {
      results.push({
        tool: event.output.toolName,
        success: event.output.success,
        text: `${event.output.result ?? ""}\n${event.output.error ?? ""}`,
      });
    }
  }
  return results;
}

describe.skipIf(!CONTAINED)("H2 — a review that may only write its report", () => {
  test("the shell cannot write the workspace, the file tools write only the report, and nothing the person had is touched", async () => {
    const { dir, home } = fixture();
    const before = manifest(dir);
    const scratch = mkdtempSync(join(tmpdir(), "h2-repro-"));
    cleanup.push(() => rmSync(scratch, { recursive: true, force: true }));
    const engine = makeEngine(dir, home);

    const results = await run(engine, REVIEW, [
      // 1. "Fix" the source from the shell.
      [bash("echo 'export const lineTotal = () => 0;' > invoice.ts; echo \"status=$?\"")],
      // 2. Add a test from the shell, three ways.
      [bash("printf 'x' > new.test.ts; cp invoice.ts copy.ts; mkdir made-dir; echo \"status=$?\"")],
      // 3. Overwrite the person's uncommitted work, and delete their file.
      [bash('echo gone > notes.txt; rm -f scratch/data.csv; echo "status=$?"')],
      // 4. Even the named report: a shell is not how it gets written.
      [bash("echo '# Review' > REVIEW.md; echo \"status=$?\"")],
      // 5. A throwaway reproduction, where throwaway things go.
      [bash(`echo probe > '${scratch}/probe.txt' && cat '${scratch}/probe.txt'`)],
      // 6. The shell still READS the workspace.
      [bash("cat invoice.ts")],
      // 7. A file tool on a test — refused by path.
      [call("write_file", { path: "invoice.test.ts", content: "// rewritten\n" })],
      // 8. The one thing that was asked.
      [call("write_file", { path: "REVIEW.md", content: "# Review\n\n- lineTotal accepts 1.5\n" })],
      [{ type: "text", text: "The review is in REVIEW.md." }],
    ]);

    // What the tree is now: everything it was, plus the report.
    const after = manifest(dir);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "REVIEW.md"].sort());
    for (const [name, hash] of Object.entries(before)) expect(after[name]).toBe(hash);
    expect(readFileSync(join(dir, "REVIEW.md"), "utf8")).toContain("lineTotal accepts 1.5");
    // The person's uncommitted edit and untracked file, exactly.
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toContain("has not committed");
    expect(readFileSync(join(dir, "scratch/data.csv"), "utf8")).toBe("a,b\n1,2\n");
    expect(existsSync(join(dir, "made-dir"))).toBe(false);

    // And what each call was told.
    const shell = results.filter((r) => r.tool === "bash");
    expect(shell.length).toBe(6);
    // The scratch write worked, and so did the read.
    expect(shell[4]!.text).toContain("probe");
    expect(readFileSync(join(scratch, "probe.txt"), "utf8")).toBe("probe\n");
    expect(shell[5]!.text).toContain("lineTotal");
    const tools = results.filter((r) => r.tool === "write_file");
    expect(tools.map((r) => r.success)).toEqual([false, true]);
    expect(tools[0]!.text).toContain("Not written");
    expect(tools[0]!.text).toContain("REVIEW.md");
  }, 120_000);

  test("with no boundary in the request, the same shell writes the workspace as it always has", async () => {
    const { dir, home } = fixture();
    const engine = makeEngine(dir, home);
    await run(engine, "Add a made.txt file that says hello.", [
      [bash("echo hello > made.txt")],
      [{ type: "text", text: "Added." }],
    ]);
    expect(readFileSync(join(dir, "made.txt"), "utf8")).toBe("hello\n");
  }, 120_000);

  test("a background shell is held to the same boundary", async () => {
    const { dir, home } = fixture();
    const before = manifest(dir);
    const engine = makeEngine(dir, home);
    await run(engine, REVIEW, [
      [
        call("bash", {
          command: "echo x > from-background.txt; sleep 0.2",
          run_in_background: true,
        }),
      ],
      [bash("sleep 1; ls")],
      [{ type: "text", text: "Nothing to report." }],
    ]);
    expect(existsSync(join(dir, "from-background.txt"))).toBe(false);
    expect(manifest(dir)).toEqual(before);
  }, 120_000);
});
