// ─── /connectors: the one-line prompt and the wait for a browser ───
//
// A token is pasted into the one-line ask. Two things went wrong there before:
// a paste with a trailing newline became a "[Pasted text #1 +2 lines]" chip,
// and the chip itself was returned as the answer; and nothing could hide a
// secret while it was typed. Esc also had to reach a browser sign-in that the
// flow is waiting on, without the composer swallowing it.

import { describe, expect, test } from "bun:test";
import { INPUT_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-input";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

const FAKE_TOKEN = "test-only-not-a-real-token";

function asking(masked: boolean) {
  const fake: any = {
    mode: "ask",
    askState: { resolve: () => {}, title: "GitHub personal access token:", masked },
    input: "",
    caret: 0,
    pastes: new Map(),
    pasteSeq: 0,
    scheduleDraw: () => {},
    contentCols: () => 79,
    statusStr: () => "",
  };
  fake.insert = INPUT_METHODS.insert.bind(fake);
  return fake;
}

describe("a paste into the one-line ask", () => {
  test("a secret lands inline, its line break dropped", () => {
    const fake = asking(true);
    INPUT_METHODS.endPaste.call(fake, `${FAKE_TOKEN}\n`);
    expect(fake.input).toBe(FAKE_TOKEN);
    expect(fake.pastes.size).toBe(0);
  });

  test("anything else lands inline with its line breaks folded to spaces", () => {
    const fake = asking(false);
    INPUT_METHODS.endPaste.call(fake, "https://mcp.example.com/mcp\n");
    expect(fake.input).toBe("https://mcp.example.com/mcp");
    const multi = asking(false);
    INPUT_METHODS.endPaste.call(multi, "npx -y\n  some-server\n");
    expect(multi.input).toBe("npx -y some-server");
  });
});

describe("a masked ask", () => {
  test("draws one mask cell per character and never the secret", () => {
    const fake = asking(true);
    fake.input = FAKE_TOKEN;
    fake.caret = FAKE_TOKEN.length;
    const shown = stripAnsi(INPUT_METHODS.composerBlock.call(fake, 23).lines.join("\n"));
    expect(shown).not.toContain(FAKE_TOKEN);
    expect(shown).toContain("GitHub personal access token:");
  });

  test("an unmasked ask still shows what was typed", () => {
    const fake = asking(false);
    fake.input = "linear";
    const shown = stripAnsi(INPUT_METHODS.composerBlock.call(fake, 23).lines.join("\n"));
    expect(shown).toContain("linear");
  });
});

describe("esc while a browser sign-in waits", () => {
  function waiting() {
    const controller = new AbortController();
    let composerKeys = 0;
    const fake: any = {
      mode: "input",
      connectorWait: controller,
      agentsKey: () => false,
      inputKey: () => {
        composerKeys++;
      },
    };
    return { fake, controller, composerKeys: () => composerKeys };
  }

  test("stops the wait, and the composer never sees the key", () => {
    const w = waiting();
    INPUT_METHODS.routeKey.call(w.fake, { type: "esc" });
    expect(w.controller.signal.aborted).toBe(true);
    expect(w.composerKeys()).toBe(0);
  });

  test("other keys still reach the composer", () => {
    const w = waiting();
    INPUT_METHODS.routeKey.call(w.fake, { type: "char", value: "a" });
    expect(w.controller.signal.aborted).toBe(false);
    expect(w.composerKeys()).toBe(1);
  });

  test("with nothing waiting, esc is the composer's", () => {
    const w = waiting();
    w.fake.connectorWait = null;
    INPUT_METHODS.routeKey.call(w.fake, { type: "esc" });
    expect(w.composerKeys()).toBe(1);
  });
});
