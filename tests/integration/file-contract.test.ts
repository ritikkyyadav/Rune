import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FILE_CASES } from "../helpers/file-contract";
import { describeNativeBinary, resolveRuneToolsBinary } from "../helpers/native-binary";

// The Rust half of the file contract: every case in tests/helpers/file-contract.ts
// sent to the real `rune-tools edit-file`, plus write_file's own cases (probes P2
// and P3 of docs/evidence/rune-reliability-probes-20261014). The TypeScript half
// is tests/unit/tool-registry/file-contract.test.ts.

// An exported RUNE_TOOLS_BINARY/RUNE_TOOLS_BIN wins over anything under
// target/, and a variable pointing nowhere throws instead of skipping.
const nativeBinary = resolveRuneToolsBinary();
const available = nativeBinary.exists;
if (!available) console.warn(`[file-contract] skipped: ${describeNativeBinary(nativeBinary)}`);

const POSIX = process.platform !== "win32";
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const bytes = (b: Buffer): string => b.toString("latin1");

interface ToolReply {
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

function call(sub: "edit-file" | "write-file", ws: string, input: object): ToolReply {
  const r = spawnSync(nativeBinary.path, ["--workspace", ws, sub], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  return JSON.parse(r.stdout) as ToolReply;
}

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rune-file-contract-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("the file contract — Rust (rune-tools edit-file)", () => {
  for (const c of FILE_CASES) {
    test.skipIf(!available)(c.name, () => {
      const file = join(ws, "target.txt");
      writeFileSync(file, c.before);
      if (POSIX && c.mode !== undefined) chmodSync(file, c.mode);

      const reply = call("edit-file", ws, {
        path: "target.txt",
        old_text: c.oldText,
        new_text: c.newText,
        expected_hash: sha(c.before),
        replace_all: c.replaceAll ?? null,
      });
      const after = readFileSync(file);

      if (c.expect.applied) {
        expect(reply.error).toBeUndefined();
        expect(reply.success).toBe(true);
        expect(bytes(after)).toBe(bytes(c.expect.after));
        if (c.expect.strategy) expect(reply.result?.strategy).toBe(c.expect.strategy);
      } else {
        expect(reply.success).toBe(false);
        expect(reply.error).toMatch(c.expect.error);
        expect(bytes(after)).toBe(bytes(c.before));
      }
      if (POSIX && c.mode !== undefined) {
        const want = c.expect.applied ? (c.expect.mode ?? c.mode) : c.mode;
        expect(statSync(file).mode & 0o777).toBe(want);
      }
    });
  }
});

describe("the file contract — Rust (rune-tools write-file)", () => {
  test.skipIf(!available || !POSIX)("P2: an overwrite keeps an executable's mode", () => {
    const file = join(ws, "run.sh");
    writeFileSync(file, "#!/bin/sh\necho hi\n");
    chmodSync(file, 0o755);

    const reply = call("write-file", ws, { path: "run.sh", content: "#!/bin/sh\necho bye\n" });

    expect(reply.success).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  test.skipIf(!available || !POSIX)("P3: a new file gets what the umask gives", () => {
    // A control file written the ordinary way gets exactly what the umask allows.
    writeFileSync(join(ws, "control.txt"), "x");

    const reply = call("write-file", ws, { path: "fresh.txt", content: "x" });

    expect(reply.success).toBe(true);
    expect(statSync(join(ws, "fresh.txt")).mode & 0o777).toBe(
      statSync(join(ws, "control.txt")).mode & 0o777,
    );
  });

  test.skipIf(!available)("an existing file that is not UTF-8 is not overwritten", () => {
    const raw = Buffer.from("name,city\nJos\xe9,M\xe1laga\n", "latin1");
    writeFileSync(join(ws, "people.csv"), raw);

    const reply = call("write-file", ws, { path: "people.csv", content: "name,city\n" });

    expect(reply.success).toBe(false);
    expect(reply.error).toMatch(/not valid UTF-8/);
    expect(reply.error).toMatch(/delete it first/);
    expect(bytes(readFileSync(join(ws, "people.csv")))).toBe(bytes(raw));
  });

  test.skipIf(!available || !POSIX)("a symlink is written through to its target", () => {
    writeFileSync(join(ws, "real.json"), "{}\n");
    symlinkSync("real.json", join(ws, "link.json"));

    const reply = call("write-file", ws, { path: "link.json", content: '{"a": 1}\n' });

    expect(reply.success).toBe(true);
    expect(readFileSync(join(ws, "real.json"), "utf8")).toBe('{"a": 1}\n');
  });
});
