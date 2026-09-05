// ─── Image attachment ───
//
// Turns image file paths the user references in chat into real image content
// blocks, so vision-capable models actually SEE the pixels instead of a path
// string. Before this existed, "build me this mockup" ended with the agent
// running `sips` for metadata and styling from imagination — the wire layer
// (image ContentBlock + provider translations) was built, but nothing ever
// PRODUCED an image block.
//
// Scope (v1): user-referenced local files at message-assembly time (initial
// message + mid-task interjections). Tool results and session replay still
// carry text only; the path stays in the text either way, so the model can
// always ask for a re-send.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { ContentBlock } from "@rune/llm-gateway";

/** Extension → media type. Only formats every vision provider accepts. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Max raw bytes per attached image. Anthropic's wire limit is 5MB AFTER
 * base64 (which inflates 4/3), so 3.5MB raw keeps every provider happy.
 */
export const MAX_IMAGE_BYTES = Math.floor(3.5 * 1024 * 1024);

/** Context-cost guard: at most this many images attach per message. */
export const MAX_IMAGES_PER_MESSAGE = 4;

const EXT_RE = /\.(png|jpe?g|gif|webp)/gi;

/** Characters that end an unquoted path token (unless backslash-escaped). */
const TOKEN_BREAK = new Set([" ", "\t", "\n", "\r", '"', "'", "`"]);

/**
 * Find substrings of `text` that look like local image paths. Handles the
 * three ways users paste paths in a terminal:
 *   - plain:         /abs/dir/shot.png  or  assets/logo.webp
 *   - shell-escaped: /abs/Sample\ images\ /_\ \(4\).webp   (drag-and-drop)
 *   - quoted:        "assets/my file.png"  or  'shot 2.jpg'
 * Candidates are syntactic only — the caller validates existence.
 */
export function findImagePathCandidates(text: string): string[] {
  const found: string[] = [];

  // Quoted paths first; remember their spans so the unquoted scan skips them.
  const quotedSpans: Array<[number, number]> = [];
  for (const quoteRe of [
    /"([^"\n]+?\.(?:png|jpe?g|gif|webp))"/gi,
    /'([^'\n]+?\.(?:png|jpe?g|gif|webp))'/gi,
  ]) {
    for (const m of text.matchAll(quoteRe)) {
      found.push(m[1]!);
      quotedSpans.push([m.index!, m.index! + m[0]!.length]);
    }
  }
  const inQuoted = (i: number) => quotedSpans.some(([s, e]) => i >= s && i < e);

  // Unquoted scan: find an image extension, then walk LEFT collecting the
  // token — whitespace only continues the token when backslash-escaped.
  EXT_RE.lastIndex = 0;
  for (const m of text.matchAll(EXT_RE)) {
    const end = m.index! + m[0]!.length;
    // Extension must terminate the token (end of text / break char / closing
    // punctuation), not sit mid-word like "a.pngx".
    const next = text[end];
    if (
      next !== undefined &&
      !TOKEN_BREAK.has(next) &&
      ![")", "]", ",", ";", ":", "!", "?"].includes(next)
    ) {
      continue;
    }
    if (inQuoted(m.index!)) continue;

    let start = m.index!;
    while (start > 0) {
      const prev = text[start - 1]!;
      if (TOKEN_BREAK.has(prev)) {
        // An escaped break char (e.g. "\ ") is part of the path — keep walking.
        if (text[start - 2] === "\\") {
          start -= 2;
          continue;
        }
        break;
      }
      start--;
    }
    const candidate = text.slice(start, end);
    if (candidate.length > 1) found.push(candidate);
  }

  return found;
}

/**
 * Undo shell escaping ("\ " → " ", "\(" → "(", …) and expand a leading ~.
 *
 * The unescape is POSIX-ONLY, and that is the whole point of the platform
 * parameter. On Windows a backslash is the path separator, so
 * `C:\Users\me\shot.png` came out of the old unconditional
 * `replace(/\\(.)/g, "$1")` as `C:Usersmeshot.png` — a path that exists
 * nowhere. Every pasted Windows path silently attached nothing (P10.2).
 *
 * Windows loses nothing by this: the escaping being undone is a POSIX shell's,
 * which is not how paths arrive on Windows. A path with spaces arrives quoted
 * there, and the quoted scan handles it.
 */
export function normalizeCandidate(
  candidate: string,
  baseDir: string,
  platform: string = process.platform,
): string {
  const windows = platform === "win32";
  const api = windows ? win32 : posix;
  let p = (windows ? candidate : candidate.replace(/\\(.)/g, "$1")).trim();
  if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
  return api.isAbsolute(p) ? api.resolve(p) : api.resolve(baseDir, p);
}

export interface AttachedImages {
  /** Image blocks, in the order the paths appear in the text. */
  blocks: ContentBlock[];
  /** One label per attached block, e.g. "[attached image 1: /path]". */
  labels: string[];
  /** Human-readable reasons for anything referenced but NOT attached. */
  notes: string[];
}

/**
 * Resolve every image path referenced in `text` (against `baseDir` for
 * relative paths) and load the ones that exist into image content blocks.
 * Oversized or over-count images produce honest notes instead of blocks, so
 * the model can tell the user what it could not see — never guess.
 */
export function attachReferencedImages(text: string, baseDir: string): AttachedImages {
  const out: AttachedImages = { blocks: [], labels: [], notes: [] };
  const seen = new Set<string>();

  for (const candidate of findImagePathCandidates(text)) {
    const path = normalizeCandidate(candidate, baseDir);
    if (seen.has(path)) continue;
    seen.add(path);

    let size: number;
    try {
      if (!existsSync(path) || !statSync(path).isFile()) continue; // prose, URL, or typo — not ours to report
      size = statSync(path).size;
    } catch {
      continue;
    }

    if (out.blocks.length >= MAX_IMAGES_PER_MESSAGE) {
      out.notes.push(`[image not attached (limit ${MAX_IMAGES_PER_MESSAGE}/message): ${path}]`);
      continue;
    }
    if (size > MAX_IMAGE_BYTES) {
      out.notes.push(
        `[image too large to attach (${(size / 1024 / 1024).toFixed(1)}MB > ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1)}MB): ${path} — downscale it (e.g. \`sips -Z 1600 <file>\` on macOS) and re-send]`,
      );
      continue;
    }

    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) continue;

    try {
      const data = readFileSync(path).toString("base64");
      out.blocks.push({ type: "image", mediaType, data });
      out.labels.push(`[attached image ${out.blocks.length}: ${path}]`);
    } catch (err) {
      out.notes.push(
        `[image could not be read: ${path} — ${err instanceof Error ? err.message : String(err)}]`,
      );
    }
  }

  return out;
}

/**
 * Build the content blocks for a user message: referenced images first (the
 * order vision providers prefer), then the text — with attachment labels and
 * skip notes appended so the model knows exactly which block is which file
 * and what it could NOT see.
 *
 * When the text references no images, this returns the classic single text
 * block — byte-identical behavior for the 99% of messages without images.
 */
export function buildUserContent(text: string, baseDir: string): ContentBlock[] {
  const { blocks, labels, notes } = attachReferencedImages(text, baseDir);
  if (blocks.length === 0 && notes.length === 0) {
    return [{ type: "text", text }];
  }
  const suffix = [...labels, ...notes].join("\n");
  return [...blocks, { type: "text", text: suffix ? `${text}\n\n${suffix}` : text }];
}
