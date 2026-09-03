/**
 * The GitHub Action, run the way CI runs it — minus the posting.
 *
 * An action whose first real execution is on somebody's pull request is an
 * action nobody has tested. `--dry-run` runs the entire body — collect the
 * diff, write DIFF.patch, run one headless turn, read the session back with
 * `gear audit`, compose the comment — and prints the comment instead of
 * posting it. Everything is real except the model.
 *
 * The comment's shape is asserted, not just its existence: the marker that
 * makes the bot edit one comment forever, the review text, and the audit
 * summary that turns "a bot said this" into "a bot said this, and here is its
 * receipt".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditSummary,
  changedFiles,
  collectDiff,
  composeComment,
  mockReviewText,
  parseInputs,
} from "../../action/review";

const repoRoot = join(import.meta.dir, "../..");
const ACTION = join(repoRoot, "action", "review.ts");
const CLI = join(repoRoot, "packages", "orchestrator", "src", "bin", "gear-cli.ts");
const RUST_BIN =
  process.env.GEAR_TOOLS_BIN ??
  [
    join(repoRoot, "target", "release", "gear-tools"),
    join(repoRoot, "target", "debug", "gear-tools"),
    join(process.env.HOME ?? "", ".gear", "bin", "gear-tools"),
  ].find((p) => existsSync(p)) ??
  "";
const HAS_RUST_BIN = RUST_BIN !== "" && existsSync(RUST_BIN);

const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
const sseText = (text: string): string =>
  chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";

function git(cwd: string, args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  }
}

let dir: string;
let repo: string;
let gearHome: string;
let model: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gear-action-"));
  repo = join(dir, "repo");
  gearHome = join(dir, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(gearHome, { recursive: true });

  // A repository with a base branch and one change on top of it, so the diff
  // the action collects is a real `merge-base` three-dot diff.
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "app.ts"), "export const total = (a: number, b: number) => a + b;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  // `origin/main` without a remote: the action diffs against it, and a test
  // that needed a network remote would not be a test of the action.
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  writeFileSync(join(repo, "app.ts"), "export const total = (a: number, b: number) => a - b;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "the change under review"]);
});

afterEach(() => {
  model?.stop(true);
  model = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("the action's pieces", () => {
  test("collects the change, not everything since the branch started", () => {
    const diff = collectDiff(repo, "main", 200_000);
    expect(diff).toContain("app.ts");
    expect(diff).toContain("a - b");
    // The base commit's own content is not part of this pull request.
    expect(diff).not.toContain("+export const total = (a: number, b: number) => a + b;");
  });

  test("says where a long diff stopped instead of pretending it is whole", () => {
    const diff = collectDiff(repo, "main", 40);
    expect(diff).toContain("[diff truncated at 40 characters");
  });

  test("reads the pull request number out of the event payload", () => {
    const event = join(dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 41 } }));
    const inputs = parseInputs([], {
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: "savoir/gear",
      GITHUB_WORKSPACE: repo,
    });
    expect(inputs.prNumber).toBe(41);
    expect(inputs.repo).toBe("savoir/gear");
  });

  test("a failed run is reported as a failed run, not as an empty review", () => {
    const comment = composeComment(
      { ok: false, text: "", exitCode: 1, sessionId: null, audit: null, stderrTail: "boom" },
      parseInputs([], { GITHUB_WORKSPACE: repo }),
    );
    expect(comment).toContain("did not complete");
    expect(comment).toContain("boom");
    // The marker is what makes the bot edit one comment forever instead of
    // starting a new thread on every push.
    expect(comment).toContain("<!-- gear-review -->");
  });

  test("strips ANSI out of the audit page", () => {
    const painted = "  [36mGear audit[0m [2m01a0[0m  fix the thing";
    expect(auditSummary(painted)).toBe("Gear audit 01a0  fix the thing");
  });

  test("a mock run says it is one, before it says anything else", () => {
    // The ethics of the mode. A comment that looks like a review and was
    // produced by a mock is worse than no comment at all.
    const outcome = {
      ok: true,
      text: "anything at all",
      exitCode: 0,
      sessionId: "s1",
      audit: null,
      stderrTail: "",
    };
    const comment = composeComment(outcome, {
      ...parseInputs([], { GITHUB_WORKSPACE: repo }),
      mock: true,
    });
    expect(comment).toContain("### Gear review — dry run (mock provider)");
    expect(comment).toContain("**mock provider**");
    expect(comment).toContain("nothing whatever about the change");
    expect(comment).toContain("mock provider, no model consulted");
    // …and the marker still keys the same one comment, so a real review
    // REPLACES the dry run rather than starting a second thread under it.
    expect(comment).toContain("<!-- gear-review -->");

    const real = composeComment(outcome, parseInputs([], { GITHUB_WORKSPACE: repo }));
    expect(real).toContain("### Gear review\n");
    expect(real).not.toContain("mock provider");
  });

  test("reads the mock switch from the workflow's environment, and only that word", () => {
    expect(parseInputs([], { GEAR_REVIEW_PROVIDER: "mock", GITHUB_WORKSPACE: repo }).mock).toBe(
      true,
    );
    // A typo must fail loudly on a missing key, not quietly post a fake review.
    expect(parseInputs([], { GEAR_REVIEW_PROVIDER: "Mock", GITHUB_WORKSPACE: repo }).mock).toBe(
      false,
    );
    expect(parseInputs([], { GITHUB_WORKSPACE: repo }).mock).toBe(false);
    expect(parseInputs(["--mock"], { GITHUB_WORKSPACE: repo }).mock).toBe(true);
  });

  test("the mock's answer names the files the diff touched, and nothing it did not read", () => {
    const diff = collectDiff(repo, "main", 200_000);
    expect(changedFiles(diff)).toEqual(["app.ts"]);
    const text = mockReviewText(diff);
    expect(text).toContain("No model was consulted");
    expect(text).toContain("`app.ts`");
    // A deletion has no post-image path and must not become a file called
    // "/dev/null" in the comment.
    expect(changedFiles("--- a/gone.ts\n+++ /dev/null\n")).toEqual([]);
  });
});

describe("the action end to end, against a fake model", () => {
  test.skipIf(!HAS_RUST_BIN)(
    "dry run prints a review comment with the audit under it",
    async () => {
      model = Bun.serve({
        port: 0,
        fetch: async (req) => {
          if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
            return new Response("not found", { status: 404 });
          }
          await req.text();
          return new Response(
            sseText(
              "The change flips `+` to `-` in `total`, which inverts the function. " +
                "INSPECTED only: I did not run the tests.",
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });

      writeFileSync(
        join(gearHome, "model.json"),
        JSON.stringify({ provider: "custom", model: "fake-model" }),
      );
      writeFileSync(
        join(gearHome, "secrets.json"),
        JSON.stringify({
          custom: {
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            model: "fake-model",
            key: "fake-key-the-test-server-ignores",
          },
        }),
        { mode: 0o600 },
      );

      const p = Bun.spawn(
        [
          "bun",
          ACTION,
          "--dry-run",
          "--workspace",
          repo,
          "--base",
          "main",
          "--gear",
          "2",
          "--gear-cmd",
          `bun ${CLI}`,
        ],
        {
          env: {
            ...process.env,
            GEAR_HOME: gearHome,
            GEAR_WORKSPACE: repo,
            GEAR_DB_PATH: join(dir, "gear.db"),
            GEAR_TOOLS_BIN: RUST_BIN,
            NO_COLOR: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = await new Response(p.stdout).text();
      const err = await new Response(p.stderr).text();
      const code = await p.exited;

      expect(code, `stderr:\n${err}`).toBe(0);
      expect(out).toContain("<!-- gear-review -->");
      expect(out).toContain("### Gear review");
      expect(out).toContain("inverts the function");
      expect(out).toContain("What the run actually did");
      // The receipt half. Without it the comment is just a model's opinion.
      expect(out).toContain("Gear audit");
      // The diff is handed over as a file, not pasted into the prompt.
      expect(existsSync(join(repo, "DIFF.patch"))).toBe(true);
    },
    180_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "the mock provider runs the whole path with no credential anywhere",
    async () => {
      // The mode `.github/workflows/gear-review.yml` uses when
      // `GEAR_REVIEW_API_KEY` is absent, which on this repository is always.
      // Nothing here configures a model: `review.ts` starts its own provider,
      // which is the point — the workflow needs no secret and no setup step.
      const p = Bun.spawn(
        [
          "bun",
          ACTION,
          "--dry-run",
          "--mock",
          "--workspace",
          repo,
          "--base",
          "main",
          "--gear",
          "2",
          "--gear-cmd",
          `bun ${CLI}`,
        ],
        {
          env: {
            ...process.env,
            GEAR_HOME: gearHome,
            GEAR_WORKSPACE: repo,
            GEAR_DB_PATH: join(dir, "gear.db"),
            GEAR_TOOLS_BIN: RUST_BIN,
            NO_COLOR: "1",
            // Deliberately blank: a run that quietly fell back to a real
            // provider would be a run that needs a key after all.
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
            OPENROUTER_API_KEY: "",
            GOOGLE_API_KEY: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = await new Response(p.stdout).text();
      const err = await new Response(p.stderr).text();
      const code = await p.exited;

      expect(code, `stderr:\n${err}`).toBe(0);
      expect(err).toContain("MOCK provider");
      // Labelled, in the heading and in the footer, so neither a reader nor a
      // notification can mistake it for a review.
      expect(out).toContain("### Gear review — dry run (mock provider)");
      expect(out).toContain("mock provider, no model consulted");
      // …and it is still a real run: a session, a turn, and the audit of it.
      expect(out).toContain("No model was consulted");
      expect(out).toContain("`app.ts`");
      expect(out).toContain("What the run actually did");
      expect(out).toContain("Gear audit");
    },
    180_000,
  );
});
