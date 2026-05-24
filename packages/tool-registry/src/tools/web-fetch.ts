import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

export const WEB_FETCH_SCHEMA: ToolSchema = {
  name: "web_fetch",
  version: "0.1.0",
  description:
    "Fetch content from a URL. Returns text content with HTML tags stripped.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      maxBytes: {
        type: "number",
        description: "Max bytes to read (default 1MB)",
      },
    },
    required: ["url"],
  },
  permissionLevel: "confirm",
  category: "network",
};

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
      const { url, maxBytes = 1048576 } = input.args as {
        url: string;
        maxBytes?: number;
      };

      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: { "User-Agent": "Alan-Agent/1.0" },
        });
        clearTimeout(timer);

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
        const bytes = Math.min(buf.byteLength, maxBytes);
        let content = new TextDecoder().decode(buf.slice(0, bytes));

        // Strip HTML if content-type indicates HTML
        if ((res.headers.get("content-type") || "").includes("html")) {
          content = content
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }

        const result = {
          content,
          statusCode: res.status,
          bytesFetched: bytes,
          truncated: buf.byteLength > maxBytes,
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
