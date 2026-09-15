/**
 * Phase 5 F3 — the visual record: blind, rubric-bound, and never a score.
 *
 * Every reviewer call in this file is scripted. Nothing here reaches a
 * provider, and the test that matters most asserts the opposite: that with no
 * independent reviewer configured, the call is never made at all.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVisualReviewPrompt,
  modelFamily,
  parseVisualReview,
  pickVisualReviewer,
  preserveVisualReview,
  renderVisualReview,
  rubricRef,
  runVisualReview,
  stripScore,
  visualEvidenceDir,
  visualReviewCriterion,
  visualReviewEvidence,
  VISUAL_RUBRIC,
  type VisualCapture,
} from "../../../packages/orchestrator/src/visual-review";
import { criterionStatus } from "../../../packages/orchestrator/src/contract";

const CAPTURES: VisualCapture[] = [
  { path: "/w/shots/wide.png", width: 1440, label: "wide" },
  { path: "/w/shots/narrow.png", width: 390, label: "narrow" },
];

/** A reviewer that answers every criterion cleanly. */
function cleanReply(): string {
  return VISUAL_RUBRIC.criteria
    .map((c) => `${c.id}: pass — the ${c.name} reads clearly`)
    .join("\n");
}

describe("the rubric itself", () => {
  test("is versioned and carries the eight criteria the spec names", () => {
    expect(rubricRef()).toBe("visual-rubric@1");
    expect(VISUAL_RUBRIC.version).toBeGreaterThanOrEqual(1);
    expect(VISUAL_RUBRIC.criteria.map((c) => c.id).sort()).toEqual([
      "contrast",
      "focus-visibility",
      "hierarchy",
      "reference-consistency",
      "responsive-integrity",
      "spacing-rhythm",
      "state-clarity",
      "type-scale",
    ]);
    expect(VISUAL_RUBRIC.verdicts).toEqual(["pass", "fail", "unclear"]);
    for (const c of VISUAL_RUBRIC.criteria) {
      expect(c.asks.length).toBeGreaterThan(20);
      expect(c.fail_when.length).toBeGreaterThan(20);
    }
    // The rubric itself must not smuggle in a score.
    expect(JSON.stringify(VISUAL_RUBRIC)).not.toMatch(/\bweight(?:ing|ed)?\b\s*[:=]\s*\d/);
  });
});

describe("the reviewer is not the generating model", () => {
  test("model families are coarse, and an unknown model is never assumed independent", () => {
    expect(modelFamily("anthropic", "claude-opus-4-20250514")).toBe("claude");
    expect(modelFamily("openai", "gpt-5-codex")).toBe("gpt");
    expect(modelFamily("google", "gemini-2.5-pro")).toBe("gemini");
    // A different provider serving the same family is still the same family.
    expect(modelFamily("bedrock", "anthropic.claude-3-5-sonnet")).toBe(
      modelFamily("anthropic", "claude-3-5-sonnet"),
    );
    // Unrecognised ids fall back to the provider, so two unknown models from
    // one provider are never treated as independent of each other.
    expect(modelFamily("acme", "wonder-1")).toBe("provider:acme");
    expect(modelFamily("acme", "wonder-2")).toBe(modelFamily("acme", "wonder-1"));
  });

  test("a same-family candidate is skipped; a different family is taken", () => {
    const generator = { provider: "anthropic", model: "claude-opus-4" };
    expect(
      pickVisualReviewer({
        generator,
        candidates: [
          { provider: "anthropic", model: "claude-haiku-4" },
          { provider: "bedrock", model: "anthropic.claude-3-5-sonnet" },
          { provider: "openai", model: "gpt-5" },
        ],
      }),
    ).toEqual({ provider: "openai", model: "gpt-5" });
  });

  test("a session with one family has no reviewer", () => {
    expect(
      pickVisualReviewer({
        generator: { provider: "anthropic", model: "claude-opus-4" },
        candidates: [{ provider: "anthropic", model: "claude-sonnet-4" }],
      }),
    ).toBeNull();
    expect(
      pickVisualReviewer({
        generator: { provider: "openai", model: "gpt-5-codex" },
        candidates: [],
      }),
    ).toBeNull();
  });
});

describe("running the rubric", () => {
  test("with no independent reviewer it records the absence and makes NO call", async () => {
    let calls = 0;
    const record = await runVisualReview({
      captures: CAPTURES,
      reviewer: null,
      ask: async () => {
        calls++;
        return cleanReply();
      },
      now: () => new Date("2026-09-15T10:00:00.000Z"),
    });
    expect(calls).toBe(0);
    expect(record.verifier).toBeNull();
    expect(record.reason).toBe("no independent reviewer");
    expect(record.findings).toEqual([]);
    expect(record.defects).toEqual([]);
    // And there is nothing to record as evidence.
    expect(visualReviewEvidence(record)).toBeNull();
  });

  test("the reviewer is blind: the prompt carries the rubric and the captures, nothing else", async () => {
    let seen = "";
    await runVisualReview({
      captures: CAPTURES,
      reviewer: { provider: "openai", model: "gpt-5" },
      ask: async (prompt) => {
        seen = JSON.stringify(prompt);
        return cleanReply();
      },
    });
    for (const leak of [
      "Fieldnotes Studio",
      "calm editorial workspace",
      "the user asked",
      "art direction",
      "todo",
    ]) {
      expect(seen.toLowerCase()).not.toContain(leak.toLowerCase());
    }
    expect(seen).toContain("hierarchy");
    expect(seen).toContain("narrow");
    // Paths are reduced to basenames: the directory tree is context too.
    expect(seen).not.toContain("/w/shots");
    expect(seen).toContain("There is no number in a correct answer");
  });

  test("a clean review records the verifier and no defects", async () => {
    const record = await runVisualReview({
      captures: CAPTURES,
      reviewer: { provider: "openai", model: "gpt-5" },
      ask: async () => cleanReply(),
      now: () => new Date("2026-09-15T10:00:00.000Z"),
    });
    expect(record.verifier).toBe("visual-review@1:openai/gpt-5");
    expect(record.findings).toHaveLength(VISUAL_RUBRIC.criteria.length);
    expect(record.findings.every((f) => f.verdict === "pass")).toBe(true);
    expect(record.defects).toEqual([]);
    expect(visualReviewEvidence(record)).toEqual({
      verifier: "visual-review@1:openai/gpt-5",
      result: "passed",
      detail: "8 of 8 criteria pass, none fail",
    });
  });

  test("fails become the defect list; unanswered criteria become unclear, never pass", async () => {
    const record = await runVisualReview({
      captures: CAPTURES,
      reviewer: { provider: "openai", model: "gpt-5" },
      ask: async () =>
        [
          "hierarchy: fail — three cards compete at the same weight and nothing dominates",
          "contrast: fail — the placeholder text is barely legible on the card ground",
          "spacing-rhythm: pass — gaps repeat on one scale",
          "type-scale: unclear — the capture is cropped above the body text",
        ].join("\n"),
    });
    expect(record.findings.find((f) => f.id === "hierarchy")?.verdict).toBe("fail");
    expect(record.findings.find((f) => f.id === "focus-visibility")?.verdict).toBe("unclear");
    expect(record.findings.find((f) => f.id === "focus-visibility")?.quote).toContain(
      "did not answer",
    );
    expect(record.defects).toHaveLength(2);
    expect(record.defects[0]).toContain("three cards compete");
    expect(visualReviewEvidence(record)?.result).toBe("failed");
  });

  test("a reviewer that returns a score has the score stripped out", async () => {
    const record = await runVisualReview({
      captures: CAPTURES,
      reviewer: { provider: "openai", model: "gpt-5" },
      ask: async () =>
        [
          "Overall score: 7/10",
          "hierarchy: pass — score 8/10, the title dominates",
          "contrast: fail — rating: B+, the secondary text sits at 3:1 against the card",
        ].join("\n"),
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("7/10");
    expect(serialized).not.toContain("8/10");
    expect(serialized).not.toContain("B+");
    // Numbers ABOUT the screen survive — they are observations, not grades.
    expect(record.findings.find((f) => f.id === "contrast")?.quote).toContain("3:1");
    expect(record.findings.find((f) => f.id === "hierarchy")?.quote).toContain("title dominates");
  });

  test("stripScore removes grades and keeps measurements", () => {
    expect(stripScore("score: 85 the layout holds")).toBe("the layout holds");
    expect(stripScore("rated 4 out of 5 overall")).toContain("overall");
    expect(stripScore("rated 4 out of 5 overall")).not.toContain("4 out of 5");
    expect(stripScore("the 390px capture overflows by 12px")).toBe(
      "the 390px capture overflows by 12px",
    );
  });

  test("the prompt and the parser agree on the criterion ids", () => {
    const prompt = buildVisualReviewPrompt(CAPTURES);
    const ids = prompt.rubric.map((c) => c.id);
    const parsed = parseVisualReview(ids.map((id) => `${id}: pass — fine`).join("\n"));
    expect(parsed.map((f) => f.id)).toEqual(ids);
    expect(parsed.every((f) => f.verdict === "pass")).toBe(true);
  });
});

describe("the record is acceptance, not certification", () => {
  test("M1 derives needs_review from the review criterion, whatever the reviewer said", async () => {
    const record = await runVisualReview({
      captures: CAPTURES,
      reviewer: { provider: "openai", model: "gpt-5" },
      ask: async () => cleanReply(),
    });
    const criterion = visualReviewCriterion(record);
    expect(criterion.method.kind).toBe("review");
    expect(criterion.source).toBe("evaluator");
    // With a clean review and evidence attached, M1 still refuses to call it
    // satisfied: a second model supplements, it does not certify.
    const evidence = visualReviewEvidence(record)!;
    expect(
      criterionStatus(
        {
          ...criterion,
          evidence: {
            source: evidence.verifier,
            detail: evidence.detail,
            verifier: evidence.verifier,
            result: evidence.result,
            head: "abc1234",
            digest: "d",
          },
        } as never,
        [],
        null,
      ),
    ).toBe("needs_review");

    // Not vacuous: the same evidence on a command-method criterion is
    // assessable, so `needs_review` above came from `method: review`.
    expect(
      criterionStatus(
        {
          ...criterion,
          method: { kind: "command", command: "bun test" },
          evidence: {
            source: evidence.verifier,
            detail: evidence.detail,
            verifier: evidence.verifier,
            result: evidence.result,
            head: "abc1234",
            digest: "d",
          },
        } as never,
        [],
        null,
      ),
    ).toBe("satisfied");
  });
});

describe("preserving the record", () => {
  test("captures and the defect list are written together, and audit can name the directory", () => {
    const home = mkdtempSync(join(tmpdir(), "rune-visual-"));
    try {
      const shot = join(home, "wide.png");
      writeFileSync(shot, "not really a png");
      const dir = visualEvidenceDir("sess-123", home);
      expect(dir).toContain(join("evidence", "sess-123", "visual-review"));
      const record = {
        rubric: rubricRef(),
        verifier: "visual-review@1:openai/gpt-5",
        reviewedAt: "2026-09-15T10:00:00.000Z",
        captures: [shot, join(home, "gone.png")],
        findings: [
          {
            id: "hierarchy",
            name: "Hierarchy",
            verdict: "fail" as const,
            quote: "three cards compete",
          },
        ],
        defects: ["Hierarchy: three cards compete"],
      };
      const { files } = preserveVisualReview(record, dir);
      expect(files.some((f) => f.endsWith("wide.png"))).toBe(true);
      expect(files.some((f) => f.endsWith("visual-review.json"))).toBe(true);
      expect(files.some((f) => f.endsWith("defects.md"))).toBe(true);
      // A capture that no longer exists is dropped from the record rather than
      // recorded as preserved.
      const stored = JSON.parse(readFileSync(join(dir, "visual-review.json"), "utf-8"));
      expect(stored.captures).toEqual(["wide.png"]);
      const page = readFileSync(join(dir, "defects.md"), "utf-8");
      expect(page).toContain("visual-rubric@1");
      expect(page).toContain("three cards compete");
      expect(page).toContain("openai/gpt-5");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the rendered page says plainly when no reviewer ran", () => {
    const page = renderVisualReview({
      rubric: rubricRef(),
      verifier: null,
      reason: "no independent reviewer",
      reviewedAt: "2026-09-15T10:00:00.000Z",
      captures: [],
      findings: [],
      defects: [],
    });
    expect(page).toContain("Reviewer: none (no independent reviewer)");
    expect(page).toContain("No rubric findings were produced.");
  });
});

// ─── `rune audit` names the preserved record (Phase 5 F3) ───

describe("rune audit", () => {
  /** stdout, with SGR colour escapes removed. */
  async function auditPage(sessionId: string): Promise<string> {
    const { runAudit } = await import("../../../packages/orchestrator/src/bin/audit-cli");
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runAudit([sessionId], {});
    } finally {
      process.stdout.write = realWrite;
    }
    return written.join("").replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
  }

  async function sessionIn(home: string): Promise<string> {
    const { SessionManager } = await import("../../../packages/shared/src/session");
    const sessions = new SessionManager(join(home, "rune.db"));
    const session = sessions.createSession(home, "claude-sonnet-5", "anthropic");
    (sessions as { close?: () => void }).close?.();
    return session.id;
  }

  test("names the reviewer, the findings, the captures and where they are", async () => {
    const home = mkdtempSync(join(tmpdir(), "rune-audit-visual-"));
    const previous = process.env.RUNE_HOME;
    process.env.RUNE_HOME = home;
    try {
      const id = await sessionIn(home);
      const shot = join(home, "wide.png");
      writeFileSync(shot, "not really a png");
      preserveVisualReview(
        {
          rubric: rubricRef(),
          verifier: "visual-review@1:openai/gpt-5",
          reviewedAt: "2026-09-15T10:00:00.000Z",
          captures: [shot],
          findings: [
            {
              id: "hierarchy",
              name: "Hierarchy",
              verdict: "fail",
              quote: "three cards compete at the same weight",
            },
            {
              id: "contrast",
              name: "Contrast",
              verdict: "pass",
              quote: "the secondary text stays legible",
            },
          ],
          defects: ["Hierarchy: three cards compete at the same weight"],
        },
        visualEvidenceDir(id, home),
      );

      const page = await auditPage(id);
      expect(page).toContain("Visual review");
      expect(page).toContain("visual-rubric@1");
      expect(page).toContain("visual-review@1:openai/gpt-5");
      expect(page).toContain("fail Hierarchy");
      expect(page).toContain("three cards compete");
      expect(page).toContain("pass Contrast");
      expect(page).toContain("captures wide.png");
      // The directory, so the pictures can be opened beside the findings.
      expect(page).toContain(visualEvidenceDir(id, home));
      // No score is invented on the way to the page either.
      expect(page).not.toMatch(/Visual review[\s\S]{0,400}\b\d+\s*\/\s*\d+\b/);
    } finally {
      if (previous === undefined) delete process.env.RUNE_HOME;
      else process.env.RUNE_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a review that ran without an independent reviewer says so on the page", async () => {
    const home = mkdtempSync(join(tmpdir(), "rune-audit-none-"));
    const previous = process.env.RUNE_HOME;
    process.env.RUNE_HOME = home;
    try {
      const id = await sessionIn(home);
      preserveVisualReview(
        {
          rubric: rubricRef(),
          verifier: null,
          reason: "no independent reviewer",
          reviewedAt: "2026-09-15T10:00:00.000Z",
          captures: [],
          findings: [],
          defects: [],
        },
        visualEvidenceDir(id, home),
      );
      const page = await auditPage(id);
      expect(page).toContain("no independent reviewer");
      expect(page).toContain("no captures preserved");
    } finally {
      if (previous === undefined) delete process.env.RUNE_HOME;
      else process.env.RUNE_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session with no visual record prints nothing about one", async () => {
    const home = mkdtempSync(join(tmpdir(), "rune-audit-plain-"));
    const previous = process.env.RUNE_HOME;
    process.env.RUNE_HOME = home;
    try {
      const page = await auditPage(await sessionIn(home));
      expect(page).not.toContain("Visual review");
    } finally {
      if (previous === undefined) delete process.env.RUNE_HOME;
      else process.env.RUNE_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
