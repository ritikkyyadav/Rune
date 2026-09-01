/**
 * The fallback reviewer must not be dying of the same thing as the primary.
 *
 * Observed live: a codex session's reviewer resolved to the heavy tier — also
 * codex — so the quota cap that killed the model killed its safety reviewer
 * in the same breath ("Independent reviewer unavailable: Codex request failed
 * (429)"), and every decision fell to mechanical containment. These tests pin
 * the widened policy: distinct healthy tier first, then another connected
 * funded/subscription provider, never free or local capacity, never past an
 * org-pinned classifier, and null (= mechanical containment) as the floor.
 */
import { describe, expect, test } from "bun:test";

import {
  pickFallbackReviewer,
  type ReviewerFallbackInputs,
} from "../../../packages/orchestrator/src/reviewer-fallback";

function inputs(overrides: Partial<ReviewerFallbackInputs> = {}): ReviewerFallbackInputs {
  return {
    primary: { provider: "codex", model: "gpt-5.6-sol" },
    tierRefs: [
      { provider: "codex", model: "gpt-5.6-sol" },
      { provider: "codex", model: "gpt-5.6-terra" },
    ],
    registered: ["codex", "anthropic", "openrouter", "ollama"],
    health: { pruned: [], cooling: [] },
    pinnedByPolicy: false,
    defaultModelFor: (p) =>
      ({ anthropic: "claude-opus-5", openrouter: "minimax/minimax-m3:free", ollama: "llama3.1" })[
        p
      ],
    capacityOf: (p) =>
      ({ codex: "subscription", anthropic: "funded", openrouter: "free", ollama: "local" })[p],
    policyDenies: () => null,
    now: 1_000_000,
    ...overrides,
  };
}

describe("pickFallbackReviewer", () => {
  test("a distinct healthy tier wins — the historical same-boundary retry", () => {
    expect(pickFallbackReviewer(inputs())).toEqual({ provider: "codex", model: "gpt-5.6-terra" });
  });

  test("when every tier shares the cooling primary, the retry widens to a funded provider", () => {
    const picked = pickFallbackReviewer(
      inputs({ health: { pruned: [], cooling: [{ provider: "codex", untilMs: 2_000_000 }] } }),
    );
    expect(picked).toEqual({ provider: "anthropic", model: "claude-opus-5" });
  });

  test("free and local capacity never review — containment beats a weak yes", () => {
    const picked = pickFallbackReviewer(
      inputs({
        registered: ["codex", "openrouter", "ollama"],
        health: { pruned: [], cooling: [{ provider: "codex", untilMs: 2_000_000 }] },
      }),
    );
    // Both remaining providers are free/local; the cooling distinct tier is
    // the last resort rather than a weak reviewer.
    expect(picked).toEqual({ provider: "codex", model: "gpt-5.6-terra" });
  });

  test("an org-pinned classifier never widens past the tiers", () => {
    const picked = pickFallbackReviewer(
      inputs({
        pinnedByPolicy: true,
        health: { pruned: [], cooling: [{ provider: "codex", untilMs: 2_000_000 }] },
      }),
    );
    expect(picked).toEqual({ provider: "codex", model: "gpt-5.6-terra" });
  });

  test("org policy denials are respected wherever the retry lands", () => {
    const picked = pickFallbackReviewer(
      inputs({
        health: { pruned: [], cooling: [{ provider: "codex", untilMs: 2_000_000 }] },
        policyDenies: (p) => (p === "anthropic" ? "denied by policy" : null),
      }),
    );
    expect(picked).toEqual({ provider: "codex", model: "gpt-5.6-terra" });
  });

  test("nothing usable returns null — mechanical containment is the floor", () => {
    const picked = pickFallbackReviewer(
      inputs({
        tierRefs: [{ provider: "codex", model: "gpt-5.6-sol" }],
        registered: ["codex"],
        health: { pruned: [], cooling: [{ provider: "codex", untilMs: 2_000_000 }] },
      }),
    );
    expect(picked).toBeNull();
  });

  test("an expired cooldown counts as healthy again", () => {
    const picked = pickFallbackReviewer(
      inputs({ health: { pruned: [], cooling: [{ provider: "codex", untilMs: 500 }] } }),
    );
    expect(picked).toEqual({ provider: "codex", model: "gpt-5.6-terra" });
  });
});
