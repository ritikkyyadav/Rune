import { describe, expect, it } from "bun:test";
import {
  clipboardCommands,
  copyText,
  lastCodeBlock,
  osc52,
} from "../../../packages/orchestrator/src/bin/ui/clipboard";

describe("/copy: the last code block of an answer", () => {
  it("finds the last fenced block, verbatim", () => {
    const answer = [
      "Run it like this:",
      "",
      "```bash",
      "cd /Users/someone/Project/code/bangla-sweets && python3 -m http.server 8765",
      "```",
      "",
      "Then the test:",
      "",
      "```js",
      'console.log(require("../package.json").version);',
      "```",
    ].join("\n");
    expect(lastCodeBlock(answer)).toBe('console.log(require("../package.json").version);');
  });

  it("keeps a long command on one line, however the screen wrapped it", () => {
    const command = "cd /Users/someone/Project/code/bangla-sweets && python3 -m http.server 8765";
    expect(lastCodeBlock("```bash\n" + command + "\n```")).toBe(command);
  });

  it("reads a fence the model never closed, and says null when there is none", () => {
    expect(lastCodeBlock("```\nx = 1\ny = 2")).toBe("x = 1\ny = 2");
    expect(lastCodeBlock("no code here")).toBeNull();
  });
});

describe("/copy: where the text goes", () => {
  it("uses the platform's clipboard command and says it is confirmed", () => {
    const calls: Array<[string, string]> = [];
    const result = copyText("hello", {
      platform: "darwin",
      env: {},
      run: (command, _args, input) => {
        calls.push([command, input]);
        return true;
      },
      write: () => {
        throw new Error("should not reach the terminal");
      },
    });
    expect(calls).toEqual([["pbcopy", "hello"]]);
    expect(result).toEqual({ confirmed: true, via: "pbcopy" });
  });

  it("over ssh, asks the terminal instead, and does not claim it worked", () => {
    let written = "";
    const result = copyText("hello", {
      platform: "linux",
      env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22", DISPLAY: ":0" },
      run: () => {
        throw new Error("no clipboard command over ssh");
      },
      write: (data) => {
        written += data;
      },
    });
    expect(written).toBe(osc52("hello"));
    expect(result).toEqual({ confirmed: false, via: "osc52" });
  });

  it("falls back to the terminal when no command takes the text", () => {
    let written = "";
    const result = copyText("hi", {
      platform: "linux",
      env: { DISPLAY: ":0" },
      run: () => false,
      write: (data) => {
        written += data;
      },
    });
    expect(written).toBe("\x1b]52;c;aGk=\x07");
    expect(result.confirmed).toBe(false);
  });

  it("knows the commands for each platform", () => {
    expect(clipboardCommands("win32", {})).toEqual([["clip", []]]);
    expect(clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0" })[0]![0]).toBe("wl-copy");
    expect(clipboardCommands("linux", {})).toEqual([]);
  });
});
