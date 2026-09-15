/**
 * Who may review the generating model's work, and whose word establishes a
 * preview origin.
 *
 * Two v7 findings, both about a claim of independence that was not one.
 *
 * `pickVisualReviewer` returned the first candidate from a different family,
 * and `modelFamily`'s `gpt` probe required a non-letter before "gpt" — so
 * `openai/chatgpt-4o-latest`, a real OpenAI id, fell through to
 * `provider:openai` and read as independent of `openai/gpt-4o`. OpenAI's own 4o
 * checkpoint was picked to review OpenAI's 4o: the correlated self-review the
 * module exists to forbid, passing the type.
 *
 * And a delegated child's served origin never reached the lead, so the lead's
 * real screenshot of the real page was discarded. The answer is not to take
 * the child's word — see below.
 */

import { describe, expect, test } from "bun:test";
import type { ToolCallOutput } from "@rune/tool-registry";

import {
  independentOf,
  modelFamily,
  pickVisualReviewer,
  stripScore,
} from "../../../packages/orchestrator/src/visual-review";
import { VisualVerification } from "../../../packages/orchestrator/src/visual-verification";

describe("independence is by model lineage, not by provider id", () => {
  test("a vendor's own checkpoint is the same family, however it is spelled", () => {
    expect(modelFamily("openai", "gpt-4o")).toBe("gpt");
    expect(modelFamily("openai", "chatgpt-4o-latest")).toBe("gpt");
    expect(modelFamily("anthropic", "claude-sonnet-4-5")).toBe("claude");
    expect(modelFamily("anthropic", "sonnet-4-5")).toBe("claude");
  });

  test("a Claude model behind another gateway is still Anthropic's model", () => {
    // The blind spots belong to the model, not to whoever resells it.
    expect(modelFamily("openrouter", "anthropic/claude-3-5-sonnet")).toBe("claude");
    expect(modelFamily("bedrock", "anthropic.claude-3-5-sonnet")).toBe("claude");
    expect(
      pickVisualReviewer({
        generator: { provider: "anthropic", model: "claude-opus-4-1" },
        candidates: [{ provider: "openrouter", model: "anthropic/claude-3-5-sonnet" }],
      }),
    ).toBeNull();
  });

  test("the same vendor's other checkpoint is never the reviewer, either way round", () => {
    expect(
      pickVisualReviewer({
        generator: { provider: "openai", model: "gpt-4o" },
        candidates: [{ provider: "openai", model: "chatgpt-4o-latest" }],
      }),
    ).toBeNull();
    expect(
      pickVisualReviewer({
        generator: { provider: "openai", model: "chatgpt-4o-latest" },
        candidates: [{ provider: "openai", model: "gpt-4o" }],
      }),
    ).toBeNull();
  });

  test("an unrecognised id is not independent of anything from the same provider", () => {
    // Fail-closed for unknown-vs-KNOWN, which is where it used to fail open:
    // `provider:openai` and `gpt` are different strings, and that difference
    // was being read as independence.
    expect(
      independentOf(
        { provider: "openai", model: "gpt-4o" },
        { provider: "openai", model: "some-unreleased-thing" },
      ),
    ).toBe(false);
    expect(
      independentOf({ provider: "acme", model: "alpha" }, { provider: "acme", model: "beta" }),
    ).toBe(false);
  });

  test("different providers and different lineages still produce a reviewer", () => {
    // The rule must not refuse every review: that would be a module that never
    // runs, which is indistinguishable from one that does not work.
    expect(
      pickVisualReviewer({
        generator: { provider: "openai", model: "gpt-5" },
        candidates: [{ provider: "anthropic", model: "claude-opus-4-1" }],
      }),
    ).toEqual({ provider: "anthropic", model: "claude-opus-4-1" });
    // And one gateway serving two different vendors is two lineages, so the
    // rule is about the model and not about the account.
    expect(
      pickVisualReviewer({
        generator: { provider: "openrouter", model: "openai/gpt-5" },
        candidates: [{ provider: "openrouter", model: "anthropic/claude-opus-4-1" }],
      }),
    ).toEqual({ provider: "openrouter", model: "anthropic/claude-opus-4-1" });
  });

  test("the first independent candidate wins, in the caller's preference order", () => {
    expect(
      pickVisualReviewer({
        generator: { provider: "openai", model: "gpt-5" },
        candidates: [
          { provider: "openai", model: "chatgpt-4o-latest" },
          { provider: "google", model: "gemini-3-pro" },
          { provider: "anthropic", model: "claude-opus-4-1" },
        ],
      }),
    ).toEqual({ provider: "google", model: "gemini-3-pro" });
  });
});

// ─── A child's served origin ───

const ok = (result: string, extra: Partial<ToolCallOutput> = {}): ToolCallOutput =>
  ({ success: true, result, ...extra }) as ToolCallOutput;

const SCREENSHOT = ok("Page URL: http://localhost:4173/\nScreenshot captured.", {
  attachments: [{ kind: "image", path: "/tmp/shot.png" }],
} as Partial<ToolCallOutput>);

const PAGE = "<!doctype html><html><body><h1>Contact</h1></body></html>";

describe("a delegated child's origin is a claim the lead re-probes", () => {
  const delegated = () => {
    const lead = new VisualVerification("/tmp/ws", undefined, { browser: true });
    lead.changed();
    lead.observe(
      "worker",
      { prompt: "build and serve the page" },
      ok("Sub-agent finished. Dev server is up at http://localhost:4173/ — 3 files changed."),
      true,
    );
    return lead;
  };

  test("the child's word alone establishes nothing", () => {
    // Deliberate, and the safe end of the choice: the lead never saw that
    // server. "Something on this machine answers on :4173" is precisely what
    // the ownership rule refuses, and delegation does not change it.
    const lead = delegated();
    expect(lead.snapshot().origins).toEqual([]);
    expect(lead.observe("mcp_browser_take_screenshot", {}, SCREENSHOT, true)).toBe(false);
  });

  test("the lead's own fetch of the claimed origin promotes it, and the screenshot then counts", () => {
    const lead = delegated();
    expect(
      lead.observe("bash", { command: "curl -s http://localhost:4173/", cwd: "." }, ok(PAGE), true),
    ).toBe(true);
    expect(lead.snapshot().origins).toEqual(["http://localhost:4173"]);
    expect(lead.observe("mcp_browser_take_screenshot", {}, SCREENSHOT, true)).toBe(true);
    expect(lead.snapshot().captures.length).toBe(2);
  });

  test("a re-probe that does not return a page promotes nothing", () => {
    const lead = delegated();
    lead.observe(
      "bash",
      { command: "curl -s http://localhost:4173/", cwd: "." },
      ok("curl: (7) Failed to connect to localhost port 4173"),
      true,
    );
    expect(lead.snapshot().origins).toEqual([]);
    expect(lead.observe("mcp_browser_take_screenshot", {}, SCREENSHOT, true)).toBe(false);
  });

  test("an origin no child ever claimed is not promoted by fetching it", () => {
    // The lead cannot bootstrap ownership of some other app on this machine by
    // curling it: nothing pointed at that origin, so there is no claim to
    // re-probe and no capture.
    const lead = new VisualVerification("/tmp/ws", undefined, { browser: true });
    lead.changed();
    expect(
      lead.observe("bash", { command: "curl -s http://localhost:9999/", cwd: "." }, ok(PAGE), true),
    ).toBe(false);
    expect(lead.snapshot().origins).toEqual([]);
  });

  test("the lead starting the server itself is unchanged", () => {
    const solo = new VisualVerification("/tmp/ws", undefined, { browser: true });
    solo.changed();
    solo.observe(
      "bash",
      { command: "bun run dev", cwd: "." },
      ok("Local:  http://localhost:4173/"),
      true,
    );
    expect(solo.observe("mcp_browser_take_screenshot", {}, SCREENSHOT, true)).toBe(true);
  });
});

// ─── Never a score ───

describe("a reviewer's number is stripped, and its measurements are not", () => {
  test("a ratio goes whole, with no bare denominator left behind", () => {
    // The strip used to run the keyword rule first, which ate "score: 8" and
    // left the ratio rule nothing to match — so the number was removed and the
    // score was still legible as "/10".
    expect(stripScore("headings are flat. score: 8/10")).toBe("headings are flat.");
    expect(stripScore("headings are flat. Overall: 8/10")).toBe("headings are flat.");
    expect(stripScore("rated 4 out of 5 overall")).not.toContain("4 out of 5");
  });

  test("the shapes that carry no keyword at all", () => {
    expect(stripScore("headings are flat. 85%")).toBe("headings are flat.");
    expect(stripScore("headings are flat. I'd give this a B+")).toBe(
      "headings are flat. I'd give this a",
    );
    expect(stripScore("headings are flat. (7 of 10)")).toBe("headings are flat.");
    expect(stripScore("headings are flat. ⅘")).toBe("headings are flat.");
    expect(stripScore("headings are flat. 4 stars")).toBe("headings are flat.");
  });

  test("a grade at the head of the line takes its punctuation with it", () => {
    expect(stripScore("rating: B+, the secondary text sits at 3:1 against the card")).toBe(
      "the secondary text sits at 3:1 against the card",
    );
  });

  test("measurements about the screen survive — the rule may not eat findings", () => {
    expect(stripScore("the 390px capture overflows by 12px")).toBe(
      "the 390px capture overflows by 12px",
    );
    expect(stripScore("the secondary text sits at 3:1 against the card")).toBe(
      "the secondary text sits at 3:1 against the card",
    );
    // A count in a sentence is a finding, not a score.
    expect(stripScore("1 of 10 buttons has no focus ring")).toBe(
      "1 of 10 buttons has no focus ring",
    );
    // A percentage OF something named is a measurement; only a trailing one is
    // a verdict.
    expect(stripScore("the hero is 85% of the viewport and the gutter collapses")).toBe(
      "the hero is 85% of the viewport and the gutter collapses",
    );
  });
});
