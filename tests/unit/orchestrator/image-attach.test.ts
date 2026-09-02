/**
 * Vision pipeline, producer side. Regression anchor (2026-07-16): the user
 * pasted `/…/Sample\ images\ /_\ \(4\).webp build me like this provided
 * image` — the wire layer supported image blocks, but NOTHING ever produced
 * one, so the agent "inspected" the file with sips metadata and styled from
 * imagination. These tests pin the producer: real paths (drag-and-drop shell
 * escaping included) become image blocks; everything unattachable becomes an
 * honest note, never a silent omission.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  attachReferencedImages,
  buildUserContent,
  findImagePathCandidates,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  normalizeCandidate,
} from "../../../packages/orchestrator/src/image-attach";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let root: string;

beforeAll(() => {
  root = join(tmpdir(), `gear-image-attach-${process.pid}`);
  // Directory with a TRAILING SPACE plus a file with spaces + parens — the
  // exact drag-and-drop shape from the incident.
  mkdirSync(join(root, "Sample images "), { recursive: true });
  writeFileSync(join(root, "Sample images ", "_ (4).webp"), PNG_BYTES);
  writeFileSync(join(root, "plain.png"), PNG_BYTES);
  writeFileSync(join(root, "photo.jpg"), PNG_BYTES);
  mkdirSync(join(root, "rel"), { recursive: true });
  writeFileSync(join(root, "rel", "mock.webp"), PNG_BYTES);
  for (let i = 0; i < 6; i++) writeFileSync(join(root, `many${i}.png`), PNG_BYTES);
  writeFileSync(join(root, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1024));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findImagePathCandidates", () => {
  test("plain, quoted, and shell-escaped forms are all found", () => {
    const text = [
      `look at ${root}/plain.png please`,
      `and "${root}/a b.png"`,
      `and '${root}/c d.jpg'`,
      `${root}/Sample\\ images\\ /_\\ \\(4\\).webp build me like this`,
    ].join("\n");
    const found = findImagePathCandidates(text);
    expect(found).toContain(`${root}/plain.png`);
    expect(found).toContain(`${root}/a b.png`);
    expect(found).toContain(`${root}/c d.jpg`);
    expect(found).toContain(`${root}/Sample\\ images\\ /_\\ \\(4\\).webp`);
  });

  test("extensions mid-word are not candidates", () => {
    expect(findImagePathCandidates("see file.pngx and data.webpack")).toEqual([]);
  });
});

describe("attachReferencedImages", () => {
  // POSIX-only fixture: this path is shell-escaped the way a macOS or Linux
  // drag-and-drop produces it. On Windows a backslash is the path separator and
  // nothing unescapes it (see `normalizeCandidate`), so the same string is not
  // a path there — a Windows paste with spaces arrives quoted, which the quoted
  // scan handles and which is covered above.
  test.skipIf(process.platform === "win32")(
    "the incident paste attaches for real (escaped spaces, parens, trailing-space dir)",
    () => {
      const text = `well ${root}/Sample\\ images\\ /_\\ \\(4\\).webp build me like this provided image`;
      const { blocks, labels, notes } = attachReferencedImages(text, "/");
      expect(blocks.length).toBe(1);
      expect(blocks[0]).toMatchObject({ type: "image", mediaType: "image/webp" });
      expect((blocks[0] as { data: string }).data).toBe(PNG_BYTES.toString("base64"));
      expect(labels[0]).toContain("_ (4).webp");
      expect(notes).toEqual([]);
    },
  );

  test("a pasted WINDOWS path is not mangled by shell unescaping", () => {
    // The defect: `normalizeCandidate` used to strip every backslash, so
    // `C:\Users\me\shot.png` became `C:Usersmeshot.png` and every pasted
    // Windows path silently attached nothing. Asserted from any OS.
    expect(normalizeCandidate("C:\\Users\\me\\Pictures\\shot.png", "C:\\ws", "win32")).toBe(
      "C:\\Users\\me\\Pictures\\shot.png",
    );
    // …while POSIX escaping still means what it did.
    expect(normalizeCandidate("/tmp/a\\ b.png", "/ws", "linux")).toBe("/tmp/a b.png");
  });

  test("relative paths resolve against the base dir; jpg maps to image/jpeg", () => {
    const { blocks } = attachReferencedImages("use rel/mock.webp and photo.jpg", root);
    expect(blocks.length).toBe(2);
    expect(blocks.map((b) => (b as { mediaType: string }).mediaType)).toEqual([
      "image/webp",
      "image/jpeg",
    ]);
  });

  test("missing files and URLs attach nothing and stay silent (prose, not errors)", () => {
    const { blocks, notes } = attachReferencedImages(
      `see ${root}/nope.png and https://x.com/logo.png`,
      root,
    );
    expect(blocks).toEqual([]);
    expect(notes).toEqual([]);
  });

  test("oversized images become an honest note with downscale guidance, not a block", () => {
    const { blocks, notes } = attachReferencedImages(`${root}/huge.png`, root);
    expect(blocks).toEqual([]);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("too large");
    expect(notes[0]).toContain("sips -Z");
  });

  test("per-message cap: extra images noted, first N attached, duplicates deduped", () => {
    const paths = Array.from({ length: 6 }, (_, i) => `${root}/many${i}.png`);
    const text = `${paths.join(" ")} ${paths[0]}`;
    const { blocks, notes } = attachReferencedImages(text, root);
    expect(blocks.length).toBe(MAX_IMAGES_PER_MESSAGE);
    expect(notes.length).toBe(6 - MAX_IMAGES_PER_MESSAGE);
    expect(notes[0]).toContain("limit");
  });
});

describe("buildUserContent", () => {
  test("no image references → the classic single text block, byte-identical", () => {
    const content = buildUserContent("just fix the bug in auth.ts", root);
    expect(content).toEqual([{ type: "text", text: "just fix the bug in auth.ts" }]);
  });

  test("images ride FIRST, text follows with attachment labels appended", () => {
    const text = `match ${root}/plain.png exactly`;
    const content = buildUserContent(text, root);
    expect(content.length).toBe(2);
    expect(content[0]!.type).toBe("image");
    expect(content[1]).toMatchObject({ type: "text" });
    const t = (content[1] as { text: string }).text;
    expect(t.startsWith(text)).toBe(true);
    expect(t).toContain("[attached image 1:");
  });
});

describe("AgentLoop vision integration", () => {
  test("a user message referencing a real image reaches the provider as an image block", async () => {
    const requests: any[] = [];
    const gateway = {
      inferStream: mock(async function* (req: any) {
        requests.push(req);
        yield { type: "content_delta", delta: { type: "text_delta", text: "seen" } };
        yield { type: "message_stop", stopReason: "end_turn" };
      }),
    } as any;
    const registry = {
      toLlmTools: mock(() => []),
      get: mock(() => ({ schema: { category: "read", permissionLevel: "auto" } })),
      execute: mock(async () => ({ success: true, result: "", durationMs: 1 })),
    } as any;

    const loop = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, registry);
    for await (const _ of loop.run(`build this: ${root}/plain.png`, "s1", root)) {
      /* drain */
    }

    const userMsg = requests[0].messages[0];
    expect(userMsg.role).toBe("user");
    expect(userMsg.content[0].type).toBe("image");
    expect(userMsg.content[0].mediaType).toBe("image/png");
    expect(userMsg.content[1].type).toBe("text");
    expect(userMsg.content[1].text).toContain("[attached image 1:");
  });
});
