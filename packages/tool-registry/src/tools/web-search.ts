import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import { selectBackends } from "./search/index";
import type { SearchBackend, SearchResponse } from "./search/index";

export const WEB_SEARCH_SCHEMA: ToolSchema = {
  name: "web_search",
  version: "0.2.0",
  description:
    "Search the web for current information. Uses the Tavily or Brave API when a key is set " +
    "(TAVILY_API_KEY / BRAVE_API_KEY), otherwise falls back to DuckDuckGo — no key required. " +
    "Returns ranked results with titles, URLs, and snippets. Set recencyDays to bias toward the " +
    "freshest results (latest news/updates).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: {
        type: "number",
        description: "Max results to return (default 5)",
      },
      recencyDays: {
        type: "number",
        description: "Only include results from the last N days — use for the latest news/updates",
      },
    },
    required: ["query"],
  },
  permissionLevel: "confirm",
  category: "network",
};

/**
 * Create the web_search handler. Backends are chosen at call time (so a key
 * added mid-session is picked up) and tried in priority order; the handler
 * falls through to the next backend when one errors or returns nothing.
 *
 * @param backendsFor - injectable backend selector (defaults to env-based selection; used by tests)
 */
export function createWebSearchHandler(
  backendsFor: () => SearchBackend[] = () => selectBackends(),
): ToolHandler {
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
      const {
        query,
        maxResults = 5,
        recencyDays,
      } = input.args as {
        query: string;
        maxResults?: number;
        recencyDays?: number;
      };

      const backends = backendsFor();
      const errors: string[] = [];

      for (const backend of backends) {
        try {
          const resp: SearchResponse = await backend.search(query, { maxResults, recencyDays });
          if (resp.results.length === 0 && !resp.answer) {
            errors.push(`${backend.name}: no results`);
            continue;
          }
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: true,
            result: JSON.stringify({
              backend: backend.name,
              query,
              answer: resp.answer,
              results: resp.results,
            }),
            durationMs: Math.round(performance.now() - start),
          };
        } catch (err) {
          errors.push(`${backend.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return {
        callId: input.callId,
        toolName: input.toolName,
        success: false,
        result: "",
        error:
          errors.length > 0
            ? `All search backends failed — ${errors.join("; ")}`
            : "No search backend available",
        durationMs: Math.round(performance.now() - start),
      };
    },
  };
}
