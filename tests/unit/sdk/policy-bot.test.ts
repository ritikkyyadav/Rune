/**
 * The permission policy from `examples/sdk/policy-bot.ts`.
 *
 * An example that shows how to answer permissions from a rule set is only
 * worth shipping if the rule set behaves the way the prose claims — above all
 * on the line that makes it a policy instead of a rubber stamp: an unmatched
 * request is denied.
 */

import { describe, expect, test } from "bun:test";

import { decide } from "../../../examples/sdk/policy-bot";

const ask = (toolName: string, argsSummary: string) => decide({ toolName, argsSummary });

describe("the policy bot", () => {
  test("allows a read-only shell command", () => {
    const v = ask("bash", "bash: echo checking-the-tree");
    expect(v.decision.kind).toBe("allow_once");
    expect(v.because).toBe("read-only shell");
  });

  test("refuses a destructive one", () => {
    const v = ask("bash", "bash: rm -rf /tmp/anything");
    expect(v.decision.kind).toBe("deny");
    expect(v.because).toBe("destructive or outward");
  });

  test("refuses what no rule covers", () => {
    // The default. A policy that allows the unmatched case only documents the
    // requests somebody happened to think of.
    const v = ask("some_new_tool", "whatever it wants");
    expect(v.decision.kind).toBe("deny");
    expect(v.because).toBe("no rule covers this");
  });

  test("matches the command, not the label the UI puts in front of it", () => {
    // The host renders a summary as `bash: <command>`. A rule anchored at the
    // start of that string matches nothing, silently, and every command falls
    // through to the default deny — which looks like a working policy until
    // you notice it never allows anything.
    expect(ask("bash", "bash: git status").decision.kind).toBe("allow_once");
    expect(ask("bash", "git status").decision.kind).toBe("allow_once");
  });

  test("a tool-name rule with no argument pattern matches any args", () => {
    expect(ask("read_file", "read_file: src/index.ts").decision.kind).toBe("allow_once");
    expect(ask("write_file", "write_file: src/index.ts").decision.kind).toBe("deny");
  });
});
