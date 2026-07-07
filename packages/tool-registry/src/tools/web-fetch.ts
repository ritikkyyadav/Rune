import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export const WEB_FETCH_SCHEMA: ToolSchema = {
  name: "web_fetch",
  version: "0.2.0",
  description:
    "Fetch a URL and return its main readable content as clean Markdown (article extraction + " +
    "HTML→Markdown). Non-HTML responses (JSON, plain text) are returned as-is. Use this to read " +
    "a page found via web_search.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      maxBytes: {
        type: "number",
        description: "Max bytes to read from the response (default 1MB)",
      },
    },
    required: ["url"],
  },
  permissionLevel: "confirm",
  category: "network",
};

const DEFAULT_MAX_BYTES = 1_048_576;
const TIMEOUT_MS = 10_000;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// Drop noise that survives article extraction.
turndown.remove(["script", "style", "noscript", "iframe"]);

/** Last-resort: strip tags and collapse whitespace (previous behaviour). */
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the main content of an HTML page as Markdown. Tries Readability
 * (article extraction) → Turndown (HTML→MD); falls back to whole-document
 * Turndown, then to plain tag-stripping if those yield nothing.
 */
function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  try {
    const { document } = parseHTML(html);
    let title = document.querySelector("title")?.textContent?.trim() ?? "";

    // Readability mutates the document, so parse before any other DOM use.
    let contentHtml: string | null = null;
    try {
      const article = new Readability(document).parse();
      if (article?.content) {
        contentHtml = article.content;
        if (article.title) title = article.title;
      }
    } catch {
      // Readability failed — fall through to whole-document conversion.
    }

    const markdown = turndown
      .turndown(contentHtml ?? html)
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (markdown) return { title, markdown };
  } catch {
    // DOM parse / conversion failed — fall through to tag-strip.
  }

  return { title: "", markdown: stripTags(html) };
}

export function createWebFetchHandler(): ToolHandler {
  return {
    schema: WEB_FETCH_SCHEMA,

    validate: (args) => {
      if (typeof args.url !== "string" || !args.url) {
        return { valid: false, error: "url is required and must be a string" };
      }
      try {
        const parsed = new URL(args.url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return { valid: false, error: "Only http/https URLs are supported" };
        }
      } catch {
        return { valid: false, error: "Invalid URL" };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const { url, maxBytes = DEFAULT_MAX_BYTES } = input.args as {
        url: string;
        maxBytes?: number;
      };

      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(url, {
            signal: ctrl.signal,
            headers: { "User-Agent": "Berne-Agent/1.0" },
          });
        } finally {
          clearTimeout(timer);
        }

        if (!res.ok) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error: `HTTP ${res.status}`,
            durationMs: Math.round(performance.now() - start),
          };
        }

        const buf = await res.arrayBuffer();
        const truncated = buf.byteLength > maxBytes;
        const bytes = Math.min(buf.byteLength, maxBytes);
        const raw = new TextDecoder().decode(buf.slice(0, bytes));

        const contentType = res.headers.get("content-type") ?? "";
        const isHtml = contentType.includes("html") || /^\s*<(?:!doctype|html)/i.test(raw);

        let title = "";
        let content = raw;
        if (isHtml) {
          const extracted = htmlToMarkdown(raw, url);
          title = extracted.title;
          content = extracted.markdown;
        }

        const result = {
          url,
          title,
          markdown: content,
          contentType,
          bytesFetched: bytes,
          truncated,
        };

        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: JSON.stringify(result),
          durationMs: Math.round(performance.now() - start),
        };
      } catch (err: unknown) {
        const durationMs = Math.round(performance.now() - start);
        const message =
          err instanceof Error
            ? err.name === "AbortError"
              ? "Timeout (10s)"
              : err.message
            : String(err);
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: message,
          durationMs,
        };
      }
    },
  };
}
