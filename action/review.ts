// ─── The body of `savoir/rune-action` ───
//
// A composite action written in YAML is a shell script with worse quoting and
// no way to test it. Everything with a decision in it lives here instead, so
// `--dry-run` can run the whole path locally against a fake model and print the
// comment it WOULD post. An action nobody can run outside CI is an action whose
// first real execution is on somebody's pull request.
//
// What it does, in order: read the diff, run one headless Rune turn over it,
// read the session back with `rune audit`, and post ONE comment.
//
// One comment, and it is edited in place on re-runs. A bot that appends a new
// review to every push turns the conversation into its own scrollback, and the
// thing a reviewer wants is the current state of the change, not a history of
// what a model thought about earlier versions of it.
//
// The audit summary is not decoration. The review prose is the model's opinion;
// the audit is what the run actually did — which tools, which permission
// decisions, what it cost. Publishing them together is the difference between
// "a bot said this" and "a bot said this, and here is its receipt".

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ReviewInputs {
  /** The prompt to run. Empty means the default review prompt. */
  prompt: string;
  /** `owner/repo`. */
  repo: string;
  prNumber: number;
  /** What the PR is merging into, for the diff range. */
  baseRef: string;
  gear: string;
  workspace: string;
  /** Print the comment instead of posting it. */
  dryRun: boolean;
  /** The `rune` command, as argv. */
  runeCmd: string[];
  token?: string;
  /** Cap on the diff sent to the model, in characters. */
  maxDiffChars: number;
  /**
   * Run against a mock provider instead of a real model.
   *
   * The whole point of this mode: the action's comment path — collect the diff,
   * run a turn, read the audit back, post ONE comment and edit it in place on
   * every push — was gated behind a provider key that does not exist on this
   * repository, so it had never run on a pull request. A mock provider needs no
   * credential, so the plumbing can be exercised on every PR while the real
   * review stays behind the secret. The comment says loudly which it is.
   */
  mock: boolean;
}

export const DEFAULT_PROMPT = `You are reviewing a pull request in this workspace. The diff under review is in
DIFF.patch at the workspace root, and the full tree is checked out around it.

Review it the way this project reviews its own work:

1. Read the diff, then read enough of the surrounding code to know whether each
   change is right — not just whether it is plausible.
2. Keep a plan ledger. A step is complete only when evidence closes it: a
   command you ran, a file you read, an exit code you saw. "Looks fine" closes
   nothing.
3. Say what you VERIFIED and what you only INSPECTED, and never present the
   second as the first. If you could not run the tests, say so plainly rather
   than implying the change is proven.
4. Report, in this order: correctness bugs, then security or data-loss risks,
   then contract or documentation drift, then anything else. Cite file and line.
   If you found nothing in a category, say nothing about that category.
5. If the change is fine, say so in one line. A review that pads to look
   thorough costs the author more than it gives them.

Be concise. This becomes a single pull request comment.`;

const MARKER = "<!-- rune-review -->";

function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: opts.input ? new TextEncoder().encode(opts.input) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** The same, without blocking this process's event loop. See `runReview`. */
async function runAsync(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

/**
 * The diff under review.
 *
 * `merge-base` rather than a plain two-dot diff: `base...head` is the change
 * this PR makes, while `base..head` also shows everything that landed on base
 * since the branch started, which on a busy repo is most of the review.
 */
export function collectDiff(workspace: string, baseRef: string, maxChars: number): string {
  const base = run(["git", "merge-base", `origin/${baseRef}`, "HEAD"], { cwd: workspace });
  const from = base.code === 0 && base.out.trim() ? base.out.trim() : `origin/${baseRef}`;
  const diff = run(["git", "diff", "--no-color", `${from}...HEAD`], { cwd: workspace });
  if (diff.code !== 0) return "";
  const text = diff.out;
  if (text.length <= maxChars) return text;
  // Truncating in the middle of a hunk produces a patch that reads as complete
  // and is not. Say where it stopped.
  return `${text.slice(0, maxChars)}\n\n[diff truncated at ${maxChars} characters — ${text.length} total]\n`;
}

// ─── The mock provider ───

/** The model id the mock answers to. It appears in the audit page, so name it. */
export const MOCK_MODEL = "rune-review-mock";

/**
 * The files a unified diff touches.
 *
 * Used only by the mock, so its dry-run comment says something true about the
 * change instead of a paragraph of filler. `+++ b/<path>` is the post-image
 * name; `/dev/null` is a deletion and has no post-image path.
 */
export function changedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const path = line.slice(4).trim().replace(/^b\//, "");
    if (path && path !== "/dev/null" && !files.includes(path)) files.push(path);
  }
  return files;
}

/** What the mock provider answers with. Never dressed up as an opinion. */
export function mockReviewText(diff: string): string {
  const files = changedFiles(diff);
  const head = files.slice(0, 20).map((f) => `- \`${f}\``);
  return [
    "**No model was consulted.** This run used a mock provider, so there is no",
    "review here — only proof that the action ran: the diff was collected, a",
    "session was created, a turn completed, and the audit below is that run's.",
    "",
    files.length > 0
      ? `The diff the action collected covers ${files.length} file(s):`
      : "The action collected an empty diff against the base branch.",
    ...head,
    ...(files.length > head.length ? [`- …and ${files.length - head.length} more`] : []),
  ].join("\n");
}

/**
 * A provider that needs no credential.
 *
 * Ollama reads its base URL from `OLLAMA_HOST` and authenticates nothing, so a
 * thirty-line server that speaks `/api/chat` and `/api/tags` is a complete
 * provider as far as Rune is concerned — the same trick `scripts/smoke-print.ts`
 * uses to prove a packaged binary can answer a prompt without a paid key.
 */
export function startMockProvider(reply: string): { host: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/tags") {
        return Response.json({ models: [{ name: MOCK_MODEL, model: MOCK_MODEL, size: 1 }] });
      }
      if (pathname === "/api/show") return Response.json({ capabilities: ["completion"] });
      if (pathname === "/api/chat") {
        await req.text();
        return new Response(
          `${JSON.stringify({ model: MOCK_MODEL, message: { role: "assistant", content: reply }, done: false })}\n` +
            `${JSON.stringify({
              model: MOCK_MODEL,
              message: { role: "assistant", content: "" },
              done: true,
              done_reason: "stop",
              prompt_eval_count: 0,
              eval_count: 0,
            })}\n`,
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { host: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export interface RunOutcome {
  ok: boolean;
  text: string;
  exitCode: number;
  sessionId: string | null;
  audit: string | null;
  stderrTail: string;
}

/** The last `session` id the NDJSON stream mentioned, if any. */
function sessionIdFrom(envelope: string): string | null {
  try {
    const j = JSON.parse(envelope) as { sessionId?: string };
    return typeof j.sessionId === "string" ? j.sessionId : null;
  } catch {
    return null;
  }
}

/**
 * One headless turn, then its audit.
 *
 * `--stream-json` because a run that reports one envelope after several silent
 * minutes looks identical to a wedged one in a CI log, and the person watching
 * has no other window into it.
 */
export async function runReview(
  inputs: ReviewInputs,
  prompt: string,
  extra: { argv?: string[]; env?: Record<string, string> } = {},
): Promise<RunOutcome> {
  // ASYNC, and `Bun.spawn` rather than `spawnSync`: in mock mode the provider
  // is a server in THIS process, and a synchronous spawn deadlocks — the child
  // waits on a server whose host is blocked waiting on the child.
  const res = await runAsync(
    [
      ...inputs.runeCmd,
      "-P",
      prompt,
      "--stream-json",
      "--gear",
      inputs.gear,
      "--workspace",
      inputs.workspace,
      "--new",
      ...(extra.argv ?? []),
    ],
    { cwd: inputs.workspace, ...(extra.env ? { env: extra.env } : {}) },
  );

  const lines = res.out.split("\n").filter((l) => l.trim().startsWith("{"));
  const envelope = lines.at(-1) ?? "";
  let text = "";
  let ok = res.code === 0;
  try {
    const j = JSON.parse(envelope) as { ok?: boolean; text?: string };
    text = String(j.text ?? "");
    ok = j.ok === true;
  } catch {
    text = "";
  }

  const sessionId = sessionIdFrom(envelope);
  const audit = await runAsync([...inputs.runeCmd, "audit", sessionId ?? "last"], {
    cwd: inputs.workspace,
    ...(extra.env ? { env: extra.env } : {}),
  });

  return {
    ok,
    text,
    exitCode: res.code,
    sessionId,
    audit: audit.code === 0 ? audit.out : null,
    stderrTail: res.err.split("\n").slice(-12).join("\n"),
  };
}

/** The section rows of `rune audit`, without the ANSI and without the sprawl. */
export function auditSummary(audit: string | null, width = 150): string {
  if (!audit) return "_no audit page for this run_";
  const plain = audit.replace(/\u001b\[[0-9;]*m/g, "");
  const clip = (l: string): string => (l.length > width ? `${l.slice(0, width - 1)}\u2026` : l);
  const keep = plain
    .split("\n")
    .filter((l) =>
      /^\s{2}(Rune audit|Goal|Plan|Retro|Runs|Tools|Checks|Safety|Held|Cost|Harness)\b/.test(l),
    )
    .map((l) => clip(l.trim()));
  return keep.length > 0
    ? keep.join("\n")
    : plain
        .trim()
        .split("\n")
        .slice(0, 20)
        .map((l) => clip(l))
        .join("\n");
}

export function composeComment(outcome: RunOutcome, inputs: ReviewInputs): string {
  const body = outcome.text.trim();
  const failed = !outcome.ok || body.length === 0;
  // `null` is "leave this line out"; `""` is a blank line the markdown needs.
  // Filtering on emptiness instead would glue the heading to the body and pull
  // the <details> block into the previous paragraph.
  const lines: Array<string | null> = [
    MARKER,
    inputs.mock ? `### Rune review — dry run (mock provider)` : `### Rune review`,
    "",
    // The label is the whole ethics of this mode. A comment that looks like a
    // review and was produced by a mock is worse than no comment at all, so it
    // says what it is before it says anything else, and the heading says it too
    // for anyone reading the notification.
    inputs.mock
      ? [
          "> `RUNE_REVIEW_API_KEY` is not set on this repository, so the action ran",
          "> against a **mock provider**. What this proves is that the workflow, the",
          "> action body, the audit read-back and this comment path all work. It says",
          "> nothing whatever about the change. A real review replaces this once the",
          "> secret exists.",
          "",
        ].join("\n")
      : null,
    failed
      ? [
          `The run did not complete (exit ${outcome.exitCode}). Nothing here is a review.`,
          "",
          "```",
          outcome.stderrTail.trim() || "(no stderr)",
          "```",
        ].join("\n")
      : body,
    "",
    "<details><summary>What the run actually did</summary>",
    "",
    "```",
    auditSummary(outcome.audit),
    "```",
    "",
    outcome.sessionId
      ? `Session \`${outcome.sessionId}\` · \`rune audit ${outcome.sessionId}\` for the full page.`
      : null,
    "",
    "</details>",
    "",
    `<sub>Rune · gear ${inputs.gear} · exit ${outcome.exitCode}` +
      `${inputs.mock ? " · mock provider, no model consulted" : ""}</sub>`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

// ─── Posting ───

interface GhComment {
  id: number;
  body: string;
}

/**
 * Post once, then edit that same comment forever.
 *
 * Found by the marker rather than by the bot's login: an action can run as
 * `github-actions[bot]` or as a PAT belonging to a person, and keying on the
 * author would start a second thread the first time somebody changes the token.
 */
export async function postComment(
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<{ action: "created" | "updated"; url: string }> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const listed = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers },
  );
  if (!listed.ok) throw new Error(`GitHub said ${listed.status} listing comments`);
  const existing = ((await listed.json()) as GhComment[]).find((c) => c.body?.includes(MARKER));

  const res = existing
    ? await fetch(`https://api.github.com/repos/${repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body }),
      })
    : await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body }),
      });
  if (!res.ok) throw new Error(`GitHub said ${res.status} ${existing ? "editing" : "posting"}`);
  const j = (await res.json()) as { html_url?: string };
  return { action: existing ? "updated" : "created", url: j.html_url ?? "" };
}

// ─── Entry point ───

export function parseInputs(argv: string[], env: Record<string, string | undefined>): ReviewInputs {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at !== -1 ? argv[at + 1] : undefined;
  };
  const workspace = flag("workspace") ?? env.GITHUB_WORKSPACE ?? process.cwd();
  return {
    prompt: flag("prompt") ?? env.INPUT_PROMPT ?? "",
    repo: flag("repo") ?? env.GITHUB_REPOSITORY ?? "",
    prNumber: Number(flag("pr") ?? env.INPUT_PR ?? prNumberFromEvent(env) ?? 0),
    baseRef: flag("base") ?? env.GITHUB_BASE_REF ?? "main",
    gear: flag("gear") ?? env.INPUT_GEAR ?? "3",
    workspace,
    dryRun: argv.includes("--dry-run"),
    runeCmd: (flag("rune-cmd") ?? env.INPUT_RUNE_CMD ?? "rune").split(" ").filter(Boolean),
    token: env.GITHUB_TOKEN ?? env.GH_TOKEN,
    maxDiffChars: Number(flag("max-diff") ?? env.INPUT_MAX_DIFF ?? 200_000),
    // The workflow sets the environment variable; `--mock` is for running it by
    // hand. Anything other than the exact word is a real provider, so a typo
    // fails loudly on a missing key rather than quietly posting a fake review.
    mock: argv.includes("--mock") || env.RUNE_REVIEW_PROVIDER === "mock",
  };
}

function prNumberFromEvent(env: Record<string, string | undefined>): number | null {
  try {
    const path = env.GITHUB_EVENT_PATH;
    if (!path || !existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8")) as {
      pull_request?: { number?: number };
      number?: number;
    };
    return j.pull_request?.number ?? j.number ?? null;
  } catch {
    return null;
  }
}

export async function main(argv: string[]): Promise<number> {
  const inputs = parseInputs(argv, process.env);
  if (!inputs.dryRun && (!inputs.repo || !inputs.prNumber)) {
    console.error("rune-action: no pull request to comment on (need --repo and --pr)");
    return 1;
  }

  const diff = collectDiff(inputs.workspace, inputs.baseRef, inputs.maxDiffChars);
  // The diff goes on DISK, not into the prompt. A 200k-character patch pasted
  // into a prompt is a context bill before the agent has read a single file,
  // and the agent has tools: it can read the part it needs.
  const patchPath = join(inputs.workspace, "DIFF.patch");
  writeFileSync(patchPath, diff || "(no changes against the base branch)\n");

  const prompt = inputs.prompt.trim() || DEFAULT_PROMPT;
  console.error(
    `rune-action: reviewing ${inputs.repo}#${inputs.prNumber} against ${inputs.baseRef} ` +
      `(${diff.length} chars of diff, gear ${inputs.gear}` +
      `${inputs.mock ? ", MOCK provider" : ""})`,
  );

  const mock = inputs.mock ? startMockProvider(mockReviewText(diff)) : null;
  let outcome: RunOutcome;
  try {
    outcome = await runReview(
      inputs,
      prompt,
      mock
        ? {
            argv: ["-p", "ollama", "-m", MOCK_MODEL],
            // Ollama authenticates nothing and reads its base URL from the
            // environment, so pointing it here is the whole of "use the mock".
            env: { OLLAMA_HOST: mock.host },
          }
        : {},
    );
  } finally {
    mock?.stop();
  }
  const comment = composeComment(outcome, inputs);

  // Always on stdout, posted or not: the CI log should hold what was said even
  // when posting fails, and the action step captures it as an output.
  console.log(comment);

  if (inputs.dryRun) {
    // A dry run reports whether it could produce a review, not whether the
    // review found anything.
    return outcome.ok ? 0 : 1;
  }

  if (!inputs.token) {
    console.error("rune-action: no GITHUB_TOKEN — the comment above was not posted");
    return 1;
  }
  const posted = await postComment(inputs.repo, inputs.prNumber, comment, inputs.token);
  console.error(`rune-action: ${posted.action} ${posted.url}`);
  return outcome.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
