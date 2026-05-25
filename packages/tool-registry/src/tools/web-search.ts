import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

export const WEB_SEARCH_SCHEMA: ToolSchema = {
  name: "web_search",
  version: "0.1.0",
  description: "Search the web via DuckDuckGo. No API key needed.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: {
        type: "number",
        description: "Max results to return (default 5)",
      },
    },
    required: ["query"],
  },
  permissionLevel: "confirm",
  category: "network",
};

export function createWebSearchHandler(): ToolHandler {
  return {
    schema: WEB_SEARCH_SCHEMA,

    validate: (args) => {
      if (typeof args.query !== "string" || !args.query.trim()) {
        return { valid: false, error: "query is required and must be a non-empty string" };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const { query, maxResults = 5 } = input.args as {
        query: string;
        maxResults?: number;
      };

      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: { "User-Agent": "Alan-Agent/1.0" },
        });
        clearTimeout(timer);

        const html = await res.text();
        const results: { title: string; url: string; snippet: string }[] = [];
        const regex =
          /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

        let m;
        while ((m = regex.exec(html)) && results.length < maxResults) {
          const rUrl = decodeURIComponent((m[1].match(/uddg=([^&]+)/) || [])[1] || m[1]);
          const title = m[2].replace(/<[^>]+>/g, "").trim();
          const snippet = m[3].replace(/<[^>]+>/g, "").trim();
          if (title && rUrl) {
            results.push({ title, url: rUrl, snippet });
          }
        }

        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: JSON.stringify({ results }),
          durationMs: Math.round(performance.now() - start),
        };
      } catch (err: unknown) {
        const durationMs = Math.round(performance.now() - start);
        const message = err instanceof Error ? err.message : String(err);
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
