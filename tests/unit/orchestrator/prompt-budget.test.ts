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
import { describe, expect, test } from "bun:test";
import {
  AGENT_DOCTRINE,
  FULL_DOCTRINE_CONTEXT,
  renderDoctrine,
  type DoctrineContext,
} from "../../../packages/orchestrator/src/prompts";
import { countTokens } from "../../../packages/orchestrator/src/tokenizer";

/**
 * Ceiling for the full doctrine with every section on. Set just above the
 * 2026-08-29 measurement of 7,461. LOWER this as sections are trimmed; raising
 * it means every request in the product got more expensive.
 */
const FULL_DOCTRINE_CEILING = 7_600;

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
    expect(renderDoctrine(MINIMAL).startsWith("You are Gear")).toBe(true);
  });

  test("no section is left with a dangling blank-line run", () => {
    expect(renderDoctrine(MINIMAL)).not.toMatch(/\n{3,}/);
  });
});
