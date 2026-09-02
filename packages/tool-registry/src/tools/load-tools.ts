// ─── Deferred tool loading: a catalog in the prompt, schemas on demand ───
//
// Every tool definition costs tokens on EVERY request, forever. A session with
// two 20-tool MCP connectors was paying ~40 full JSON schemas per turn — most
// of them for tools the run would never call. The measured fixed overhead was
// 14,617 tokens (prompts.ts), of which tool schemas are the part that grows
// without bound as a user connects more services.
//
// The trade here is the one the model can actually reason about: a DEFERRED
// tool still appears in the prompt, as one catalog line (name + a sentence),
// so the model knows the capability exists and can ask for it. `load_tools`
// returns the full schemas and promotes them to eagerly-advertised for the
// rest of the run, so the second call to a loaded tool costs nothing extra.
//
// Two deliberate choices:
//
//   * The catalog lives in THIS tool's own description, rebuilt at every
//     advertisement. That means no separate prompt block to keep in sync, no
//     agent-loop change, and the catalog shrinks as tools are loaded — a run
//     that loads everything ends up paying exactly what it paid before.
//   * When nothing is deferred, `load_tools` is not advertised at all. A
//     session with no connectors pays zero for this mechanism.

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import type { ToolRegistry } from "../registry";

/** The name the model calls to promote deferred tools to full schemas. */
export const LOAD_TOOLS_TOOL = "load_tools";

/**
 * Built-ins that ship deferred rather than eager.
 *
 * `n8n_trigger` is an opt-in workflow integration: with no N8N_BASE_URL it is
 * already gated out entirely, and even when configured it is a rarely-reached
 * capability whose schema does not earn a slot on every request.
 */
export const DEFERRED_BUILTINS = new Set<string>(["n8n_trigger"]);

/** MCP tools carry this prefix (see McpClient.createHandler). */
const MCP_PREFIX = "mcp_";

/**
 * Whether a tool is catalogued rather than fully advertised, by default.
 *
 * MCP tools defer because they are the unbounded set — a user can connect ten
 * servers and no per-request budget survives that. Built-ins stay eager
 * because they are the core loop: deferring `read_file` to save 200 tokens
 * would buy an extra round-trip on nearly every turn.
 */
export function deferredByDefault(name: string): boolean {
  return name.startsWith(MCP_PREFIX) || DEFERRED_BUILTINS.has(name);
}

/** One catalog line: what the model sees instead of a full schema. */
export interface DeferredEntry {
  name: string;
  /** First sentence of the tool's description, trimmed to one line. */
  summary: string;
}

/** Longest catalog summary we keep. Past this a description is prose, not a label. */
const MAX_SUMMARY_CHARS = 110;

/** The one line that stands in for a schema: first sentence, single line, capped. */
export function catalogSummary(description: string | undefined): string {
  if (!description) return "";
  const flat = description.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // First sentence, when one ends early enough to be a real summary.
  const stop = flat.search(/[.!?](\s|$)/);
  const first = stop > 0 && stop < MAX_SUMMARY_CHARS ? flat.slice(0, stop) : flat;
  return first.length > MAX_SUMMARY_CHARS ? first.slice(0, MAX_SUMMARY_CHARS - 1) + "…" : first;
}

/**
 * The `load_tools` description carrying the current catalog.
 *
 * Rebuilt on every advertisement so it always reflects what is still deferred.
 * Grouped by server prefix because a person reading the transcript — and a
 * model choosing what to load — both think in connectors, not tool names.
 */
export function renderCatalog(entries: DeferredEntry[]): string {
  const head =
    "Load the full schemas for tools that are available but not yet described in detail. " +
    "Call this with the names you need BEFORE calling them; the schemas stay loaded for the " +
    "rest of the session. Tools you can load:";

  const groups = new Map<string, DeferredEntry[]>();
  for (const e of entries) {
    const m = e.name.startsWith(MCP_PREFIX) ? e.name.slice(MCP_PREFIX.length).split("_")[0] : "";
    const key = m || "built-in";
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const lines: string[] = [head];
  for (const [group, list] of groups) {
    lines.push(`\n[${group}]`);
    for (const e of list) {
      lines.push(e.summary ? `  ${e.name} — ${e.summary}` : `  ${e.name}`);
    }
  }
  return lines.join("\n");
}

export const LOAD_TOOLS_SCHEMA: ToolSchema = {
  name: LOAD_TOOLS_TOOL,
  version: "1.0.0",
  description: renderCatalog([]),
  inputSchema: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description: "Tool names to load, exactly as listed in the catalog above.",
      },
    },
    required: ["names"],
  },
  permissionLevel: "auto",
  category: "read",
};

/**
 * The built-in that turns a catalog line into a usable tool.
 *
 * Returns the full JSON schema of each requested tool and registers it as
 * eagerly-advertised, so the model can call it on the very next turn without
 * carrying the schema in its head.
 */
export function createLoadToolsTool(registry: ToolRegistry): ToolHandler {
  return {
    schema: LOAD_TOOLS_SCHEMA,
    validate: (args) => {
      const names = (args as { names?: unknown }).names;
      if (!Array.isArray(names) || names.length === 0) {
        return { valid: false, error: "names must be a non-empty array of tool names" };
      }
      if (names.some((n) => typeof n !== "string")) {
        return { valid: false, error: "names must contain only strings" };
      }
      return { valid: true };
    },
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const requested = ((input.args as { names?: string[] }).names ?? []).map((n) => n.trim());
      const { loaded, unknown } = registry.activateTools(requested);

      const parts: string[] = [];
      if (loaded.length > 0) {
        parts.push(
          `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. Full schemas:`,
          "```json",
          JSON.stringify(loaded, null, 2),
          "```",
          "These are now advertised normally — call them directly from here on.",
        );
      }
      if (unknown.length > 0) {
        // Naming a near miss beats "not found": the model's next move is
        // usually the right tool with a slightly wrong name.
        const available = registry.deferredCatalog().map((e) => e.name);
        parts.push(
          `Not found: ${unknown.join(", ")}.` +
            (available.length > 0
              ? ` Loadable names are: ${available.slice(0, 40).join(", ")}${available.length > 40 ? ", …" : ""}`
              : " No tools are currently deferred."),
        );
      }

      return {
        callId: input.callId,
        toolName: input.toolName,
        success: loaded.length > 0 || unknown.length === 0,
        result: parts.join("\n"),
        error:
          loaded.length === 0 && unknown.length > 0
            ? `no such tool(s): ${unknown.join(", ")}`
            : undefined,
        durationMs: Math.round(performance.now() - start),
      };
    },
  };
}
