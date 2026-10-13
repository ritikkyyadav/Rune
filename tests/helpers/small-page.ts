/**
 * One small page, built from an empty folder through a real Engine in Auto mode
 * by a scripted model that does only the work: write the files, check them, say
 * so. Nobody is there to answer a question and no browser is mounted — the
 * conditions of the three builds recorded on 2026-10-09
 * (`~/rune-evidence/design-ab2-20261008`), which made 27 to 39 model calls each
 * where the other tools made 7 to 11.
 *
 * The script calls no bookkeeping tool, searches nothing and asks nothing. So
 * whatever else the run pays for is the HARNESS's doing — a reviewer call, a
 * refused finish, a re-prompt — and whatever the model is told that would send
 * it off to do those things is in the requests it received. That makes this the
 * instrument for two questions about a small build: does it cost only its own
 * completions, and is it told anything that contradicts itself?
 *
 * What a real model does with what it is told is a different question, and not
 * one a script can answer.
 *
 * Zero live model calls: an in-process scripted provider under a scratch
 * RUNE_HOME. Needs the native tools binary.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LlmGateway } from "../../packages/llm-gateway/src/gateway";
import type { ContentBlock, InferenceRequest } from "../../packages/llm-gateway/src/types";
import { Engine, isHarnessAuthoredTurn } from "../../packages/orchestrator/src/engine";
import { unfinishedVerdict } from "../../packages/orchestrator/src/headless";
import type { AgentTurnEvent } from "../../packages/protocol/src/index";
import type { SessionManager } from "../../packages/shared/src/session";
import { isOsIsolationAvailable } from "../../packages/tool-registry/src/index";
import { BOOKKEEPING_TOOLS } from "./easy-task";
import { UsageProvider } from "./usage-provider";

/** The first of the three recorded prompts, word for word. */
export const PAGE_REQUEST =
  "Build a landing page for Driftwood, a specialty coffee subscription. One page with a hero, " +
  "how it works, three plans with prices, testimonials, an FAQ and a footer. Make it look like " +
  "a real product a small team would be proud to ship. Use plain HTML, CSS and JavaScript only: " +
  "no framework, no build step, no network requests for fonts, images or libraries. It must " +
  "work by opening index.html from the folder.";

let callSeq = 0;
export const call = (name: string, args: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  toolCallId: `page${++callSeq}`,
  toolName: name,
  toolInput: args,
});

/**
 * A check in the shape the recorded runs wrote theirs: a script on standard
 * input that loads the page's own code. It prints the word "render" and says
 * `delete` — the two words that had the recorded one rated a destructive
 * operation on a remote service and sent to the heavy reviewer in path.
 */
export const PAGE_CHECK = [
  "bun run - <<'JS'",
  'const fs = require("node:fs");',
  'const source = fs.readFileSync("script.js", "utf8");',
  'const seen = { plans: (fs.readFileSync("index.html", "utf8").match(/plan-card/g) || []).length };',
  "delete seen.unused;",
  'if (seen.plans !== 3 || !source.includes("addEventListener")) process.exit(1);',
  'console.log("render, 3 plans, script wired");',
  "JS",
].join("\n");

/** Write the three files, check them, report. Nothing else. */
export const PAGE_SCRIPT: ContentBlock[][] = [
  [
    call("write_file", {
      path: "index.html",
      content:
        '<!doctype html><link rel="stylesheet" href="styles.css"><main>' +
        '<section class="plan-card"></section><section class="plan-card"></section>' +
        '<section class="plan-card"></section></main><script src="script.js"></script>\n',
    }),
  ],
  [
    call("write_file", { path: "styles.css", content: "main { display: grid; gap: 16px; }\n" }),
    call("write_file", {
      path: "script.js",
      content: 'document.addEventListener("click", () => {});\n',
    }),
  ],
  [call("bash", { command: PAGE_CHECK })],
  [{ type: "text", text: "Built the Driftwood page in index.html. The layout was not seen." }],
];

export interface ScriptedRun {
  /** Completions the acting model was asked for. */
  primaryRequests: number;
  /** Calls made to a safety reviewer, by role, in order. */
  reviewerRoles: string[];
  /** Tool calls that executed, in order, and whether each succeeded. */
  tools: string[];
  toolFailures: string[];
  bookkeepingCalls: number;
  /** User-role rows the HARNESS wrote: gates, nudges, re-prompts — by origin. */
  harnessTurns: string[];
  notices: string[];
  verification: string[];
  /** What each end-of-turn verification said it ran, verbatim. */
  verificationReports: string[];
  stopReason: string | undefined;
  verdictKind: string | undefined;
  criteria: number;
  /** What a headless caller would be told is wrong with a finished run, if anything. */
  unfinished: string | undefined;
  /** The first request the acting model received, and everything it was ever shown. */
  firstRequest: string;
  everythingShown: string;
  /** Whether this machine can contain a shell command at all. */
  contained: boolean;
  /** A workspace file as the run left it, or "" when it is not there. */
  read(path: string): string;
  dispose(): void;
}

function git(root: string, args: string[]): void {
  const res = spawnSync(
    "git",
    ["-c", "user.name=E", "-c", "user.email=e@localhost", "-c", "commit.gpgSign=false", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
}

export async function runScripted(
  toolsBinaryPath: string,
  request: string,
  script: ContentBlock[][],
  /** Files the workspace starts with, committed. None: an empty repository. */
  files: Record<string, string> = {},
): Promise<ScriptedRun> {
  const dir = mkdtempSync(join(tmpdir(), "page-ws-"));
  const home = mkdtempSync(join(tmpdir(), "page-home-"));
  const previousHome = process.env.RUNE_HOME;
  process.env.RUNE_HOME = home;
  git(dir, ["init", "--initial-branch=main"]);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  if (Object.keys(files).length > 0) git(dir, ["add", "."]);
  git(dir, ["commit", "--allow-empty", "-m", "base"]);

  // The product's own defaults wherever they bear on the question: Auto mode,
  // checks on, the plan ledger on, the gates on. Only the things that need a
  // network are off. No question handler is installed, which is what makes
  // this a run with nobody to ask.
  const engine = new Engine({
    model: "claude-sonnet-5",
    provider: "anthropic",
    workspaceRoot: dir,
    dbPath: join(home, "rune.db"),
    toolsBinaryPath,
    permissionMode: "auto",
    enableCheckpoints: false,
    enableSecurity: false,
    enableRateLimiting: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    context: { repoMap: false },
    evolve: { playbook: false },
    memory: { enabled: false },
  } as ConstructorParameters<typeof Engine>[0]);
  const dispose = (): void => {
    try {
      engine.close();
    } catch {
      /* already closed */
    }
    if (previousHome === undefined) delete process.env.RUNE_HOME;
    else process.env.RUNE_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };

  try {
    const provider = new UsageProvider();
    (engine as unknown as { gateway: LlmGateway }).gateway.registerProvider(provider);
    const primary: InferenceRequest[] = [];
    provider.onRequest = (incoming) => {
      primary.push(incoming);
      return script[primary.length - 1] ?? [{ type: "text", text: "Done." }];
    };

    const session = engine.createSession();
    const events: AgentTurnEvent[] = [];
    for await (const event of engine.chat(session, request)) events.push(event);

    const ended = events.flatMap((e) => (e.type === "tool_call_end" ? [e.output] : []));
    const tools = ended.map((o) => o.toolName);
    const sessions = (engine as unknown as { sessions: SessionManager }).sessions;
    const stored = sessions.getEvents(session, 0);
    const harnessTurns = stored.flatMap(({ event }) =>
      event.type === "user_msg" && isHarnessAuthoredTurn(event.payload)
        ? [String(event.payload.harness)]
        : [],
    );
    const complete = events.flatMap((e) => (e.type === "turn_complete" ? [e] : [])).at(-1);
    const written = ["index.html", "styles.css", "script.js"].filter((f) =>
      existsSync(join(dir, f)),
    );
    return {
      primaryRequests: primary.length,
      // Reviewer calls go through the gateway's non-streaming path, so they are
      // the provider's requests the scripted stream never saw.
      reviewerRoles: provider.requests
        .filter((r) => r.role === "classifier" || r.role === "supervisor")
        .map((r) => String(r.role)),
      tools,
      toolFailures: ended.filter((o) => !o.success).map((o) => `${o.toolName}: ${o.error ?? ""}`),
      bookkeepingCalls: tools.filter((t) => BOOKKEEPING_TOOLS.has(t)).length,
      harnessTurns,
      notices: events.flatMap((e) => (e.type === "notice" ? [e.message] : [])),
      verification: events.flatMap((e) =>
        e.type === "verification_completed" ? [e.status ?? (e.passed ? "passed" : "failed")] : [],
      ),
      verificationReports: events.flatMap((e) =>
        e.type === "verification_completed" ? [String(e.report ?? "")] : [],
      ),
      stopReason: complete?.stopReason,
      verdictKind: complete?.verdict?.kind,
      criteria: complete?.verdict?.criteria.length ?? 0,
      unfinished: unfinishedVerdict(complete?.verdict, written),
      firstRequest: JSON.stringify(primary[0]?.messages ?? []),
      everythingShown: JSON.stringify(primary.map((r) => r.messages)),
      contained: isOsIsolationAvailable(),
      read: (path) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : ""),
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}
