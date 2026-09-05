/**
 * The prompt budget — a ratchet on fixed overhead.
 *
 * Every request carries the doctrine plus every tool schema before the
 * conversation even starts. Measured 2026-08-29: 10,905 tokens of instructions
 * plus 3,229 of tool schemas. Published comparisons put a minimal harness (Pi)
 * at under 1,000 for the same job and Claude Code at ~20,000, which makes this
 * the largest addressable inefficiency in the system.
 *
 * Nothing here judges whether the doctrine is GOOD — only that its size is a
 * decision someone made on purpose. The ceilings are a ratchet: they may be
 * lowered as sections are trimmed, and a rise has to be argued for in review
 * rather than discovered in a bill three months later.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  AGENT_DOCTRINE,
  FULL_DOCTRINE_CONTEXT,
  renderDoctrine,
  type DoctrineContext,
} from "../../../packages/orchestrator/src/prompts";
import { countTokens, tokenCounter } from "../../../packages/orchestrator/src/tokenizer";

// The counter is a process singleton: a calibration another suite taught it
// (tokenizer-calibration, context-honest-counting) re-scales every count here
// and turns these ceilings into a function of test-file ORDER. Measure with
// the calibration all real sessions start from.
beforeAll(() => {
  tokenCounter.resetCalibrations();
});

/**
 * Ceiling for the full doctrine with every section on. Set just above the
 * 2026-08-29 measurement of 7,461. LOWER this as sections are trimmed; raising
 * it means every request in the product got more expensive.
 *
 * Raised 7,600 → 7,620 on 2026-08-31 for the read_many batching line — argued,
 * not drifted: the same change set makes "jit" doctrine delivery the default,
 * which ships ~2,000 FEWER tokens per request than this ceiling measures, and
 * the batching line exists to cut round-trips, the larger cost by far.
 *
 * Raised 7,620 → 7,660 on 2026-08-31 for the storytelling narration register
 * (Communication rhythm): four worked example beats teach the voice the
 * transcript overhaul is built around, and after two compression passes the
 * section was 23 tokens over with nothing left to cut but the examples that
 * ARE the feature. The prose is cached after the first request of a session.
 *
 * Raised 7,660 → 7,700 on 2026-09-03 for the post-edit diagnostics line
 * (P10.1, Coding conventions). 43 tokens, and there were 8 of headroom, so it
 * could not be absorbed; two compression passes got it from 54 to 43 and the
 * remainder is the claim itself (the block is the language server's verdict on
 * what you just wrote, authoritative, fix it now). It buys back far more than
 * it costs: without it the model treats the block as advisory and the type
 * error travels to the verifier, which is a full re-read/re-edit/re-run cycle
 * — thousands of tokens, against 43 that are cached after the first request.
 *
 * Raised 7,700 -> 7,790 on 2026-09-03 for the narrative line (P11.1,
 * "Investigate before you act"). Measured 7,695 -> 7,771: 76 tokens, and there
 * were 5 of headroom, so it could not be absorbed; three compression passes
 * took it from 117 to 76 and the remainder is the instruction itself — name
 * the suspicion before testing it, record the commitment with its evidence,
 * and why refuted branches are kept. It is the one line that makes the
 * Decision Record possible: a run that never names a hypothesis produces a
 * record with no "how we got here", which is the section a person reads to
 * decide whether to believe the answer. Cached after the first request.
 */
const FULL_DOCTRINE_CEILING = 7_790;

/** Ceiling for a session that can use none of the gated capabilities. */
const MINIMAL_DOCTRINE_CEILING = 6_000;

const MINIMAL: DoctrineContext = {
  canDelegate: false,
  greenfield: false,
  buildsInterfaces: false,
};

describe("doctrine budget", () => {
  test("the full doctrine stays under its ceiling", () => {
    const tokens = countTokens(AGENT_DOCTRINE);
    expect(
      tokens,
      `AGENT_DOCTRINE is ${tokens} tokens, over the ${FULL_DOCTRINE_CEILING} ceiling. ` +
        `This ships on EVERY request. Either trim it, or raise the ceiling deliberately ` +
        `and say why in the commit.`,
    ).toBeLessThanOrEqual(FULL_DOCTRINE_CEILING);
  });

  test("a session that can use nothing gated pays materially less", () => {
    const full = countTokens(renderDoctrine(FULL_DOCTRINE_CONTEXT));
    const minimal = countTokens(renderDoctrine(MINIMAL));
    expect(minimal).toBeLessThanOrEqual(MINIMAL_DOCTRINE_CEILING);
    // The gating has to be worth having — a token or two is not.
    expect(full - minimal).toBeGreaterThan(1_200);
  });

  test("everything on is byte-identical to the doctrine itself", () => {
    // The default must never change behaviour. If this fails, the filter is
    // corrupting text rather than selecting sections.
    expect(renderDoctrine(FULL_DOCTRINE_CONTEXT)).toBe(AGENT_DOCTRINE.trimEnd());
  });

  test("each gate removes its own section and nothing else", () => {
    const cases: Array<[keyof DoctrineContext, string, string]> = [
      ["canDelegate", "# Delegation", "task sub-agents are read-only scouts"],
      ["greenfield", "# Greenfield builds", "applications are not pages"],
      ["buildsInterfaces", "# Building interfaces", "ONE art direction"],
    ];
    for (const [flag, heading, marker] of cases) {
      const ctx = { ...FULL_DOCTRINE_CONTEXT, [flag]: false } as DoctrineContext;
      const rendered = renderDoctrine(ctx);
      expect(rendered, `${flag} off should drop ${heading}`).not.toContain(heading);
      expect(rendered, `${flag} off should drop its body`).not.toContain(marker);
      // Every other gated section survives.
      for (const [, otherHeading] of cases.filter(([f]) => f !== flag)) {
        expect(rendered, `${flag} off must not disturb ${otherHeading}`).toContain(otherHeading);
      }
    }
  });

  test("ungated sections survive every combination", () => {
    // The judgement-shaped guidance is never dropped — a prompt that is cheap
    // and produces slop is not cheaper.
    const load = renderDoctrine(MINIMAL);
    for (const section of [
      "# Agency",
      "# Ambiguity",
      "# Doing tasks",
      "# Tool usage policy",
      "# Honesty",
      "# Finishing a task",
      "# Investigate before you act",
    ]) {
      expect(load, `${section} must never be gated`).toContain(section);
    }
  });

  test("the preamble is always kept", () => {
    expect(renderDoctrine(MINIMAL).startsWith("You are Rune")).toBe(true);
  });

  test("no section is left with a dangling blank-line run", () => {
    expect(renderDoctrine(MINIMAL)).not.toMatch(/\n{3,}/);
  });
});
