/**
 * Phase 3B Lane C's ruler: what one request costs, in bytes, measured offline.
 *
 * `docs/program/phase-3-auto-efficiency.md` §5.2 names this instrument — a real
 * `rune-cli.ts` in its own process against `tests/helpers/mock-model-server.ts`,
 * whose `RecordedRequest.system` / `.messages` / `.raw` ARE the assembled
 * request, so no tokenizer estimate is needed on this path at all. §5.1 is why
 * it has to be this and not a replay of a stored session: the system prompt and
 * the ephemeral tail are never persisted, so a session log supports shape
 * replay and not a byte-exact reconstruction.
 *
 * Three numbers come out of one scripted run, and each one is a Lane C change's
 * before/after:
 *
 *  - **C1** — the bytes of each summarizer request. The run compacts TWICE (two
 *    provider-side context-length rejections, the lever §5.2 names), so the
 *    second compaction is an INCREMENTAL one: it has a prior state to merge
 *    into and must not re-read the window the first one already folded.
 *  - **C2** — the bytes of `system` per lead turn. Turn 1 is the opening
 *    doctrine, turn 2+ the working one; the gap is what the phase switch saves
 *    and the floor is what the working prompt costs on EVERY completion.
 *  - **§3.3** — prefix stability across consecutive requests. The design leaves
 *    open whether the ephemeral tail is replayed in a way that moves the
 *    cacheable prefix. On this host (Chat Completions) the tail rides as
 *    trailing user messages, so the answer must be "the prefix is stable up to
 *    the fold point"; the folding host's shape is asserted separately, in
 *    `tests/unit/gateway/prompt-composition-prefix.test.ts`, because
 *    `foldsEphemeralTail` is true only for codex and no mock can be one.
 *
 * **It needs the sandbox off** — `Bun.serve({port: 0})` fails under the
 * repository's restricted profile — and it needs the native tools binary, which
 * it reports as a FAILURE rather than skipping.
 *
 * **It spends nothing.** The child's home has one configured route, the
 * loopback mock, and `assertNoLiveCredentials` runs before the process starts.
 *
 * Set `LANE_C_MEASURE_OUT=<path>` to also write every number to a JSON file;
 * that is how the report's pinned before/after table was produced.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  startMockModelServer,
  type MockAction,
  type MockChatMessage,
  type RecordedRequest,
} from "../helpers/mock-model-server";
import * as S from "../helpers/scenario";
import { rmTemp } from "../helpers/tmp";

// ─── The pinned numbers ───
//
// Recorded at HEAD (`730fd97`, Lane 0 landed) by running this same file before
// either change, and re-recorded after. They are BYTES of UTF-8, from the
// request bodies the child actually sent.
//
// The assertions below are thresholds, not equalities: a byte count carries the
// workspace path and the fixture's own text, so an exact match would be a test
// about this machine. The exact values live in
// `.codex/audit-20260910/handoff/phase3/laneC-report.md`.

/**
 * C1 baseline — the FIRST compaction's summarizer request at HEAD, in bytes.
 *
 * The first compaction has no prior state to merge into: it reads the whole
 * head. Measured 16,023 at `730fd97`, 16,023 after C1, and 16,023 now — the
 * number that does not move, whatever happens to the merge.
 *
 * The SECOND compaction's history is the honest record of C1: 21,629 at
 * `730fd97` → 9,629 after C1 (39.9% under the first, which is what the lane
 * claimed) → 21,629 again now. C1 bought those 12,000 bytes by rendering the
 * merge's segment at 900 characters a tool result, and V-C showed that segment
 * is the previous compaction's verbatim tail plus everything since — material
 * the prior state has never seen, on its one and only read. There is no
 * lossless byte win there, so the saving is withdrawn.
 *
 * Both compactions fold the same fixture with the same script, so this is
 * reproducible anywhere `bun` and the native binary are: it depends on the
 * fixture's text and the clip constants, not on this machine.
 */
const C1_FIRST_COMPACTION_BYTES_AT_HEAD = 16_023;

/**
 * A floor, not a ceiling: the first compaction is the baseline and a collapse
 * in it would make any comparison against it true for the wrong reason.
 */
const C1_INCREMENTAL_CEILING = Math.floor(C1_FIRST_COMPACTION_BYTES_AT_HEAD * 0.7);

/**
 * What `clipText` keeps from the head of a clipped tool result at the SUMMARY
 * budget: 70% of 2,400. The merge budget would leave 630, so this one number
 * separates a request that read its segment from one that skimmed it.
 */
const SUMMARY_RESULT_HEAD_CHARS = 1_680;

/**
 * C2 baseline — the phase switch's saving, in bytes of `system`.
 *
 * The ABSOLUTE size of the system prompt is not assertable here and deliberately
 * is not asserted: a third of it is the skills catalog, which is whatever the
 * machine running the test has installed (9,293 bytes and 182 skills on the
 * founder's, and that is a finding in its own right — see the report). What IS
 * a property of `prompts.ts` is the difference between the two renderings, and
 * `tests/unit/orchestrator/doctrine-phase.test.ts` pins each of them to the
 * byte with no environment in the way.
 *
 * At `730fd97` the switch dropped 3,058 bytes (31,354 → 28,296 here). C2 moved
 * "# Built-in modes on request" to the opening as well, which adds 741 to the
 * saving on any run where a mode tool is loaded — and 0 on a run like this one,
 * where all three are catalog lines and the section never shipped at all.
 *
 * Re-measured 2026-10-06, after the prompt economy pass consolidated the
 * doctrine: the switch drops 2,784 bytes on this run. The opening-only sections
 * were cut along with everything else, so there is less of them to drop — the
 * whole prompt is about a third smaller, and that saving is paid on every
 * request rather than from the second one on.
 */
const C2_PHASE_SWITCH_SAVING_AT_HEAD = 2_784;

// ─── The script ───

function tool(name: string, args: Record<string, unknown>): MockAction {
  return { kind: "tools", calls: [{ name, args }] };
}

/**
 * Reads big enough to build a foldable head, then a provider-side rejection —
 * twice.
 *
 * `{kind: "context_length"}` is the lever §5.2 names: the loop force-compacts
 * and retries the turn (`agent-loop.ts:1811-1839`) under pressure it did not
 * choose, which is the path a long run actually takes. Each file is ~100 KB
 * (`scenario.ts` `bulkFiles`), and no path is read twice — the loop's repeat
 * detector refuses a duplicate call and would shift every later entry.
 */
const FIRST_PASS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `docs/note-${n}.md`);
const SECOND_PASS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `docs/extra-${n}.md`);

const LEAD_SCRIPT: MockAction[] = [
  ...FIRST_PASS.map((path) => tool("read_file", { path })),
  // → compaction #1: no prior state. The whole head is read, which is the
  //   baseline an incremental compaction has to beat.
  { kind: "context_length", limit: 100_000 },
  ...SECOND_PASS.map((path) => tool("read_file", { path })),
  // → compaction #2: a prior state exists, so this one is INCREMENTAL — and it
  //   folds MORE messages than the first one did, which makes the comparison
  //   below a conservative one.
  { kind: "context_length", limit: 100_000 },
  tool("bash", { command: "node check.mjs" }),
  { kind: "text", text: "Read the notes and ran node check.mjs. Done." },
];

/**
 * Enough distinct readable files for two full passes.
 *
 * `makeFixture` commits eight ~100 KB notes; the second pass needs eight more,
 * and they have to be DIFFERENT paths — the loop refuses a repeated call, which
 * would cost a request and shift every later script entry.
 */
function writeSecondPassFiles(root: string): void {
  for (let i = 1; i <= SECOND_PASS.length; i++) {
    const lines = [`# extra ${i}`, ""];
    for (let n = 0; n < 700; n++) {
      lines.push(
        `${n}. extra note ${i} records that the api and the client are separate modules, ` +
          "and that the version endpoint has to appear in both before the check can pass.",
      );
    }
    writeFileSync(join(root, "docs", `extra-${i}.md`), `${lines.join("\n")}\n`);
  }
}

const SUMMARIZER_SCRIPT: MockAction[] = [
  {
    kind: "text",
    text:
      "## Goals & requirements\nRead the notes under docs/ and run the acceptance check.\n" +
      "## Key facts & codebase knowledge\nsrc/api.ts and src/client.ts are separate modules.\n" +
      "## Actions taken & outcomes (files touched, commands run)\nRead docs/note-1.md through note-3.md.\n" +
      "## Decisions & open questions\nNone open.\n" +
      "## Current state & next step\nKeep reading the remaining notes, then run node check.mjs.",
  },
  {
    kind: "text",
    text:
      "## Goals & requirements\nRead the notes under docs/ and run the acceptance check.\n" +
      "## Key facts & codebase knowledge\nsrc/api.ts and src/client.ts are separate modules.\n" +
      "## Actions taken & outcomes (files touched, commands run)\nRead docs/note-1.md through note-7.md.\n" +
      "## Decisions & open questions\nNone open.\n" +
      "## Current state & next step\nRun node check.mjs.",
  },
];

// ─── Byte accounting on what was actually sent ───

const BYTES = new TextEncoder();
const bytes = (s: string): number => BYTES.encode(s).length;

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flatten).join(" ");
  if (content && typeof content === "object") {
    const part = content as Record<string, unknown>;
    if (typeof part.text === "string") return part.text;
    return JSON.stringify(part);
  }
  return "";
}

/**
 * The ephemeral tail, recognised on the wire.
 *
 * The loop rebuilds these three blocks for every request and never stores them
 * (`agent-loop.ts:1551-1556`); on a Chat Completions host they arrive as
 * trailing user messages, indistinguishable from the work except by their
 * opening marker. Everything BEFORE the first of them is the cacheable prefix —
 * the same seam `stableMessageCount` and `measureComposition` use.
 */
const TAIL_MARKERS = ["[Task state", "[Budget:", "[Team"];

function isTailMessage(m: MockChatMessage): boolean {
  if (m.role !== "user") return false;
  const text = flatten(m.content).trimStart();
  return TAIL_MARKERS.some((marker) => text.startsWith(marker));
}

/** How many leading messages of a request are NOT the ephemeral tail. */
function foldPoint(req: RecordedRequest): number {
  let n = req.messages.length;
  while (n > 0 && isTailMessage(req.messages[n - 1]!)) n--;
  return n;
}

/** The first index at which two requests' message arrays differ. */
function firstDivergence(a: RecordedRequest, b: RecordedRequest): number {
  const n = Math.min(a.messages.length, b.messages.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a.messages[i]) !== JSON.stringify(b.messages[i])) return i;
  }
  return n;
}

/** The transcript a summarizer request carried, without its instructions. */
function summarizerBytes(req: RecordedRequest): number {
  return bytes(req.messages.map((m) => flatten(m.content)).join("\n"));
}

// ─── The run ───

let dir = "";
let server: ReturnType<typeof startMockModelServer> | null = null;
let run: S.Run | null = null;
let lead: RecordedRequest[] = [];
let summarizers: RecordedRequest[] = [];

beforeAll(async () => {
  const toolsBin = S.requireNativeBinary();
  dir = mkdtempSync(join(tmpdir(), "rune-prompt-cost-"));
  const workdir = join(dir, "run");
  mkdirSync(workdir, { recursive: true });
  const fixture = S.makeFixture(workdir);
  writeSecondPassFiles(fixture.root);
  server = startMockModelServer({
    script: {
      lead: LEAD_SCRIPT,
      summarizer: SUMMARIZER_SCRIPT,
      utility: [{ kind: "text", text: "ok" }],
    },
    model: "fake-model",
  });
  const home = S.makeScratchHome(workdir, {
    baseUrl: server.baseUrl,
    model: "fake-model",
    maxTurns: 40,
    // One instance, no peers: the team block would otherwise vary with what
    // else is running on this machine, and this file measures bytes.
    team: false,
  });
  run = S.spawnRun({
    home,
    fixture,
    toolsBin,
    prompt: "Read every note under docs/, then run node check.mjs and report what it printed.",
  });
  server.attach(run.proc);
  await run.wait(180_000);
  lead = server.matching((r) => r.role === "lead");
  summarizers = server.matching((r) => r.role === "summarizer");
}, 240_000);

afterAll(() => {
  try {
    run?.kill();
  } catch {
    /* already gone */
  }
  server?.stop();
  rmTemp(dir);
});

test("the scripted run reached the mock and compacted twice", () => {
  expect(lead.length).toBeGreaterThan(4);
  // Two provider rejections, two forced compactions, two summarizer calls.
  expect(summarizers.length).toBeGreaterThanOrEqual(2);
});

test("C2 — the phase switch is the only prefix change, and it only ever drops", () => {
  const opening = bytes(lead[0]!.system);
  const working = bytes(lead[1]!.system);
  expect(working).toBeLessThan(opening);
  expect(opening - working).toBeGreaterThanOrEqual(C2_PHASE_SWITCH_SAVING_AT_HEAD);
  // Every later completion pays the working prompt, byte-identical — that is
  // what makes the switch one cache write per run rather than one per turn.
  for (const req of lead.slice(1)) expect(bytes(req.system)).toBe(working);
  // The opening rituals are gone from turn 2; the sections turn 2+ reads are
  // still there. "# Built-in modes on request" is NOT in either list: it routes
  // the user's words, a user's words can arrive on any turn (`interject`), and
  // it is capability-gated instead — absent from both phases here, where all
  // three mode tools are catalog lines. `doctrine-phase.test.ts` pins that.
  for (const section of ["# The read-back", "# Ambiguity"]) {
    expect(lead[1]!.system, `${section} is an opening ritual`).not.toContain(section);
  }
  for (const section of ["# Tool usage policy", "# Honesty", "# Finishing a task", "# Git"]) {
    expect(lead[1]!.system, `${section} is read on a working turn`).toContain(section);
  }
});

test("C1 — the merge carries the accumulated state and still reads its segment whole", () => {
  const first = summarizerBytes(summarizers[0]!);
  const second = summarizerBytes(summarizers[1]!);
  // It IS a merge: the state travels, not the old summary's prose re-compressed.
  expect(summarizers[1]!.text).toContain("PRIOR STATE:");
  // And it is read at first-read fidelity. `clipText` keeps 70% of its budget
  // from the head, so every clipped body here shows exactly 1,680 characters
  // before the marker on BOTH requests — the merge budget would show 630.
  // This is the assertion C1's byte win traded away: the segment a merge is
  // handed is new material, and this is its only read.
  for (const [nth, req] of [summarizers[0]!, summarizers[1]!].entries()) {
    const heads = [...req.text.matchAll(/\[result: ([\s\S]*?)\n…\[\d+ chars clipped\]/g)].map(
      (m) => m[1]!.length,
    );
    expect(heads.length, `request ${nth + 1} carried clipped results`).toBeGreaterThan(0);
    for (const head of heads) expect(head).toBe(SUMMARY_RESULT_HEAD_CHARS);
  }
  // The first compaction is the baseline and does not move.
  expect(first).toBeGreaterThan(C1_INCREMENTAL_CEILING);
  // The second is BIGGER, and honestly so: it folds the first one's verbatim
  // tail plus everything since — 15 messages against 7 — at the same fidelity.
  // C1 claimed 9,629 here by clipping that segment to 900 characters a body;
  // V-C showed the segment is material the prior state has never seen, so the
  // saving is withdrawn and the number is back to what it was at `730fd97`.
  expect(second).toBeGreaterThan(first);
});

test("§3.3 — the cacheable prefix is stable up to the fold point on a non-folding host", () => {
  // Consecutive lead requests in the WORKING phase: the system prompt is fixed
  // from turn 2, so any divergence here is a message, not the prompt.
  const pairs: Array<{ a: number; b: number; diverged: number; fold: number }> = [];
  for (let i = 1; i < lead.length - 1; i++) {
    const a = lead[i]!;
    const b = lead[i + 1]!;
    // A forced compaction rewrites history on purpose; it is the one place the
    // prefix is SUPPOSED to move, and the pair spanning it is not evidence
    // about the tail.
    if (b.messages.length <= a.messages.length) continue;
    pairs.push({ a: a.index, b: b.index, diverged: firstDivergence(a, b), fold: foldPoint(a) });
  }
  expect(pairs.length).toBeGreaterThan(0);
  for (const pair of pairs) {
    // Everything up to the fold point recurs verbatim: the tail is appended,
    // never folded into a message that has to be replayed bare next turn.
    expect(pair.diverged).toBeGreaterThanOrEqual(pair.fold);
  }
});

test("the measurement is written down", () => {
  const measured = {
    at: new Date().toISOString(),
    leadRequests: lead.length,
    summarizerRequests: summarizers.length,
    system: {
      opening: bytes(lead[0]!.system),
      working: bytes(lead[1]!.system),
      switchSaving: bytes(lead[0]!.system) - bytes(lead[1]!.system),
      pinnedSwitchSavingAtHead: C2_PHASE_SWITCH_SAVING_AT_HEAD,
    },
    conversation: lead.map((r) => ({
      index: r.index,
      messages: r.messages.length,
      bytes: bytes(r.messages.map((m) => flatten(m.content)).join("\n")),
    })),
    summarizer: summarizers.map((r, i) => ({
      nth: i + 1,
      bytes: summarizerBytes(r),
      hasPriorState: r.text.includes("PRIOR STATE:"),
    })),
    pinnedFirstCompactionAtHead: C1_FIRST_COMPACTION_BYTES_AT_HEAD,
    prefix: lead.slice(1, -1).map((a, i) => {
      const b = lead[i + 2];
      return b
        ? { a: a.index, b: b.index, diverged: firstDivergence(a, b), fold: foldPoint(a) }
        : null;
    }),
  };
  // Always on the console; to a file only when a caller asked for one.
  console.log(`[lane C] ${JSON.stringify(measured)}`);
  const out = process.env.LANE_C_MEASURE_OUT;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(measured, null, 2)}\n`);
    // The summarizer requests themselves, beside the numbers: the report has to
    // be able to say WHAT the incremental request carried, not only how big it
    // was. Scripted text and fixture prose only — nothing from this machine.
    summarizers.forEach((r, i) => {
      writeFileSync(
        join(dirname(out), `summarizer-${i + 1}.txt`),
        r.messages.map((m) => flatten(m.content)).join("\n"),
      );
    });
    // Both renderings of the system prompt, so the report's per-section byte
    // table is read off what was SENT rather than off a local re-render.
    writeFileSync(join(dirname(out), "system-opening.txt"), lead[0]!.system);
    writeFileSync(join(dirname(out), "system-working.txt"), lead[1]!.system);
  }
  expect(measured.leadRequests).toBeGreaterThan(0);
});
