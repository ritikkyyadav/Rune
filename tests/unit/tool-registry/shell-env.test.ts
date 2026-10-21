/**
 * An uncontained shell gets what a foreground command gets, and no more
 * (packages/tool-registry/src/shell-env.ts). Found 21 October: a background
 * shell started outside the sandbox inherited Rune's whole environment, the
 * person's saved-sign-in paths and provider keys with it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SHELL_ENV_KEEP,
  SHELL_ENV_KEEP_WINDOWS,
  curatedShellEnv,
} from "../../../packages/tool-registry/src/shell-env";
import { BackgroundShellManager } from "../../../packages/tool-registry/src/tools/background";
import {
  resetSandboxPolicyForTest,
  setSandboxMode,
} from "../../../packages/tool-registry/src/sandbox-mode";

afterEach(() => resetSandboxPolicyForTest());

/** The string literals of one `let NAME = [ … ];` array in the Rust source. */
function rustList(source: string, name: string): string[] {
  const m = source.match(new RegExp(`let ${name} = \\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`no ${name} in path_guard.rs`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("the list is the foreground's", () => {
  const rust = readFileSync(
    resolve(import.meta.dir, "../../../crates/rune-sandbox/src/path_guard.rs"),
    "utf8",
  );

  test("the same names as curate_env, on every platform", () => {
    const sorted = (names: readonly string[]) => [...names].sort();
    expect(sorted(SHELL_ENV_KEEP)).toEqual(sorted(rustList(rust, "safe_vars")));
    expect(sorted(SHELL_ENV_KEEP_WINDOWS)).toEqual(sorted(rustList(rust, "win_vars")));
  });
});

describe("curatedShellEnv", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/p",
    LANG: "en_US.UTF-8",
    RUNE_CREDENTIALS_PATH: "/home/p/.rune/credentials.json",
    RUNE_DB_PATH: "/home/p/.rune/rune.db",
    OPENAI_API_KEY: "sk-not-a-real-key",
    SystemRoot: "C:\\Windows",
  };

  test("keeps the short list, names the workspace, and drops everything else", () => {
    expect(curatedShellEnv("/ws", source, "darwin")).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/p",
      LANG: "en_US.UTF-8",
      RUNE_WORKSPACE: "/ws",
      NO_COLOR: "1",
    });
  });

  test("Windows keeps what a Windows shell needs to start", () => {
    expect(curatedShellEnv("C:\\ws", source, "win32").SystemRoot).toBe("C:\\Windows");
    expect(curatedShellEnv("/ws", source, "linux").SystemRoot).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("an uncontained background shell", () => {
  test("never sees the session's sign-in paths or keys", async () => {
    setSandboxMode("off");
    const saved = {
      creds: process.env.RUNE_CREDENTIALS_PATH,
      key: process.env.OPENAI_API_KEY,
    };
    process.env.RUNE_CREDENTIALS_PATH = "/should/not/leak/credentials.json";
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    try {
      const m = new BackgroundShellManager();
      const { shellId, sandboxed } = m.start(
        'echo "creds=${RUNE_CREDENTIALS_PATH:-unset} key=${OPENAI_API_KEY:-unset} ws=$RUNE_WORKSPACE home=${HOME:+set}"',
        "/tmp",
      );
      expect(sandboxed).toBe(false);
      let output = "";
      const start = Date.now();
      while (Date.now() - start < 5_000) {
        const r = m.read(shellId);
        output += r.output ?? "";
        if (r.status !== "running") break;
        await new Promise((res) => setTimeout(res, 20));
      }
      expect(output).toContain("creds=unset key=unset ws=/tmp home=set");
    } finally {
      if (saved.creds === undefined) delete process.env.RUNE_CREDENTIALS_PATH;
      else process.env.RUNE_CREDENTIALS_PATH = saved.creds;
      if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.key;
    }
  });
});
