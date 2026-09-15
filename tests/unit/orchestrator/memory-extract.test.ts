// The extractor's contract: the user's own words, machine-verified outcomes,
// and nothing else. Safety exit tests #1 (model prose never becomes a fact) and
// #2 (a claimed success on a `partial` run mints no positive lesson) live here.

import { describe, it, expect } from "bun:test";

import {
  extractFromRun,
  extractUserPreferences,
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

  it("still records an avoid lesson from a check that failed — an exit code is true either way", () => {
    const e = extractFromRun(
      run({
        outcome: { verdictKind: "partial" },
        checks: [{ command: "bun test tests/unit", passed: false }],
      }),
    );
    const avoid = e.candidates.filter((c) => c.text.startsWith("avoid:"));
    expect(avoid).toHaveLength(1);
    expect(avoid[0]!.source).toBe("verified-outcome");
    expect(avoid[0]!.evidence).toContain("check failed");
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
