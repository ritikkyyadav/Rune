// ─── `/mcp`: what is connected, and what is wrong with what is not ───
//
// The panel existed twice — once in the TUI and once in the readline fallback —
// with two spellings of the same rows and two different sets of facts. That is
// how a dialect starts. One builder now, used by both, standing on flowRow like
// every other content row in the product.
//
// It answers four questions and no others: which connectors are configured,
// whether each one is up, how many tools it is contributing, and — when it is
// not up — the reason and the command that fixes it.

import type { McpServerStatus } from "@rune/tool-registry";
import { BODY, MARK, RAIL_IN, flowRow, receiptOf } from "./flow";
import { glyph } from "./glyphs";
import { bold, danger, faint, info, ok, quiet, text, warn } from "./theme";

/** Connected, connecting, degraded, needs login, down — in the user's words. */
export type McpHealthWord = "connected" | "connecting" | "degraded" | "needs login" | "down";

export function mcpHealthWord(server: McpServerStatus): McpHealthWord {
  if (server.needsAuth) return "needs login";
  if (server.ready) return server.health === "degraded" ? "degraded" : "connected";
  // No client, no error yet: the handshake is still in flight. Saying "down"
  // for a server that has not finished starting is the kind of small lie that
  // sends someone to debug a connector that was about to work.
  if (!server.lastError) return "connecting";
  return "down";
}

function paintHealth(word: McpHealthWord): string {
  if (word === "connected") return ok(word);
  if (word === "degraded" || word === "connecting") return warn(word);
  return danger(word);
}

function mark(word: McpHealthWord): string {
  if (word === "connected") return ok(glyph("live"));
  if (word === "degraded" || word === "connecting") return warn(glyph("live"));
  return faint(glyph("live"));
}

/** The one-line fix for a connector that is not up. */
export function mcpRemedy(server: McpServerStatus): string | null {
  const word = mcpHealthWord(server);
  if (word === "connected" || word === "connecting") return null;
  if (word === "needs login") return `rune mcp login ${server.name}`;
  if (word === "degraded") return `/mcp reconnect ${server.name}`;
  return `rune mcp doctor`;
}

/**
 * The whole panel, as lines.
 *
 * Tool NAMES are deliberately not listed. A connector with forty tools turned
 * `/mcp` into a wall the four facts above had to be hunted out of; the count
 * is the number a person acts on, and the names are one `/tools` away.
 */
export function mcpPanel(servers: McpServerStatus[]): string {
  const total = servers.reduce((sum, s) => sum + s.toolCount, 0);
  const up = servers.filter((s) => mcpHealthWord(s) === "connected").length;
  const head = flowRow(
    `${MARK}${bold(text("MCP connectors"))}`,
    servers.length === 0
      ? ""
      : quiet(receiptOf([`${up}/${servers.length} connected`, `${total} tools`])),
  );

  if (servers.length === 0) {
    return [
      head,
      flowRow(`${BODY}${quiet("None configured.")}`),
      flowRow(`${BODY}${faint("add one")}  ${info("rune mcp add notion")}`),
    ].join("\n");
  }

  const lines = [head];
  for (const server of servers) {
    const word = mcpHealthWord(server);
    lines.push(
      flowRow(
        `${BODY}${mark(word)} ${text(server.name)}`,
        receiptOf([
          paintHealth(word),
          quiet(server.dialect ?? server.kind),
          quiet(`${server.toolCount} tools`),
        ]),
      ),
    );
    if (server.lastError) {
      lines.push(flowRow(`${RAIL_IN}${faint(server.lastError.replace(/\s+/g, " "))}`));
    }
    const remedy = mcpRemedy(server);
    if (remedy) lines.push(flowRow(`${RAIL_IN}${faint("fix")}  ${info(remedy)}`));
  }
  lines.push(flowRow(`${BODY}${faint("reconnect one")}  ${info("/mcp reconnect <server>")}`));
  return lines.join("\n");
}
