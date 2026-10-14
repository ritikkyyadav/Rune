import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { createMultiEditHandler } from "../../../packages/tool-registry/src/tools/multi-edit";
import { firstInvalidUtf8 } from "../../../packages/tool-registry/src/tools/text-file";
import { FILE_CASES } from "../../helpers/file-contract";

// The TypeScript half of the file contract: every case in
// tests/helpers/file-contract.ts, applied through multi_edit (apply_patch
// shares its matcher). The Rust half is tests/integration/file-contract.test.ts.

const POSIX = process.platform !== "win32";
const handler = createMultiEditHandler();
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
// Bytes as a string a failed expectation can show, one char per byte.
const bytes = (b: Buffer): string => b.toString("latin1");

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "rune-file-contract-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("the file contract — TypeScript (multi_edit)", () => {
  for (const c of FILE_CASES) {
    test(c.name, async () => {
      const file = join(ws, "target.txt");
      await writeFile(file, c.before);
      if (POSIX && c.mode !== undefined) await chmod(file, c.mode);

      const out = await handler.execute({
        callId: "c1",
        toolName: "multi_edit",
        sessionId: "s1",
        workspaceRoot: ws,
        args: {
          path: "target.txt",
          expected_hash: sha(c.before),
          edits: [
            {
              old_text: c.oldText,
              new_text: c.newText,
              ...(c.replaceAll ? { replace_all: true } : {}),
            },
          ],
        },
      });
      const after = await readFile(file);

      if (c.expect.applied) {
        expect(out.error).toBeUndefined();
        expect(out.success).toBe(true);
        expect(bytes(after)).toBe(bytes(c.expect.after));
        if (c.expect.strategy) {
          expect(JSON.parse(out.result).edits[0].strategy).toBe(c.expect.strategy);
        }
      } else {
        expect(out.success).toBe(false);
        expect(out.error).toMatch(c.expect.error);
        expect(bytes(after)).toBe(bytes(c.before));
      }
      if (POSIX && c.mode !== undefined) {
        const want = c.expect.applied ? (c.expect.mode ?? c.mode) : c.mode;
        expect((await stat(file)).mode & 0o777).toBe(want);
      }
    });
  }
});

describe("firstInvalidUtf8 agrees with the decoder Rust uses", () => {
  const cases: Array<[string, number[], number]> = [
    ["ascii", [0x61, 0x62], -1],
    ["two-byte é", [0xc3, 0xa9], -1],
    ["four-byte emoji", [0xf0, 0x9f, 0x98, 0x80], -1],
    ["latin-1 é", [0x61, 0xe9, 0x62], 1],
    ["overlong slash", [0xc0, 0xaf], 0],
    ["surrogate", [0xed, 0xa0, 0x80], 0],
    ["past U+10FFFF", [0xf4, 0x90, 0x80, 0x80], 0],
    ["cut short", [0x61, 0xe2, 0x82], 1],
    ["stray continuation", [0x80], 0],
  ];
  for (const [name, input, at] of cases) {
    test(name, () => {
      expect(firstInvalidUtf8(Uint8Array.from(input))).toBe(at);
      // The platform's strict decoder is the oracle for valid/invalid.
      let valid = true;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(input));
      } catch {
        valid = false;
      }
      expect(valid).toBe(at === -1);
    });
  }
});
