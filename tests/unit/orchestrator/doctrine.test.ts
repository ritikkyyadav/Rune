/**
 * Doctrine v2 regression guard. The agency layer is what separates "typed
 * coding agent" from "autonomous engineer" — these phrases anchor behaviors
 * that mechanical fixes can't provide, so losing one in a later edit is a
 * silent product regression. Assert the load-bearing lines survive.
 */

import { describe, test, expect } from "bun:test";
import { AGENT_DOCTRINE } from "../../../packages/orchestrator/src/prompts";

describe("AGENT_DOCTRINE — agency layer", () => {
  test("agency section leads: ownership, iterate-on-failure, no promised next steps", () => {
    expect(AGENT_DOCTRINE).toContain("# Agency — you own the task");
    // Agency must come BEFORE tone: a model reads priorities in order.
    expect(AGENT_DOCTRINE.indexOf("# Agency")).toBeLessThan(AGENT_DOCTRINE.indexOf("# Tone and style"));
    expect(AGENT_DOCTRINE).toContain("that is YOUR bug to fix");
    expect(AGENT_DOCTRINE).toContain("Never end your reply with a plan or a promise");
    expect(AGENT_DOCTRINE).toContain("Act on reasonable assumptions");
  });

  test("hands-free means no human mid-task", () => {
    expect(AGENT_DOCTRINE).toContain("In Hands-Free mode there is no human mid-task");
  });

  test("delegation teaches parallel fan-out", () => {
    expect(AGENT_DOCTRINE).toContain("# Delegation");
    expect(AGENT_DOCTRINE).toContain("SEVERAL IN ONE RESPONSE");
    expect(AGENT_DOCTRINE).toContain("read-only scouts");
  });

  test("finish line: the user sees it running, next step offered as a statement", () => {
    expect(AGENT_DOCTRINE).toContain("the user SEEING it run");
    expect(AGENT_DOCTRINE).toContain("left it running");
    expect(AGENT_DOCTRINE).toContain("Never close with a list of questions");
  });

  test("honesty + runtime truth survive", () => {
    expect(AGENT_DOCTRINE).toContain("verified, then stopped");
    expect(AGENT_DOCTRINE).toContain('never claim "done" to escape a hard problem');
  });
});
