/**
 * Phase 3B Lane 0's own acceptance check, end to end:
 *
 *     costRowsWithRoleTag == costRows
 *     userMsgWithOriginMarker == the scripted re-prompt count
 *
 * `docs/program/phase-3-auto-efficiency.md` §6 names exactly these two
 * equalities as how Lane 0 is verified, and §5.2 names the instrument: a real
 * `rune-cli.ts` in its own process against `tests/helpers/mock-model-server.ts`,
 * whose script decides every completion. Nothing is mocked but the model.
 *
 * The point of running it here rather than by hand is that the numbers come out
 * of a database a real engine wrote, read back by the SAME analysis script the
 * measurement used (`scripts/overhead-report.ts`, opened `readonly: true`) — not
 * out of an in-process fake that could agree with the instrumentation by
 * construction.
 *
 * **What each assertion here actually guarantees, honestly.** The two
 * mechanisms this script provokes were among the nine that already carried an
 * origin at `3c3ee67`, and the agent loop already tagged its own completions
 * `primary` there, so the two equalities above ALSO held at `3c3ee67` for a run
 * shaped like this one. What Lane 0 changed is that they can no longer stop
 * holding: `role` is required on the request, so an untagged caller is a
 * compile error, and the other ten synthetic messages are pinned by the source
 * law in `tests/unit/orchestrator/harness-attribution.test.ts` — a property
 * about ALL of them, which no single scripted run can show. The I3, I5 and I6
 * assertions below are the ones that fail outright at `3c3ee67`: latency,
 * prefix hash and the write verdict did not exist on those rows.
 *
 * **It needs the sandbox off** — `Bun.serve({port: 0})` fails with EADDRINUSE
 * under the repository's restricted profile — and it needs the native binary,
 * which it reports as a FAILURE rather than skipping.
 *
 * **It spends nothing.** The child's home has one configured route, the
 * loopback mock, and `assertNoLiveCredentials` runs on the environment before
 * the process starts.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMockModelServer, type MockAction } from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const OVERHEAD_SCRIPT = join(REPO_ROOT, "scripts", "overhead-report.ts");

/**
 * The re-prompts this script provokes, by origin.
 *
 * Both are harness mechanisms with a mechanical trigger, so the count is a
 * property of the script and not of what a model felt like doing:
 *
 *  - `nudge:empty-completion` — a completion with no content at all
 *    (`{kind: "empty"}`), which the loop answers by asking again.
 *  - `gate:execution-evidence` — a finish attempted after a file was written
 *    and nothing was ever executed, which the loop refuses exactly once.
 */
const SCRIPTED_REPROMPTS = ["nudge:empty-completion", "gate:execution-evidence"] as const;

function tool(name: string, args: Record<string, unknown>): MockAction {
  return { kind: "tools", calls: [{ name, args }] };
}

/**
 * One write, one empty completion, one premature finish, one real finish.
 *
 * The tail clamps on the last entry, so a run that takes more turns than this
 * still terminates — it answers "done" forever and the turn ceiling ends it.
 */
const LEAD_SCRIPT: MockAction[] = [
  tool("write_file", {
    path: "src/version.ts",
    content: 'export const VERSION = "1.0.0";\n',
  }),
  // → nudge:empty-completion
  { kind: "empty" },
  // → gate:execution-evidence (a write, and nothing executed to prove it)
  { kind: "text", text: "Added src/version.ts. Finished." },
  tool("bash", { command: "node check.mjs" }),
  { kind: "text", text: "Ran the acceptance check; it exits 0. Done." },
];

let dir = "";
let toolsBin = "";
let rig: { fixture: S.Fixture; home: S.ScratchHome } | null = null;
let server: ReturnType<typeof startMockModelServer> | null = null;
let run: S.Run | null = null;

beforeAll(async () => {
  toolsBin = S.requireNativeBinary();
  dir = mkdtempSync(join(tmpdir(), "rune-overhead-attr-"));
  const workdir = join(dir, "run");
  mkdirSync(workdir, { recursive: true });
  const fixture = S.makeFixture(workdir);
  server = startMockModelServer({ script: { lead: LEAD_SCRIPT }, model: "fake-model" });
  const home = S.makeScratchHome(workdir, { baseUrl: server.baseUrl, model: "fake-model" });
  rig = { fixture, home };
  run = S.spawnRun({
    home,
    fixture,
    toolsBin,
    prompt: "Add src/version.ts exporting VERSION, then run node check.mjs.",
  });
  server.attach(run.proc);
  await run.wait(120_000);
}, 180_000);

afterAll(() => {
  try {
    run?.kill();
  } catch {
    /* already gone */
  }
  server?.stop();
  rmTemp(dir);
});

/**
 * Run the analysis script against the scratch database, read-only.
 *
 * `--no-pilots` keeps `.codex/**` out of it, `--blackbox` points away from the
 * founder's incident store, and `--out` writes into the scratch directory, so
 * this test cannot touch `~/.rune` or the checked-in report.
 */
function overheadReport(dbPath: string): Record<string, any> {
  const out = join(dir, "report.json");
  const proc = Bun.spawnSync(
    [
      "bun",
      "run",
      OVERHEAD_SCRIPT,
      "--db",
      dbPath,
      "--no-pilots",
      "--blackbox",
      join(dir, "no-such-blackbox.db"),
      "--out",
      out,
    ],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `overhead-report.ts exited ${proc.exitCode}\n${proc.stderr.toString()}\n${proc.stdout.toString()}`,
    );
  }
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, any>;
}

test("the scripted run reached the mock and wrote a session database", () => {
  const home = rig!.home;
  expect(existsSync(home.dbPath)).toBe(true);
  // The mock answered; nothing reached a real provider.
  expect(server!.requests.length).toBeGreaterThan(0);
  expect(S.readEvents(home.dbPath).some((r) => r.type === "cost")).toBe(true);
});

test("I1 — every cost row the run wrote carries a role", () => {
  const report = overheadReport(rig!.home.dbPath);
  const { costRows, costRowsWithRoleTag } = report.source.corpus as {
    costRows: number;
    costRowsWithRoleTag: number;
  };
  expect(costRows).toBeGreaterThan(0);
  // The equality §6 names, measured through the analysis script itself.
  expect(costRowsWithRoleTag).toBe(costRows);
});

test("I1 — the roles on those rows come from the vocabulary the report maps", () => {
  // A role the script's TAG_TO_ROLE does not know would be counted as tagged
  // and then attributed by inference anyway, which is the silent failure this
  // equality is supposed to catch.
  const KNOWN = new Set([
    "primary",
    "classifier",
    "supervisor",
    "summarizer",
    "intent",
    "memory",
    "repair",
    "subagent",
    "research",
  ]);
  const roles = S.readEvents(rig!.home.dbPath)
    .filter((r) => r.type === "cost")
    .map((r) => r.payload.role);
  expect(roles.length).toBeGreaterThan(0);
  for (const role of roles) expect(KNOWN.has(String(role))).toBe(true);
});

test("I2 — the origin markers are exactly the re-prompts the script provoked", () => {
  const origins = S.readEvents(rig!.home.dbPath)
    .filter((r) => r.type === "user_msg" && typeof r.payload.harness === "string")
    .map((r) => String(r.payload.harness));
  expect(origins.sort()).toEqual([...SCRIPTED_REPROMPTS].sort());
});

test("I2 — userMsgWithOriginMarker equals the scripted re-prompt count", () => {
  const report = overheadReport(rig!.home.dbPath);
  expect(report.harnessFollowups.userMsgWithOriginMarker).toBe(SCRIPTED_REPROMPTS.length);
});

test("I3 — every cost row carries the provider's own latency, not an inferred gap", () => {
  const rows = S.readEvents(rig!.home.dbPath).filter((r) => r.type === "cost");
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(typeof row.payload.startedAt).toBe("string");
    expect(typeof row.payload.latencyMs).toBe("number");
    expect(Number(row.payload.latencyMs)).toBeGreaterThanOrEqual(0);
    expect(new Date(String(row.payload.startedAt)).getTime()).toBeLessThanOrEqual(
      new Date(String(row.payload.timestamp)).getTime(),
    );
  }
});

test("I5 — the agent's own rows carry the cache breakpoint and prefix hash they sent", () => {
  const compositions = S.readEvents(rig!.home.dbPath)
    .filter((r) => r.type === "cost")
    .map((r) => r.payload.composition as Record<string, unknown> | undefined)
    .filter((c): c is Record<string, unknown> => !!c);
  expect(compositions.length).toBeGreaterThan(0);
  for (const c of compositions) expect(String(c.prefixHash)).toMatch(/^[0-9a-f]{8}$/);
  // The prefix grows monotonically within one run, so consecutive turns differ.
  const hashes = compositions.map((c) => String(c.prefixHash));
  expect(new Set(hashes).size).toBeGreaterThan(1);
});

test("I6 — the write row says it changed something and the read rows say nothing", () => {
  const rows = S.readEvents(rig!.home.dbPath).filter((r) => r.type === "tool_result");
  expect(rows.length).toBeGreaterThan(0);
  const verdicts = rows.map((r) => r.payload.usefulEdit);
  // At least one write landed, and it is marked.
  expect(verdicts.filter((v) => v === true).length).toBeGreaterThan(0);
  // A non-write carries no verdict rather than a false one.
  expect(verdicts.some((v) => v === undefined)).toBe(true);
});

// ─── V-L0 #15 — a compaction run's harness-authored messages ───
//
// Two `role: "user"` messages are authored by `context-engine.ts` rather than
// by the user: the summary that replaces a folded segment, and the `[Session
// context]` block. Neither goes through `AgentLoop.appendMessage`, so neither
// could carry the origin `user_msg.harness` reads — and an untagged synthetic
// message that reaches persistence is filed as the USER'S OWN WORDS. The
// engine's `originOf` seam now falls back to the context engine's stamp, so
// the equality §6 names ("every persisted user_msg is the user's, or marked")
// holds on a run that compacts as well as on one that does not.
//
// The stamp itself is unit-pinned in
// `tests/unit/orchestrator/context-compaction-budget.test.ts`. This is the
// persisted half, on a real child: the script forces a compaction with a
// provider-side over-limit rejection, exactly as `prompt-cost.test.ts` does.

/** The fixture's own notes, read until the head is worth folding. */
const COMPACT_SCRIPT: MockAction[] = [
  ...[1, 2, 3, 4].map((n) => tool("read_file", { path: `docs/note-${n}.md` })),
  // The loop force-compacts and retries the turn: one summarizer call, one
  // `[Earlier conversation summary]` installed at the head of the working set.
  { kind: "context_length", limit: 100_000 },
  // …and then one ordinary harness re-prompt, so this run has a marked
  // `user_msg` row to compare the summary against rather than an empty set.
  { kind: "empty" },
  tool("bash", { command: "node check.mjs" }),
  { kind: "text", text: "Read the notes and ran node check.mjs. Done." },
];

const COMPACT_SUMMARIZER: MockAction[] = [
  {
    kind: "text",
    text:
      "## Goals & requirements\nRead the notes under docs/ and run the acceptance check.\n" +
      "## Key facts & codebase knowledge\nsrc/api.ts and src/client.ts are separate modules.\n" +
      "## Actions taken & outcomes (files touched, commands run)\nRead docs/note-1.md onward.\n" +
      "## Decisions & open questions\nNone open.\n" +
      "## Current state & next step\nRun node check.mjs.",
  },
];

let compacting: { home: S.ScratchHome; server: ReturnType<typeof startMockModelServer> } | null =
  null;

test("a run that compacts files no harness-authored message as the user's own words", async () => {
  const workdir = join(dir, "compaction");
  mkdirSync(workdir, { recursive: true });
  const fixture = S.makeFixture(workdir);
  const server = startMockModelServer({
    script: { lead: COMPACT_SCRIPT, summarizer: COMPACT_SUMMARIZER },
    model: "fake-model",
  });
  const home = S.makeScratchHome(workdir, {
    baseUrl: server.baseUrl,
    model: "fake-model",
    maxTurns: 16,
  });
  compacting = { home, server };
  const child = S.spawnRun({
    home,
    fixture,
    toolsBin,
    prompt: "Read the notes under docs/, then run node check.mjs.",
  });
  server.attach(child.proc);
  await child.wait(180_000);

  const events = S.readEvents(home.dbPath);
  // The run really did compact, with a summarizer, not a deterministic rescue.
  const compactions = events.filter((r) => r.type === "auto_compaction");
  expect(compactions.length).toBeGreaterThan(0);
  expect(compactions[0]!.payload.summaryFailure ?? null).toBeNull();
  expect(compactions[0]!.payload.tier).toBe("summarized");

  // The summary is durable — it rides the checkpoint that replaces the
  // replayed transcript, which is what a resume reads.
  const workingSet = JSON.stringify(compactions[0]!.payload.workingSet ?? []);
  expect(workingSet).toContain("[Earlier conversation summary]");

  // …and it is NOT a user turn. `listUserTurns` backs /rewind and the persisted
  // user text is fed to the permission check as TRUSTED input; the summary is
  // the summarizer's prose about tool output, which is precisely what a prompt
  // injection would aim at. Every persisted `user_msg` is either the user's one
  // message or a marked harness re-prompt.
  const userMsgs = events.filter((r) => r.type === "user_msg");
  expect(userMsgs.length).toBeGreaterThan(0);
  const unmarked = userMsgs.filter((r) => typeof r.payload.harness !== "string");
  expect(unmarked.map((r) => String(r.payload.content))).toEqual([
    "Read the notes under docs/, then run node check.mjs.",
  ]);
  for (const row of userMsgs) {
    const content = String(row.payload.content);
    expect(content.startsWith("[Earlier conversation summary]")).toBe(false);
    expect(content.startsWith("[Session context]")).toBe(false);
  }

  // The equality §6 names, on a compaction run: what the report counts as
  // origin-marked is exactly the set of harness rows in the database.
  const report = overheadReport(home.dbPath);
  const marked = userMsgs.length - unmarked.length;
  expect(marked).toBeGreaterThan(0);
  expect(report.harnessFollowups.userMsgWithOriginMarker).toBe(marked);
}, 240_000);

afterAll(() => {
  compacting?.server.stop();
});
