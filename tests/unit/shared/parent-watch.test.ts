/**
 * `watchedArgv`: a command Rune starts in a process group of its own ends when
 * Rune does, even when Rune is killed outright and runs no handler (found by
 * the reliability process suite, 19 October: `npm test` ran on after a SIGKILL
 * during the end-of-turn check).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WATCHED_ARGV0, watchedArgv } from "../../../packages/shared/src/parent-watch";

const POSIX = process.platform !== "win32";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe("watchedArgv", () => {
  test("Windows gets the argv unchanged", () => {
    expect(watchedArgv(["npm", "test"], "win32")).toEqual(["npm", "test"]);
  });

  test("RUNE_PARENT_WATCH=off turns it off", () => {
    const before = process.env.RUNE_PARENT_WATCH;
    process.env.RUNE_PARENT_WATCH = "off";
    try {
      expect(watchedArgv(["npm", "test"], "linux")).toEqual(["npm", "test"]);
    } finally {
      if (before === undefined) delete process.env.RUNE_PARENT_WATCH;
      else process.env.RUNE_PARENT_WATCH = before;
    }
  });

  test("elsewhere the argv runs exactly, after the watching shell's own arguments", () => {
    const argv = watchedArgv(["bash", "-c", 'echo "a b"'], "linux");
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv.slice(3)).toEqual([WATCHED_ARGV0, "bash", "-c", 'echo "a b"']);
  });

  test.skipIf(!POSIX)("the command's output and exit status come through unchanged", () => {
    for (const code of [0, 1, 42]) {
      const p = Bun.spawnSync(
        watchedArgv(["sh", "-c", `echo "out $1"; echo err >&2; exit ${code}`, "x", "a b"]),
      );
      expect(p.exitCode).toBe(code);
      expect(p.stdout.toString()).toBe("out a b\n");
      expect(p.stderr.toString()).toBe("err\n");
    }
  });

  test.skipIf(!POSIX)("a command that finishes leaves nothing of its group behind", async () => {
    // Started as its own group, as Rune starts them: once the command is
    // done, no member of the group (the watcher included) may remain.
    const [program, ...args] = watchedArgv(["sh", "-c", "echo done"]);
    const child = spawn(program!, args, { detached: true, stdio: "ignore" });
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code).toBe(0);
    const groupGone = () => {
      try {
        process.kill(-child.pid!, 0);
        return false;
      } catch {
        return true;
      }
    };
    // The watcher's last `sleep 1` may outlive it by under a second.
    expect(await until(groupGone, 3_000)).toBe(true);
  });

  test.skipIf(!POSIX)(
    "a parent killed with SIGKILL takes its command, and what the command started, with it",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "rune-parent-watch-"));
      dirs.push(dir);
      const pids = join(dir, "pids");
      // The parent: starts a watched, detached command whose own child is a
      // long sleep, records both pids, then waits to be killed.
      const parent = join(dir, "parent.ts");
      writeFileSync(
        parent,
        [
          `import { spawn } from "node:child_process";`,
          `import { watchedArgv } from ${JSON.stringify(join(import.meta.dir, "../../../packages/shared/src/parent-watch"))};`,
          `const [p, ...a] = watchedArgv(["sh", "-c", "sleep 60 & echo $! > ${pids}.child; wait"]);`,
          `const c = spawn(p, a, { detached: true, stdio: "ignore" });`,
          `await Bun.write(${JSON.stringify(pids)}, String(c.pid));`,
          `setInterval(() => {}, 1000);`,
        ].join("\n"),
      );
      const proc = Bun.spawn(["bun", parent], { stdio: ["ignore", "ignore", "inherit"] });
      const read = (f: string) => {
        try {
          return Number(readFileSync(f, "utf8").trim()) || 0;
        } catch {
          return 0;
        }
      };
      let leader = 0;
      let grandchild = 0;
      try {
        expect(await until(() => read(pids) > 0 && read(`${pids}.child`) > 0, 10_000)).toBe(true);
        leader = read(pids);
        grandchild = read(`${pids}.child`);
        expect(alive(leader)).toBe(true);
        expect(alive(grandchild)).toBe(true);

        proc.kill("SIGKILL");
        await proc.exited;
        // The watch polls once a second.
        expect(await until(() => !alive(leader) && !alive(grandchild), 5_000)).toBe(true);
      } finally {
        // Whatever failed, nothing this test started outlives it.
        proc.kill("SIGKILL");
        for (const pid of [leader, grandchild]) {
          try {
            if (pid) process.kill(pid, "SIGKILL");
          } catch {
            // Gone already.
          }
        }
      }
    },
    20_000,
  );
});
