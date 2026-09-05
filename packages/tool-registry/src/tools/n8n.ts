import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

const MAX_BODY_BYTES = 4096; // ~4KB
const TIMEOUT_MS = 30_000;

export const N8N_TRIGGER_SCHEMA: ToolSchema = {
  name: "n8n_trigger",
  version: "0.1.0",
  description:
    "Triggers an n8n workflow via its webhook and returns the response. Provide either a full webhook_url or a workflow id/path (resolved against N8N_BASE_URL).",
  inputSchema: {
    type: "object",
    properties: {
      webhook_url: {
        type: "string",
        description: "Full n8n webhook URL to trigger. Either this or workflow is required.",
      },
      workflow: {
        type: "string",
        description:
          "Workflow webhook id/path, resolved as ${N8N_BASE_URL}/webhook/${workflow}. Either this or webhook_url is required.",
      },
      payload: {
        type: "object",
        description: "JSON payload to send (POST only).",
      },
      method: {
        type: "string",
        enum: ["GET", "POST"],
        description: "HTTP method (default POST).",
      },
    },
  },
  permissionLevel: "confirm",
  category: "network",
};

interface N8nArgs {
  webhook_url?: string;
  workflow?: string;
  payload?: Record<string, unknown>;
  method?: "GET" | "POST";
}

/**
 * Resolve the target webhook URL from the provided args + environment.
 * Returns the URL string, or an error message describing what is missing.
 */
function resolveUrl(args: N8nArgs): { url?: string; error?: string } {
  if (typeof args.webhook_url === "string" && args.webhook_url) {
    return { url: args.webhook_url };
  }
  if (typeof args.workflow === "string" && args.workflow) {
    const base = process.env.N8N_BASE_URL;
    if (!base) {
      return {
        error:
          "workflow was given but N8N_BASE_URL is not set. Set N8N_BASE_URL or pass a full webhook_url.",
      };
    }
    const trimmedBase = base.replace(/\/+$/, "");
    const trimmedWorkflow = args.workflow.replace(/^\/+/, "");
    return { url: `${trimmedBase}/webhook/${trimmedWorkflow}` };
  }
  return { error: "Either webhook_url or workflow is required." };
}

export function createN8nTriggerHandler(): ToolHandler {
  return {
    schema: N8N_TRIGGER_SCHEMA,

    validate: (args) => {
      const hasWebhook = typeof args.webhook_url === "string" && args.webhook_url.length > 0;
      const hasWorkflow = typeof args.workflow === "string" && args.workflow.length > 0;
      if (!hasWebhook && !hasWorkflow) {
        return { valid: false, error: "Either webhook_url or workflow is required" };
      }
      if (args.method !== undefined && args.method !== "GET" && args.method !== "POST") {
        return { valid: false, error: "method must be either GET or POST" };
      }
      if (args.payload !== undefined) {
        if (
          typeof args.payload !== "object" ||
          args.payload === null ||
          Array.isArray(args.payload)
        ) {
          return { valid: false, error: "payload must be an object" };
        }
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const args = input.args as N8nArgs;
      const method = args.method ?? "POST";

      const { url, error: resolveError } = resolveUrl(args);
      if (!url) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: resolveError ?? "Could not resolve webhook URL",
          durationMs: Math.round(performance.now() - start),
        };
      }

      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

        const init: RequestInit = {
          method,
          signal: ctrl.signal,
          headers: { "User-Agent": "Rune-Agent/1.0" },
        };
        if (method === "POST") {
          (init.headers as Record<string, string>)["Content-Type"] = "application/json";
          init.body = JSON.stringify(args.payload ?? {});
        }

        let res: Response;
        try {
          res = await fetch(url, init);
        } finally {
          clearTimeout(timer);
        }

        const rawBody = await res.text();
        const body = rawBody.length > MAX_BODY_BYTES ? rawBody.slice(0, MAX_BODY_BYTES) : rawBody;

        if (!res.ok) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error: `n8n returned HTTP ${res.status}: ${body || res.statusText}`,
            durationMs: Math.round(performance.now() - start),
          };
        }

        const result = {
          status: res.status,
          ok: res.ok,
          body,
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
              ? `Timeout (${TIMEOUT_MS / 1000}s)`
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
