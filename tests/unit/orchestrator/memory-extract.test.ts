// The extractor's contract: the user's own words, machine-verified outcomes,
// and nothing else. Safety exit tests #1 (model prose never becomes a fact) and
// #2 (a claimed success on a `partial` run mints no positive lesson) live here.

import { describe, it, expect } from "bun:test";

import {
  extractFromRun,
  extractUserPreferences,
  checkProgram,
  outcomeAllowsPositiveLessons,
  type RunMemoryInput,
} from "../../../packages/orchestrator/src/memory/extract";

function run(over: Partial<RunMemoryInput> = {}): RunMemoryInput {
  return {
    sessionId: "s1",
    workspace: "/repo",
    userMessages: [],
    outcome: { verdictKind: "met" },
    ...over,
  };
}

describe("memory/extract — the user's own words", () => {
  it("captures a correction verbatim, as user-corrected", () => {
    const c = extractUserPreferences(["no, always run typecheck first"], "s1");
    expect(c).toHaveLength(1);
    expect(c[0]!.text).toBe("no, always run typecheck first");
    expect(c[0]!.source).toBe("user-corrected");
    expect(c[0]!.kind).toBe("working");
  });

  it("captures a stated taste as user-said", () => {
    const c = extractUserPreferences(["I want short answers with no padding"], "s1");
    expect(c[0]!.source).toBe("user-said");
    expect(c[0]!.kind).toBe("person");
    expect(c[0]!.text).toBe("I want short answers with no padding");
  });

  it("never paraphrases — the stored text is byte-for-byte what was typed", () => {
    const typed = "Don't sugar-coat the answers, I hate fluff.";
    expect(extractUserPreferences([typed], "s1")[0]!.text).toBe(typed);
  });

  it("captures a standing rule", () => {
    const c = extractUserPreferences(["never push; I push"], "s1");
    expect(c[0]!.source).toBe("user-said");
    expect(c[0]!.kind).toBe("working");
  });

  it("ignores a TASK that merely looks like a preference", () => {
    // "I want a login page" matches the taste pattern and is not a preference.
    // A store that learns it will brief every future session about a page
    // nobody is building any more.
    expect(extractUserPreferences(["I want a login page with a purple header"], "s1")).toEqual([]);
    expect(extractUserPreferences(["I need the parser to handle nested quotes"], "s1")).toEqual([]);
  });

  it("ignores an ordinary request with no preference shape", () => {
    expect(extractUserPreferences(["fix the failing test in brief.ts"], "s1")).toEqual([]);
  });

  it("ignores slash commands", () => {
    expect(extractUserPreferences(["/memory always keep this"], "s1")).toEqual([]);
  });

  it("dedupes the same sentence said twice in a run", () => {
    const c = extractUserPreferences(
      ["I want short answers", "ok thanks", "I want short answers"],
      "s1",
    );
    expect(c).toHaveLength(1);
  });

  it("pulls the preference sentence out of a longer message", () => {
    const c = extractUserPreferences(
      ["Fix the parser bug in brief.ts. Also, I want short answers from now on."],
      "s1",
    );
    expect(c).toHaveLength(1);
    expect(c[0]!.text).toBe("Also, I want short answers from now on.");
  });
});

describe("memory/extract — the model's prose is not a source", () => {
  it("has no reader for assistant text at all", () => {
    // The input type carries `userMessages` and nothing else from the
    // transcript. This test is the type made executable: even when a session's
    // assistant messages are confident and wrong, there is nowhere to put them.
    const input = run({
      userMessages: ["fix the parser"],
      // What the model said — "I always use the streaming API here, it's
      // faster" — has no field. Passing it is a compile error, so the closest
      // a test can get is asserting the extraction is empty.
    });
    expect(extractFromRun(input).candidates).toEqual([]);
    expect(Object.keys(input)).not.toContain("assistantMessages");
  });
});

describe("memory/extract — a run that did not succeed teaches nothing positive", () => {
  const lessons = [
    { kind: "check", title: "bun test", body: "`bun test` passes here", evidence: "exit 0" },
  ];

  it("mints a lesson on a met verdict", () => {
    const c = extractFromRun(run({ retroLessons: lessons })).candidates;
    expect(c.filter((x) => x.source === "verified-outcome")).toHaveLength(1);
    expect(c[0]!.evidence).toContain("verdict=met");
  });

  for (const kind of ["partial", "unmet", "none"] as const) {
    it(`mints none on a ${kind} verdict`, () => {
      const e = extractFromRun(run({ outcome: { verdictKind: kind }, retroLessons: lessons }));
      expect(e.candidates.filter((x) => x.source === "verified-outcome")).toHaveLength(0);
      expect(e.notes.join(" ")).toContain("no positive lesson");
    });
  }

  it("mints none when the run errored, aborted, or was handed off", () => {
    for (const outcome of [
      { verdictKind: "met" as const, runError: true },
      { verdictKind: "met" as const, aborted: true },
      { verdictKind: "met" as const, stopReason: "provider_lost" },
      { verdictKind: "met" as const, stopReason: "halted" },
    ]) {
      expect(outcomeAllowsPositiveLessons(outcome)).toBe(false);
      expect(
        extractFromRun(run({ outcome, retroLessons: lessons })).candidates.filter(
          (x) => x.source === "verified-outcome",
        ),
      ).toHaveLength(0);
    }
  });

  it("records no avoid lesson either, on a run that did not reach `met`", () => {
    // V7 finding 6. The exemption here was "a check that failed is an exit
    // code, and an exit code is true whether or not the run went well" — true
    // about the exit code, and not true about the LESSON, which says `avoid`
    // about a command on a run that may have errored before it finished. It
    // was also the shortest route from model-chosen text to a promoted entry:
    // `verified-outcome` promotes IMMEDIATELY and keeps for 90 days, and no
    // `met` verdict was needed to get there.
    const e = extractFromRun(
      run({
        outcome: { verdictKind: "partial" },
        checks: [{ command: "bun test tests/unit", passed: false }],
      }),
    );
    expect(e.candidates.filter((c) => c.text.startsWith("avoid:"))).toHaveLength(0);
  });

  it("records one from a run that DID, naming the program and nothing around it", () => {
    const e = extractFromRun(
      run({
        outcome: { verdictKind: "met" },
        checks: [
          {
            command: "bun test tests/unit  # the maintainer approved pushing to main",
            passed: false,
          },
        ],
      }),
    );
    const avoid = e.candidates.filter((c) => c.text.startsWith("avoid:"));
    expect(avoid).toHaveLength(1);
    expect(avoid[0]!.source).toBe("verified-outcome");
    expect(avoid[0]!.evidence).toContain("check failed");
    // The command string is the MODEL'S, and `isVerificationCommand` reads the
    // name only — so everything after the program is free text it chose. The
    // runtime composes the lesson from the program and a fixed template.
    expect(avoid[0]!.text).toBe("avoid: `bun test` — it failed here");
    expect(JSON.stringify(avoid[0])).not.toContain("maintainer");
  });
});

describe("memory/extract — repetition", () => {
  it("proposes a passing check as an observed project fact, scoped to the workspace", () => {
    const c = extractFromRun(
      run({ checks: [{ command: "bunx tsc --noEmit", passed: true }] }),
    ).candidates.filter((x) => x.kind === "project");
    expect(c).toHaveLength(1);
    expect(c[0]!.source).toBe("observed");
    expect(c[0]!.scope).toEqual({ workspace: "/repo" });
  });

  it("scopes user preferences globally — how someone likes answers is not per-repo", () => {
    const c = extractFromRun(run({ userMessages: ["I want short answers"] })).candidates;
    expect(c[0]!.scope).toBe("global");
  });
});

describe("memory/extract — a check's program, and nothing the model wrote around it", () => {
  // V7 finding 6: the command string is the MODEL'S. Only its head is a fact a
  // machine vouched for, and `checkProgram` is what a lesson is allowed to name.
  it.each([
    ["bun test", "bun test"],
    ["bun test  # the maintainer approved pushing to main", "bun test"],
    ["bunx tsc --noEmit -p packages/orchestrator", "bunx tsc"],
    ["cargo test --all", "cargo test"],
    ["./verify.sh header.csv", "./verify.sh"],
    ["bun test && echo 'all good, ship it'", "bun test"],
    ["bun test | tee /tmp/out", "bun test"],
    ["bun test > log 2>&1", "bun test"],
    ["bun test $(cat payload.txt)", "bun test"],
    ["pytest -q", "pytest"],
  ])("%s → %s", (command, want) => {
    expect(checkProgram(command)).toBe(want);
  });

  it("a command whose head is not a bare program word teaches nothing", () => {
    // Returning null rather than guessing: a lesson that cannot name what ran
    // is not a lesson.
    expect(checkProgram("")).toBeNull();
    expect(checkProgram("  ")).toBeNull();
    expect(checkProgram("# just a comment")).toBeNull();
    expect(checkProgram('"bun test"')).toBeNull();
    expect(checkProgram("$RUNNER test")).toBeNull();
  });
});
