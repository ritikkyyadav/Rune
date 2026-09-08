/**
 * `/mcp` under the grammar law.
 *
 * The panel existed twice — once in the TUI, once in the readline fallback —
 * with two spellings and two different sets of facts, which is what a fifth
 * dialect looks like on the day it is born. One builder now, and these tests
 * hold it to the same three rules the rest of the transcript obeys: one left
 * edge, three indent rungs, one receipt separator.
 *
 * They also pin the words. "down" for a connector that is still handshaking is
 * a small lie that sends someone to debug something that was about to work.
 */

import { describe, expect, it } from "bun:test";
import type { McpServerStatus } from "@rune/tool-registry";
import {
  mcpHealthWord,
  mcpPanel,
  mcpRemedy,
} from "../../../packages/orchestrator/src/bin/ui/mcp-panel";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../../packages/orchestrator/src/bin/ui/render";

const plain = (s: string) => stripAnsi(s);

/** The signature of padding to a far margin, as ui-grammar.test.ts defines it. */
function hasFarMarginGap(line: string): boolean {
  return /\S {4,}\S/.test(plain(line).slice(8));
}

function server(over: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    name: "files",
    ready: true,
    kind: "stdio",
    dialect: "stdio",
    toolCount: 14,
    tools: [],
    health: "healthy",
    protocolVersion: "2025-06-18",
    lastError: null,
    ...over,
  };
}

describe("/mcp — the health word", () => {
  it("connected when the handshake finished and pings answer", () => {
    expect(mcpHealthWord(server())).toBe("connected");
  });

  it("degraded when pings are failing but the connector is up", () => {
    expect(mcpHealthWord(server({ health: "degraded" }))).toBe("degraded");
  });

  it("connecting — not down — when nothing has failed yet", () => {
    expect(mcpHealthWord(server({ ready: false, health: "down", lastError: null }))).toBe(
      "connecting",
    );
  });

  it("down once there is a reason", () => {
    expect(
      mcpHealthWord(server({ ready: false, health: "down", lastError: "process exited (code 1)" })),
    ).toBe("down");
  });

  it("needs login outranks everything, because it is the actionable one", () => {
    expect(
      mcpHealthWord(server({ ready: false, health: "down", needsAuth: true, lastError: "401" })),
    ).toBe("needs login");
  });
});

describe("/mcp — the remedy", () => {
  it("offers nothing for a healthy connector", () => {
    expect(mcpRemedy(server())).toBeNull();
  });

  it("offers nothing while it is still connecting", () => {
    expect(mcpRemedy(server({ ready: false, lastError: null }))).toBeNull();
  });

  it("names the login command for an unauthorized connector", () => {
    expect(mcpRemedy(server({ name: "notion", needsAuth: true }))).toBe("rune mcp login notion");
  });

  it("sends a down connector to the doctor", () => {
    expect(mcpRemedy(server({ ready: false, lastError: "boom" }))).toBe("rune mcp doctor");
  });
});

describe("/mcp — the grammar law", () => {
  const panels = (): Array<[string, string]> => [
    ["empty", mcpPanel([])],
    [
      "mixed",
      mcpPanel([
        server(),
        server({ name: "memory", toolCount: 9 }),
        server({
          name: "everything-http",
          kind: "http",
          dialect: "sse",
          toolCount: 13,
        }),
        server({
          name: "notion",
          kind: "http",
          dialect: "http",
          ready: false,
          health: "down",
          toolCount: 0,
          needsAuth: true,
          lastError: "MCP HTTP 401 unauthorized",
        }),
        server({
          name: "a-connector-with-a-long-name",
          ready: false,
          health: "down",
          toolCount: 0,
          lastError:
            "process exited (code 1); stderr: Error: ENOENT: no such file or directory, scandir '/Users/someone/Projects/Alan'",
        }),
      ]),
    ],
  ];

  it("never pads to the right margin, at any terminal width", () => {
    for (const columns of [60, 100, 160, 240]) {
      setTermWidthOverride(columns);
      for (const [name, block] of panels()) {
        for (const line of block.split("\n")) {
          expect(
            hasFarMarginGap(line),
            `${name} @ ${columns}: ${JSON.stringify(plain(line))}`,
          ).toBe(false);
          expect(plain(line).length, `${name} @ ${columns}`).toBeLessThanOrEqual(columns);
        }
      }
    }
    setTermWidthOverride(undefined as unknown as number);
  });

  it("stands on the three rungs and no others", () => {
    setTermWidthOverride(120);
    for (const [name, block] of panels()) {
      for (const line of block.split("\n").filter((l) => plain(l).trim())) {
        const indent = plain(line).match(/^ */)![0].length;
        expect([F.MARK.length, F.BODY.length, F.RAIL_IN.length], `${name}`).toContain(indent);
      }
    }
    setTermWidthOverride(undefined as unknown as number);
  });

  it("says what a person acts on: health, dialect, tool count, the fix", () => {
    setTermWidthOverride(160);
    expect(plain(mcpPanel([]))).toContain("None configured");

    const real = plain(
      mcpPanel([server(), server({ name: "notion", ready: false, needsAuth: true, toolCount: 0 })]),
    );
    expect(real).toContain("files");
    expect(real).toContain("connected");
    expect(real).toContain("14 tools");
    expect(real).toContain("needs login");
    expect(real).toContain("rune mcp login notion");
    expect(real).toContain("/mcp reconnect <server>");
    // The count in the head is the pair of numbers the panel exists to give.
    expect(real).toContain("1/2 connected");
    setTermWidthOverride(undefined as unknown as number);
  });

  it("does not list tool names — a forty-tool connector is not a wall", () => {
    const block = plain(
      mcpPanel([server({ tools: ["read_file", "write_file", "list_directory"] })]),
    );
    expect(block).not.toContain("read_file");
  });
});
