// ─── Resources and prompts, made reachable ───
//
// A connector's tools were the only part of it Gear could see. Resources — the
// documents, pages and records a server exposes read-only — and prompts, the
// server's own canned instructions, were both answered with -32601.
//
// They become two things a person and a model already understand:
//
//   read_resource        one tool across ALL servers, rather than one per
//                        server. A user with four connectors gets one schema,
//                        not four, and the model does not have to learn which
//                        server owns which URI before it can read anything.
//   @server:uri          a mention in the composer, expanded before the turn
//   /server:prompt       a slash command, expanded to the messages it stands for

import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import type { McpClient } from "./client";
import type { McpResource } from "./types";

export const READ_RESOURCE_TOOL = "read_resource";

/** How a resource is addressed everywhere in the product: `@server:uri`. */
export function resourceMention(server: string, uri: string): string {
  return `@${server}:${uri}`;
}

/** Parse `@server:uri` (or `server:uri`) back into its parts. */
export function parseResourceMention(text: string): { server: string; uri: string } | null {
  const m = /^@?([A-Za-z0-9_-]+):(\S+)$/.exec(text.trim());
  if (!m) return null;
  return { server: m[1], uri: m[2] };
}

/**
 * Every `@server:uri` mention in a composer line.
 *
 * Bounded on purpose: a message that mentions thirty resources is a mistake,
 * and expanding all of them would blow the turn's context before it starts.
 */
export function findResourceMentions(
  text: string,
  limit = 10,
): Array<{ server: string; uri: string }> {
  const out: Array<{ server: string; uri: string }> = [];
  const re = /@([A-Za-z0-9_-]+):([^\s,;)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < limit) {
    out.push({ server: m[1], uri: m[2] });
  }
  return out;
}

/** Longest single resource we inline into a turn. Past this it is a file, not a mention. */
const MAX_RESOURCE_CHARS = 60_000;

/** Render one server's resource contents as text the model can read. */
export async function readResourceText(
  client: McpClient,
  uri: string,
): Promise<{ text: string; truncated: boolean }> {
  const contents = await client.readResource(uri);
  const parts: string[] = [];
  for (const c of contents) {
    if (typeof c.text === "string") parts.push(c.text);
    else if (typeof c.blob === "string") {
      parts.push(
        `[binary resource ${c.uri ?? uri}${c.mimeType ? ` (${c.mimeType})` : ""}, ${c.blob.length} base64 bytes]`,
      );
    }
  }
  const joined = parts.join("\n");
  return joined.length > MAX_RESOURCE_CHARS
    ? { text: joined.slice(0, MAX_RESOURCE_CHARS) + "\n[truncated]", truncated: true }
    : { text: joined, truncated: false };
}

export interface ResourceRegistry {
  /** Ready clients that declared a resources capability, by server name. */
  clients(): Map<string, McpClient>;
}

/**
 * ONE `read_resource` tool spanning every connector.
 *
 * The alternative — a tool per server — costs a schema per connector on every
 * request and makes the model choose a tool before it knows which server holds
 * the thing. This takes `@server:uri` (the same string a person types in the
 * composer) and does the routing itself.
 */
export function createReadResourceTool(registry: ResourceRegistry): ToolHandler {
  const schema: ToolSchema = {
    name: READ_RESOURCE_TOOL,
    version: "1.0.0",
    description:
      "Read a document, page or record exposed by a connected service. Address it as " +
      "`@server:uri` — the same form you can type in the composer. Call with no `uri` to " +
      "list what every connected service exposes.",
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description: "`@server:uri`, e.g. @notion:notion://page/abc123. Omit to list.",
        },
      },
    },
    permissionLevel: "auto",
    category: "read",
  };

  return {
    schema,
    validate: (args) => {
      const uri = (args as { uri?: unknown }).uri;
      if (uri !== undefined && typeof uri !== "string") {
        return { valid: false, error: "uri must be a string of the form @server:uri" };
      }
      return { valid: true };
    },
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const done = (result: string, error?: string): ToolCallOutput => ({
        callId: input.callId,
        toolName: input.toolName,
        success: !error,
        result,
        error,
        durationMs: Math.round(performance.now() - start),
      });

      const clients = registry.clients();
      const raw = String((input.args as { uri?: string }).uri ?? "").trim();

      // No uri: the catalogue. This is what makes the tool usable without the
      // model having to guess a URI scheme it has never seen.
      if (!raw) {
        if (clients.size === 0) return done("No connected service exposes resources.");
        const lines: string[] = [];
        for (const [server, client] of clients) {
          const resources = await client.listResources();
          if (resources.length === 0) continue;
          lines.push(
            `[${server}] ${resources.length} resource${resources.length === 1 ? "" : "s"}`,
          );
          for (const r of resources.slice(0, 50)) {
            lines.push(
              `  ${resourceMention(server, r.uri)}${r.name ? ` — ${r.name}` : ""}${r.mimeType ? ` (${r.mimeType})` : ""}`,
            );
          }
          if (resources.length > 50) lines.push(`  … ${resources.length - 50} more`);
        }
        return done(lines.length > 0 ? lines.join("\n") : "No resources are exposed.");
      }

      const parsed = parseResourceMention(raw);
      if (!parsed) {
        return done("", `"${raw}" is not a resource address — use @server:uri`);
      }
      const client = clients.get(parsed.server);
      if (!client) {
        const known = [...clients.keys()];
        return done(
          "",
          `no connected service named "${parsed.server}"` +
            (known.length > 0 ? `; available: ${known.join(", ")}` : ""),
        );
      }
      try {
        const { text } = await readResourceText(client, parsed.uri);
        return done(text || `[${raw} is empty]`);
      } catch (err) {
        return done("", err instanceof Error ? err.message : String(err));
      }
    },
  };
}

// ─── Prompts as slash commands ───

export interface McpPromptCommand {
  /** The slash command name: `server:prompt`. */
  name: string;
  server: string;
  prompt: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** Every connected server's prompts, as slash commands. */
export async function collectPromptCommands(
  clients: Map<string, McpClient>,
): Promise<McpPromptCommand[]> {
  const out: McpPromptCommand[] = [];
  for (const [server, client] of clients) {
    if (!client.supportsPrompts) continue;
    for (const p of await client.listPrompts()) {
      out.push({
        name: `${server}:${p.name}`,
        server,
        prompt: p.name,
        description: p.description ?? p.title,
        arguments: p.arguments,
      });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Expand one prompt command into the text a turn starts from.
 *
 * Positional arguments are matched against the prompt's declared argument
 * names in order, because that is what a person typing `/notion:summarize
 * page-123` means. `name=value` pairs are honoured too, for the cases where
 * order is not obvious.
 */
export async function expandPromptCommand(
  clients: Map<string, McpClient>,
  command: McpPromptCommand,
  argv: string[],
): Promise<string> {
  const args: Record<string, string> = {};
  const positional: string[] = [];
  for (const token of argv) {
    const eq = token.indexOf("=");
    if (eq > 0 && /^[A-Za-z0-9_-]+$/.test(token.slice(0, eq))) {
      args[token.slice(0, eq)] = token.slice(eq + 1);
    } else {
      positional.push(token);
    }
  }
  const declared = command.arguments ?? [];
  for (let i = 0; i < positional.length && i < declared.length; i++) {
    if (!(declared[i].name in args)) args[declared[i].name] = positional[i];
  }
  // Anything left over joins the last declared argument, so a multi-word
  // final argument does not need quoting.
  if (positional.length > declared.length && declared.length > 0) {
    const last = declared[declared.length - 1].name;
    args[last] = positional.slice(declared.length - 1).join(" ");
  }

  const client = clients.get(command.server);
  if (!client) throw new Error(`connector "${command.server}" is not connected`);
  const result = await client.getPrompt(command.prompt, args);
  const parts: string[] = [];
  for (const m of result.messages ?? []) {
    const text = m.content?.text ?? "";
    if (text) parts.push(m.role === "assistant" ? `[${command.server}] ${text}` : text);
  }
  return parts.join("\n\n") || (result.description ?? "");
}

/** A compact listing of the resources a server exposes, for a status readout. */
export function describeResources(server: string, resources: McpResource[]): string {
  if (resources.length === 0) return `${server}: no resources`;
  const sample = resources
    .slice(0, 3)
    .map((r) => r.name ?? r.uri)
    .join(", ");
  return `${server}: ${resources.length} resource${resources.length === 1 ? "" : "s"} (${sample}${resources.length > 3 ? ", …" : ""})`;
}
