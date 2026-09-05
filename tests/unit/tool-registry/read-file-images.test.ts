/**
 * `read_file` on non-text files, end to end through the REAL rune-tools binary.
 *
 * Before this, reading a 130 KB screenshot returned ~327 KB of
 * replacement-character mojibake as "file content" — `String::from_utf8_lossy`
 * applied to PNG bytes. It taught the model nothing, and one such read cost
 * more context than the rest of the turn.
 *
 * Two things have to hold now: the text half stays short and honest, and the
 * pixels come back as a typed attachment that never touches the transcript.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createRustToolHandler } from "../../../packages/tool-registry/src/tools/rust-bridge";
import type { ToolSchema } from "../../../packages/tool-registry/src/types";

const SCHEMA: ToolSchema = {
  name: "read_file",
  version: "0.1.0",
  description: "",
  inputSchema: { type: "object", properties: {} },
  category: "read",
  permissionLevel: "auto",
};

// A 1x1 PNG, byte for byte.
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const BINARY = join(homedir(), ".rune/bin/rune-tools");

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rune-readfile-img-"));
  writeFileSync(join(root, "shot.png"), TINY_PNG);
  writeFileSync(join(root, "a.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
  writeFileSync(join(root, "notes.md"), "# Title\n\nSome prose.\n");
});

const run = (path: string) =>
  createRustToolHandler(SCHEMA, "read-file", BINARY).execute({
    toolName: "read_file",
    callId: "c1",
    args: { path },
    sessionId: "s1",
    workspaceRoot: root,
  } as any);

describe.skipIf(!existsSync(BINARY))("read_file on non-text files", () => {
  test("an image returns a short description plus a typed attachment", async () => {
    const out = await run("shot.png");

    expect(out.success).toBe(true);
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments![0]!.mediaType).toBe("image/png");
    // Round-trips the exact bytes.
    expect(Buffer.from(out.attachments![0]!.data, "base64").equals(TINY_PNG)).toBe(true);
  });

  test("the base64 is lifted OUT of the text result", async () => {
    // This is the whole point: `result` is stringified straight into the
    // model's transcript, so pixels left there are a context bomb spelled
    // differently.
    const out = await run("shot.png");

    expect(out.result).not.toContain(out.attachments![0]!.data);
    expect(out.result).not.toContain("base64");
    expect(out.result).toContain("[image]");
    // A description, not a payload. The bound is generous on purpose — most of
    // it is the absolute path and the JSON envelope. The number that matters is
    // the one it replaced: 327,675 bytes of mojibake for a real screenshot.
    expect(out.result.length).toBeLessThan(800);
  });

  test("a non-image binary is described, not transcribed", async () => {
    const out = await run("a.bin");

    expect(out.success).toBe(true);
    expect(out.attachments).toBeUndefined();
    expect(out.result).toContain("[binary]");
    expect(out.result).toContain("nothing to read here");
    expect(out.result.length).toBeLessThan(800);
  });

  test("text files are untouched", async () => {
    const out = await run("notes.md");

    expect(out.success).toBe(true);
    expect(out.attachments).toBeUndefined();
    expect(out.result).toContain("Title");
    expect(out.result).toContain("Some prose.");
  });
});
