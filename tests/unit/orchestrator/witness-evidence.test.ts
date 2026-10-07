/**
 * R1, the wiring: what a replayed witness is worth on the evidence ladder.
 *
 * `parent-check.test.ts` holds the replay itself to real trees. This file holds
 * the ladder to what it may do with the replay's answer — with a recorded
 * probe, so each case is exactly one answer and what was made of it.
 *
 * The rule under test: a check the run WROTE is worth `observed`, as it always
 * was, unless the runtime's own replay of that exact witness on the tree the
 * run started from failed there. Nothing the model says is an input to that.
 */

import { describe, expect, test } from "bun:test";

import {
  BriefLedger,
  CheckLog,
  briefFromArgs,
  createRecordEvidenceTool,
  rungForCommand,
  type Brief,
  type CitedRun,
  type ParentRun,
} from "../../../packages/orchestrator/src/brief";

const TEST = "src/http/retry.test.ts";
const COMMAND = `bun test ${TEST}`;
const W1 = "1".repeat(64);
const W2 = "2".repeat(64);

function brief(): Brief {
  return briefFromArgs(
    {
      reading: "You want a 429 to surface instead of disappearing into the retry loop.",
      touch: ["src/http/retry.ts"],
      leave: [],
      // It names the file it is about, so a check can be asked whether it reads it.
      done_when: ["src/http/retry.ts raises RateLimitError on a 429"],
    },
    "fix the retry thing, it's swallowing rate limits",
    "2026-10-04T00:00:00.000Z",
  );
}

/** A log in which `COMMAND` passed, and the run wrote the test it runs. */
function authoredLog(command = COMMAND, authored: string | undefined = TEST): CheckLog {
  const log = new CheckLog({ authoredThisTask: () => authored });
  log.record({ command, passed: true, at: 1, summary: "1 pass" });
  return log;
}

async function cite(
  log: CheckLog,
  probe: (
    command: string,
    cited?: CitedRun,
  ) => ParentRun | undefined | Promise<ParentRun | undefined>,
  options: { ledger?: BriefLedger; command?: string; signal?: AbortSignal } = {},
) {
  const ledger = options.ledger ?? new BriefLedger(brief());
  const tool = createRecordEvidenceTool(
    () => ledger,
    () => log,
    probe,
  );
  const result = await tool.execute({
    callId: "c",
    toolName: "record_evidence",
    args: { criterion: 0, command: options.command ?? COMMAND },
    sessionId: "s",
    workspaceRoot: "/tmp",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { ledger, criterion: ledger.criteria[0]!, text: String(result.result) };
}

const replayed = (status: ParentRun["status"], witness: string | undefined, reason?: string) =>
  ({
    command: COMMAND,
    status,
    commit: "abc12345",
    ...(reason ? { reason } : {}),
    ...(witness ? { witness, witnessFiles: [TEST] } : {}),
  }) satisfies ParentRun;

describe("a test the run wrote, on the evidence ladder", () => {
  test("replayed, and it failed on the tree the run started from: verified, by the replay", async () => {
    const seen: Array<CitedRun | undefined> = [];
    const { criterion, text } = await cite(authoredLog(), (_command, cited) => {
      seen.push(cited);
      return replayed("failed", W1, "1 assertion failed on the pre-task tree and pass now");
    });
    expect(seen).toEqual([{ authoredBy: TEST }]);
    expect(criterion.rung).toBe("verified");
    expect(criterion.evidence).toMatchObject({
      verifier: "witness-replay@1",
      parentCommitFailed: true,
      parentCommit: "abc12345",
      witness: W1,
      witnessFiles: [TEST],
      result: "passed",
    });
    expect(criterion.evidence!.detail).toContain(
      `this run wrote \`${TEST}\`; laid over the tree the run started from, the same test failed there and passes now`,
    );
    expect(text).toContain("Recorded as verified");
    expect(text).toContain("(1 of 1 criteria verified)");
  });

  test("replayed, and anything else: observed, with what the old tree did with it", async () => {
    for (const [status, reason] of [
      ["passed", "the same test passes on the pre-task tree — this change is not why it passes"],
      ["not-applicable-on-parent", "the test could not load on the pre-task tree"],
      ["inconclusive", "package.json changed since the pre-task tree"],
    ] as const) {
      const { criterion, text } = await cite(authoredLog(), () => replayed(status, W1, reason));
      expect({ status, rung: criterion.rung }).toEqual({ status, rung: "observed" });
      expect(criterion.evidence).toMatchObject({ verifier: "self-authored-check@1" });
      expect(criterion.evidence!.parentCommitFailed).toBeUndefined();
      expect(criterion.evidence!.witness).toBeUndefined();
      // The model is told why, so it does not spend a turn finding out.
      expect(text).toContain(`Replay on the tree the run started from: ${reason}.`);
    }
  });

  test("a command with no witness is told the one shape that is replayed", async () => {
    const { criterion, text } = await cite(authoredLog(), () => ({
      command: COMMAND,
      status: "not-applicable-on-parent",
      reason: "none — only `bun test <test files>` is replayed for a test this run wrote",
    }));
    expect(criterion.rung).toBe("observed");
    expect(text).toContain(
      "Replay on the tree the run started from: none — only `bun test <test files>` is replayed for a test this run wrote.",
    );
  });

  test("no replay to be had: exactly what it was before", async () => {
    let probes = 0;
    const { criterion, text } = await cite(authoredLog(), () => {
      probes++;
      return undefined;
    });
    expect(probes).toBe(1);
    expect(criterion.rung).toBe("observed");
    expect(criterion.evidence!.verifier).toBe("self-authored-check@1");
    expect(text).not.toContain("Replay on the tree");
    expect(text).toContain("a check the run authored cannot settle a criterion");
  });

  test("a `failed` with no witness behind it never lifts a check the run wrote", async () => {
    // What the old probe said of a file that was not there: a failure by absence.
    const { criterion } = await cite(authoredLog(), () => replayed("failed", undefined));
    expect(criterion.rung).toBe("observed");
    // …nor does one already on the record, taken before the run wrote into the test.
    const log = authoredLog();
    log.recordParent(replayed("failed", undefined));
    expect(rungForCommand(log, COMMAND)).toMatchObject({ rung: "observed" });
    expect(rungForCommand(log, COMMAND, { witness: W1 })).toMatchObject({ rung: "observed" });
  });

  test("the result is a result of one witness: edit the test and it lifts nothing", async () => {
    const log = authoredLog();
    // On record: the test as it WAS failed on the old tree.
    log.recordParent(replayed("failed", W1));
    // Priced with no witness in hand, or with another one, it is not about this test.
    expect(rungForCommand(log, COMMAND)).toMatchObject({ rung: "observed" });
    expect(rungForCommand(log, COMMAND, { witness: W2 })).toMatchObject({ rung: "observed" });
    expect(rungForCommand(log, COMMAND, { witness: W1 })).toMatchObject({ rung: "verified" });
    // Cited again after the edit: the test as it is NOW is replayed, and passes on the old tree.
    const { criterion } = await cite(log, () =>
      replayed("passed", W2, "it passes on the pre-task tree"),
    );
    expect(criterion.rung).toBe("observed");
    // And when the probe can give no answer this time, the old one does not stand in.
    const again = authoredLog();
    again.recordParent(replayed("failed", W1));
    expect((await cite(again, () => undefined)).criterion.rung).toBe("observed");
  });

  test("a standing claim about the test as it WAS gives way to the replay of the test as it is", async () => {
    const log = authoredLog();
    const ledger = new BriefLedger(brief());
    await cite(log, () => replayed("failed", W1), { ledger });
    expect(ledger.criteria[0]!.rung).toBe("verified");
    // Edited, run and cited again: the same command, another witness, and it passes on the old tree.
    const again = await cite(log, () => replayed("passed", W2, "it passes on the pre-task tree"), {
      ledger,
    });
    expect(again.text).toContain("Recorded as observed");
    expect(again.text).not.toContain("already verified");
    expect(ledger.criteria[0]).toMatchObject({
      rung: "observed",
      evidence: { verifier: "self-authored-check@1" },
    });
    // The same witness, cited again with a worse answer, does not lower anything by itself:
    // an answer nobody could give is not a finding.
    const steady = new BriefLedger(brief());
    await cite(log, () => replayed("failed", W1), { ledger: steady });
    const unknown = await cite(log, () => replayed("inconclusive", W1, "could not be laid out"), {
      ledger: steady,
    });
    expect(unknown.text).toContain("already verified");
    expect(steady.criteria[0]!.rung).toBe("verified");
    // Nor does a citation with no replay behind it at all.
    await cite(log, () => undefined, { ledger: steady });
    expect(steady.criteria[0]!.rung).toBe("verified");
  });

  test("every citation asks: the probe, not the log, decides whether it runs again", async () => {
    const log = authoredLog();
    let probes = 0;
    const probe = () => {
      probes++;
      return replayed("failed", W1);
    };
    const ledger = new BriefLedger(brief());
    await cite(log, probe, { ledger });
    await cite(log, probe, { ledger });
    expect(probes).toBe(2);
    expect(ledger.criteria[0]!.rung).toBe("verified");
  });

  test("the call's cancel signal reaches the replay", async () => {
    const controller = new AbortController();
    let got: AbortSignal | undefined;
    await cite(
      authoredLog(),
      (_command, cited) => {
        got = cited?.signal;
        return undefined;
      },
      { signal: controller.signal },
    );
    expect(got).toBe(controller.signal);
  });

  test("a witness about something else does not settle this criterion", async () => {
    // It failed on the old tree and passes now — and never reads the file this criterion is about.
    const elsewhere = "tests/unrelated/marker.test.ts";
    const command = `bun test ${elsewhere}`;
    const { criterion, text, ledger } = await cite(
      authoredLog(command, elsewhere),
      () => ({ ...replayed("failed", W1), command, witnessFiles: [elsewhere] }),
      { command },
    );
    // The rung does not move: the criterion is as unsettled as before the citation.
    expect(criterion.rung ?? null).toBeNull();
    expect(ledger.met).toBe(0);
    expect(text).toContain(
      "failed on the tree the run started from and passes now, but it does not speak to criterion 0",
    );
    expect(text).toContain("it never reads src/http/retry.ts");
    expect(text).toContain("set aside");
  });
});

describe("a check that existed before the run is asked as it always was", () => {
  test("once per command, with nothing said about authorship", async () => {
    const log = new CheckLog();
    log.record({ command: COMMAND, passed: true, at: 1, summary: "1 pass" });
    const seen: Array<CitedRun | undefined> = [];
    const probe = (_command: string, cited?: CitedRun) => {
      seen.push(cited);
      return { command: COMMAND, status: "failed" as const, commit: "abc12345" };
    };
    const ledger = new BriefLedger(brief());
    const first = await cite(log, probe, { ledger });
    await cite(log, probe, { ledger });
    expect(seen).toEqual([undefined]);
    expect(first.criterion.rung).toBe("verified");
    expect(first.criterion.evidence).toMatchObject({ verifier: "parent-probe@1" });
    expect(first.criterion.evidence!.witness).toBeUndefined();
  });

  test("the call's cancel signal reaches this replay too", async () => {
    const log = new CheckLog();
    log.record({ command: COMMAND, passed: true, at: 1, summary: "1 pass" });
    const controller = new AbortController();
    const seen: Array<CitedRun | undefined> = [];
    await cite(
      log,
      (_command, cited) => {
        seen.push(cited);
        return undefined;
      },
      { signal: controller.signal },
    );
    expect(seen).toEqual([{ signal: controller.signal }]);
  });

  test("a probe may answer later: the tool waits for it", async () => {
    const log = new CheckLog();
    log.record({ command: COMMAND, passed: true, at: 1, summary: "1 pass" });
    const { criterion } = await cite(
      log,
      () =>
        new Promise<ParentRun>((resolve) =>
          setTimeout(() => resolve({ command: COMMAND, status: "failed" }), 20),
        ),
    );
    expect(criterion.rung).toBe("verified");
  });
});
