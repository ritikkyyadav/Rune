/**
 * MCP image blocks become tool attachments — the pixels the agent loop turns
 * into real image blocks — instead of only a "[image image/png, N base64
 * bytes]" placeholder. This is what lets a Playwright screenshot be SEEN.
 */

import { describe, expect, test } from "bun:test";
import { imageAttachments } from "../../../packages/tool-registry/src/mcp/client";

const png = (n: number) => "A".repeat(n);

describe("imageAttachments", () => {
  test("a screenshot result yields one png attachment, labelled by the tool", () => {
    const out = imageAttachments(
      {
        content: [
          { type: "text", text: "Screenshot taken" },
          { type: "image", mimeType: "image/png", data: png(400) },
        ],
      },
      "browser_take_screenshot",
    );
    expect(out).toEqual([
      {
        kind: "image",
        mediaType: "image/png",
        data: png(400),
        label: "browser_take_screenshot image",
      },
    ]);
  });

  test("text-only results attach nothing", () => {
    expect(imageAttachments({ content: [{ type: "text", text: "ok" }] }, "t")).toEqual([]);
    expect(imageAttachments({}, "t")).toEqual([]);
  });

  test("unknown media types and oversized images keep their placeholder only", () => {
    const out = imageAttachments(
      {
        content: [
          { type: "image", mimeType: "image/tiff", data: png(10) },
          { type: "image", mimeType: "image/png", data: png(5_000_000) },
          { type: "image", mimeType: "image/jpeg", data: png(10) },
        ],
      },
      "t",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.mediaType).toBe("image/jpeg");
    expect(out[0]!.label).toBe("t image 3");
  });

  test("at most three images ride per call", () => {
    const out = imageAttachments(
      {
        content: Array.from({ length: 5 }, () => ({
          type: "image" as const,
          mimeType: "image/png",
          data: png(10),
        })),
      },
      "gallery",
    );
    expect(out).toHaveLength(3);
  });

  test("a missing mime type is treated as png", () => {
    const out = imageAttachments({ content: [{ type: "image", data: png(10) }] }, "t");
    expect(out[0]!.mediaType).toBe("image/png");
  });
});
