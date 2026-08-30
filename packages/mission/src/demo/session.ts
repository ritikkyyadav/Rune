// ─── Gear · the reference mission ───
// Eighteen minutes of autonomous work as the events that actually produced it: eight
// phases, five subagents, two findings, one decision that needed a human, and one
// integration failure that turned out not to be the agent's.
//
// It is written as events rather than as frames on purpose. Every row the demo draws
// has to survive the same reducer and the same projection the product uses, so a
// screen that could not happen in the real thing cannot be faked here either.

import { type DraftEvent } from "../events";

export interface Beat {
  /** seconds into the session */
  at: number;
  event: DraftEvent;
}

export const MISSION: Beat[] = [
  {
    at: 0,
    event: {
      type: "MISSION_OPENED",
      id: "m-4f2a",
      objective: "release-ready authentication",
      scope: ["src/auth/**", "src/middleware/**", "tests/auth/**"],
      exclusions: ["everything else in the tree"],
      budget: "no cap set · I stop and ask at 45 minutes",
      baseline: "8a3f1c2",
      criteria: [
        { id: "c1", text: "the three reported failures reproduce, then stop reproducing" },
        { id: "c2", text: "every fix has a test that failed before it" },
        { id: "c3", text: "nothing outside scope changes behaviour" },
        { id: "c4", text: "the security-touching diff is read by a second agent, cold" },
      ],
    },
  },
  {
    at: 2,
    event: {
      type: "PLAN_SET",
      revision: 1,
      steps: [
        { index: "01", title: "map the auth surface", dependsOn: [] },
        { index: "02", title: "reproduce the three reported failures", dependsOn: [] },
        { index: "03", title: "root cause", dependsOn: ["02"] },
        { index: "04", title: "the smallest fix that holds", dependsOn: ["03"] },
        { index: "05", title: "regression coverage", dependsOn: ["04"] },
        { index: "07", title: "independent review, cold", dependsOn: ["05"] },
        { index: "08", title: "full verification", dependsOn: ["07"] },
      ],
    },
  },

  // ── 02 · the failures reproduce ──────────────────────────────────────────────
  {
    at: 4,
    event: { type: "PHASE_OPENED", index: "02", title: "reproduce the three reported failures" },
  },
  {
    at: 4.2,
    event: {
      type: "TOOL_STARTED",
      id: "t-pytest",
      verb: "run",
      args: 'pytest tests/auth -k "oauth or refresh"',
      actor: "gear",
      phase: "02",
    },
  },
  { at: 5.0, event: { type: "TOOL_PROGRESS", id: "t-pytest", bytes: 2400, detail: "3 / 12" } },
  { at: 5.8, event: { type: "TOOL_PROGRESS", id: "t-pytest", bytes: 3100, detail: "7 / 12" } },
  { at: 6.6, event: { type: "TOOL_PROGRESS", id: "t-pytest", bytes: 2900, detail: "11 / 12" } },
  {
    at: 7.4,
    event: {
      type: "TOOL_ENDED",
      id: "t-pytest",
      exit: 1,
      detail: "2 failed",
      bytes: 9800,
      elapsedMs: 6200,
      rung: "observed",
    },
  },
  {
    at: 9.0,
    event: {
      type: "PHASE_CLOSED",
      index: "02",
      outcome: "met",
      summary: "two reproduce, deterministically. the third needs the reporter's build.",
      rung: "reproduced",
      elapsedMs: 112_000,
    },
  },

  // ── 03 · root cause, by a subagent with a scope and a budget ─────────────────
  { at: 10, event: { type: "PHASE_OPENED", index: "03", title: "root cause" } },
  {
    at: 10.2,
    event: {
      type: "AGENT_SPAWNED",
      id: "a-debug",
      role: "debug",
      objective: "why a valid session vanishes 100 ms later",
      scope: ["src/auth/**", "src/middleware/**"],
      tools: "read + run · no edits",
      budgetTokens: 40_000,
      phase: "03",
    },
  },
  {
    at: 13.5,
    event: {
      type: "AGENT_RETURNED",
      id: "a-debug",
      result: "returned",
      summary: "h3 confirmed · 5 of 5 with the delay injected",
      rung: "reproduced",
      elapsedMs: 123_000,
      tokens: 18_400,
    },
  },
  {
    at: 14.2,
    event: {
      type: "FINDING_OPENED",
      id: "f-02",
      claim: "the OAuth callback is not the bug",
      body: [
        "The callback completes and writes a valid session. Between 80 and",
        "140 ms later a token refresh that was already in flight lands and",
        "overwrites it with the state from before the callback.",
      ],
      evidence: [
        {
          kind: "file",
          path: "src/auth/session.ts",
          line: 188,
          note: "writes without checking generation",
        },
        { kind: "file", path: "src/middleware/session.ts", line: 74, note: "fires the refresh" },
        {
          kind: "reproduction",
          command: "a 100 ms delay injected into the refresh path",
          runs: 5,
          hits: 5,
        },
      ],
      rung: "reproduced",
      creates: "becomes 04 · closes 03 · unblocks nothing else",
      criteria: ["c1"],
    },
  },
  {
    at: 16,
    event: {
      type: "PHASE_CLOSED",
      index: "03",
      outcome: "met",
      summary: "root cause confirmed and reproducible on demand",
      rung: "reproduced",
      elapsedMs: 131_000,
    },
  },

  // ── the decision. the one screen that blocks, and admits it. ─────────────────
  {
    at: 17,
    event: {
      type: "DECISION_OPENED",
      id: "d-01",
      question: "Both fixes are correct. They differ in what they cost you later.",
      idleAgents: 2,
      queuedMs: 480_000,
      options: [
        {
          key: "A",
          title: "generation guard",
          cost: "3 files · +38 −14 · about 2 min",
          body: [
            "Stamp a generation on every write.",
            "A write carrying an older one is",
            "dropped on arrival.",
            "",
            "The race still exists in the code",
            "and is prevented at the boundary.",
            "4 new tests, all red first.",
          ],
          reversible: true,
        },
        {
          key: "B",
          title: "one writer",
          cost: "9 files · +210 −96 · about 25 min",
          body: [
            "One store owns every session",
            "write. The race stops being",
            "possible rather than being caught.",
            "",
            "Touches login, refresh and logout.",
            "Two tests assume the old order.",
            "Wants its own review pass.",
          ],
          reversible: true,
        },
      ],
      recommendation: "I would take A.",
      reasoning: [
        "The three failures are on this week's release and A closes them. B is the right",
        "change for the sprint after, and A does not make B harder — the guard becomes an",
        "assertion inside the single writer. Doing B now means asking a reviewer to read",
        "210 lines under release pressure, which is how the second bug gets in.",
      ],
    },
  },
  {
    at: 25,
    event: {
      type: "DECISION_TAKEN",
      id: "d-01",
      chosen: "A",
      by: "human",
      heldMs: 8000,
      note: "B is filed as a follow-up mission, with this comparison attached.",
    },
  },

  // ── 04 · the fix ─────────────────────────────────────────────────────────────
  { at: 26, event: { type: "PHASE_OPENED", index: "04", title: "the smallest fix that holds" } },
  {
    at: 27,
    event: {
      type: "CHANGE_APPLIED",
      path: "src/auth/session.ts",
      hunks: 2,
      added: 35,
      removed: 14,
      cause: "f-02",
      tests: ["session_race_test.ts"],
    },
  },
  {
    at: 28,
    event: {
      type: "CHANGE_APPLIED",
      path: "src/middleware/session.ts",
      hunks: 1,
      added: 8,
      removed: 6,
      cause: "f-02",
      tests: ["session_race_test.ts"],
    },
  },
  {
    at: 29,
    event: {
      type: "PHASE_CLOSED",
      index: "04",
      outcome: "met",
      summary: "38 lines across 2 files. nothing outside src/auth and src/middleware.",
      rung: "observed",
      elapsedMs: 101_000,
    },
  },

  // ── 05 · the tests that were red first ───────────────────────────────────────
  { at: 30, event: { type: "PHASE_OPENED", index: "05", title: "regression coverage" } },
  {
    at: 30.5,
    event: {
      type: "CHANGE_APPLIED",
      path: "tests/auth/session_race_test.ts",
      hunks: 1,
      added: 47,
      removed: 3,
      cause: "f-02",
      tests: [],
      newFile: true,
    },
  },
  {
    at: 31,
    event: {
      type: "CHECK_RESULT",
      kind: "the 6 new tests, on the parent commit",
      runner: "vitest",
      passed: 0,
      total: 6,
      baseline: "8a3f1c2",
      baselineFailed: true,
      elapsedMs: 4100,
      rung: "reproduced",
    },
  },
  {
    at: 32,
    event: {
      type: "CHECK_RESULT",
      kind: "the same 6, on the fix",
      runner: "vitest",
      passed: 6,
      total: 6,
      baseline: "8a3f1c2",
      baselineFailed: true,
      elapsedMs: 3800,
      rung: "verified",
    },
  },
  {
    at: 33,
    event: {
      type: "CRITERION_MET",
      id: "c2",
      detail: "6 tests · all red on 8a3f1c2",
      evidence: {
        kind: "test",
        command: "vitest tests/auth/session_race_test.ts",
        passed: 6,
        total: 6,
        baseline: "8a3f1c2",
        baselineFailed: true,
      },
    },
  },
  {
    at: 33.5,
    event: {
      type: "PHASE_CLOSED",
      index: "05",
      outcome: "met",
      summary: "every fix now has a test that was red before it",
      rung: "verified",
      elapsedMs: 134_000,
    },
  },

  // ── 06 · the finding it will not act on ──────────────────────────────────────
  {
    at: 35,
    event: {
      type: "FINDING_OPENED",
      id: "f-03",
      claim: "a rotated refresh token stays valid for 60 seconds",
      body: ["src/auth/token.ts:96 — the old jti is not revoked on rotation."],
      evidence: [
        { kind: "file", path: "src/auth/token.ts", line: 96, note: "the old jti is not revoked" },
        {
          kind: "reproduction",
          command: "replay a rotated token against a live session",
          runs: 3,
          hits: 3,
        },
      ],
      rung: "reproduced",
      criteria: [],
      outOfScope: true,
    },
  },

  // ── 08 · verification is a phase, not a footnote ─────────────────────────────
  { at: 37, event: { type: "PHASE_OPENED", index: "08", title: "full verification" } },
  {
    at: 37.5,
    event: {
      type: "CHECK_RESULT",
      kind: "typecheck",
      runner: "tsc",
      passed: 1,
      total: 1,
      elapsedMs: 4100,
      rung: "observed",
    },
  },
  {
    at: 38.5,
    event: {
      type: "CHECK_RESULT",
      kind: "unit",
      runner: "vitest",
      passed: 418,
      total: 418,
      elapsedMs: 31_200,
      rung: "observed",
    },
  },
  {
    at: 39.5,
    event: {
      type: "CHECK_RESULT",
      kind: "integration",
      runner: "vitest",
      passed: 59,
      total: 61,
      elapsedMs: 48_000,
      rung: "observed",
      failures: ["payment-session.test.ts", "auth-timeout.test.ts"],
    },
  },
  // Not "likely unrelated": it stashed the change and ran them on the parent commit.
  {
    at: 41,
    event: {
      type: "TOOL_STARTED",
      id: "t-baseline",
      verb: "run",
      args: "both tests on 8a3f1c2, my changes stashed",
      actor: "gear",
      phase: "08",
    },
  },
  { at: 41.8, event: { type: "TOOL_PROGRESS", id: "t-baseline", bytes: 1200, detail: "1 / 2" } },
  {
    at: 43,
    event: {
      type: "TOOL_ENDED",
      id: "t-baseline",
      exit: 1,
      detail: "both fail there too. they were red before I started.",
      bytes: 3400,
      elapsedMs: 22_000,
      rung: "reproduced",
    },
  },
  {
    at: 44,
    event: {
      type: "FINDING_OPENED",
      id: "f-05",
      claim: "2 integration tests were red before I started",
      body: ["Both fail on 8a3f1c2 with the change stashed."],
      evidence: [
        {
          kind: "reproduction",
          command: "the same two tests on the parent commit",
          runs: 2,
          hits: 2,
        },
      ],
      rung: "reproduced",
      criteria: [],
      outOfScope: true,
    },
  },
  {
    at: 45,
    event: {
      type: "CHECK_RESULT",
      kind: "build",
      runner: "vite",
      passed: 1,
      total: 1,
      elapsedMs: 18_900,
      rung: "observed",
    },
  },
  {
    at: 46,
    event: {
      type: "CRITERION_MET",
      id: "c1",
      detail: "2 fixed · 1 not reproducible",
      evidence: {
        kind: "test",
        command: "pytest tests/auth",
        passed: 2,
        total: 2,
        baseline: "8a3f1c2",
        baselineFailed: true,
      },
    },
  },
  {
    at: 46.2,
    event: {
      type: "CRITERION_MET",
      id: "c3",
      detail: "diff confined to 3 files",
      evidence: {
        kind: "test",
        command: "git diff --stat",
        passed: 3,
        total: 3,
        baseline: "8a3f1c2",
        baselineFailed: true,
      },
    },
  },
  {
    at: 46.4,
    event: {
      type: "CRITERION_MET",
      id: "c4",
      detail: "1 minor · 0 blockers",
      evidence: { kind: "review", actor: "review", blockers: 0, minors: 1 },
    },
  },
  {
    at: 47,
    event: {
      type: "PHASE_CLOSED",
      index: "08",
      outcome: "met",
      summary: "5 checks green · 1 red and demonstrably pre-existing",
      rung: "verified",
      elapsedMs: 182_000,
    },
  },
  { at: 47.5, event: { type: "CHECKPOINT", treeSha: "9c1e4b7", planRevision: 1, openAgents: [] } },
  { at: 48, event: { type: "MISSION_CONCLUDED", outcome: "concluded", elapsedMs: 1_122_000 } },
];

export const NOT_DONE = [
  "f-03 is real and I left it alone, because you scoped this to the login path and I",
  "would have had to touch token rotation to fix it. It is one command:",
  '   gear mission "revoke the old jti on refresh rotation"  --from f-03',
  "",
  'The third reported failure never reproduced here. I did not "fix" it. If it is the',
  "same bug it is fixed; if it is not, it is still open. I cannot tell from this",
  "machine and I am not going to claim otherwise.",
];

export const EVIDENCE = [
  "487 tests run · 6 written · all 6 fail on the parent commit",
  "reviewer: separate context, read the diff cold, never saw my reasoning",
  "integration suite: 2 failures, both present on 8a3f1c2 with the change stashed",
  "every claim above has an event id · /history --detailed · /export m-4f2a",
];
