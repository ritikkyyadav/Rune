import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import { selectBackends } from "./search/index";
import type { SearchBackend, SearchResponse } from "./search/index";

/** How long a rate-limited backend sits out. */
export const BACKEND_COOLDOWN_MS = 10 * 60_000;
const RATE_LIMITED_RE = /\b429\b|rate.?limit|too many requests/i;

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
 * A backend that answers with a rate limit is skipped for `cooldownMs` (ten
 * minutes by default) and the next backend answers in the same call. Brave
 * once returned 429 on fifteen consecutive searches in an afternoon and was
 * tried first every time.
 *
 * @param backendsFor - injectable backend selector (defaults to env-based selection; used by tests)
 */
export function createWebSearchHandler(
  backendsFor: () => SearchBackend[] = () => selectBackends(),
  opts: { cooldownMs?: number; now?: () => number } = {},
): ToolHandler {
  const cooldownMs = opts.cooldownMs ?? BACKEND_COOLDOWN_MS;
  const now = opts.now ?? (() => Date.now());
  const coolingUntil = new Map<string, number>();
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
        const until = coolingUntil.get(backend.name);
        if (until !== undefined && until > now()) {
          errors.push(`${backend.name}: cooling down after a rate limit`);
          continue;
        }
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
          const message = err instanceof Error ? err.message : String(err);
          if (RATE_LIMITED_RE.test(message)) coolingUntil.set(backend.name, now() + cooldownMs);
          errors.push(`${backend.name}: ${message}`);
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
