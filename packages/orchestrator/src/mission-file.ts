// ─── The mission file: where it lives, and how the model reads it ───
//
// The run's spine at full fidelity — goal, plan, log — is rendered to a file so
// the model can read it back whole when the injected block had to truncate.
// That file used to be `<workspace>/.rune/mission.md`, and that was wrong in
// three ways that are all the same mistake, a runtime artifact kept in the
// user's code:
//
//   * two sessions in one repository wrote the same path, so each one's
//     mission was whatever the other had last persisted;
//   * the run made its own tree dirty — a verdict proven against a clean tree
//     read `stale` because Rune had written beside it (lifecycle.ts carries an
//     exclusion for exactly this);
//   * it sat in a directory that also holds things the person owns
//     (`.rune/mcp.json`, `.rune/skills/`), in every project they ever opened.
//
// It now lives under the session's own directory in the Rune home.
//
// The model still reads it at the same name. `.rune/mission.md` is kept as a
// ROUTE, not a location: a `read_file` of that one path is answered here, from
// this session's file, before any tool touches the disk. That is the whole of
// the access the model gets. Nothing is opened under the Rune home on its
// behalf — no path into it is handed out, no read root is added, and the
// credentials, the database and the memory key beside the mission are exactly
// as unreachable as they were. A different session's mission is not reachable
// either: the route is answered by the call's own session id.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { getRuneHome } from "@rune/shared";
import type { ToolCallInput, ToolCallOutput, ToolHandler } from "@rune/tool-registry";

/** The name the model is given. Workspace-relative on purpose: it is FOR the model. */
export const MISSION_ROUTE = ".rune/mission.md";

/** A session id as one path segment: it must never be able to walk out of its directory. */
function segment(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return safe || "session";
}

/** Where a session's mission file lives. */
export function missionFilePath(sessionId: string, home: string = getRuneHome()): string {
  return join(home, "sessions", segment(sessionId), "mission.md");
}

/**
 * Write a session's mission. Atomic — a reader never sees half a file — and
 * best-effort at the call site: the event log is the source of truth, this is
 * the convenient copy of it.
 */
export function writeMission(sessionId: string, content: string, home?: string): void {
  const path = missionFilePath(sessionId, home);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, content, "utf8");
  renameSync(partial, path);
}

/** A session's mission, or `null` when it has none. */
export function readMission(sessionId: string, home?: string): string | null {
  try {
    return readFileSync(missionFilePath(sessionId, home), "utf8");
  } catch {
    return null;
  }
}

const CASE_BLIND = process.platform === "darwin" || process.platform === "win32";

/** Whether `path`, as a tool was handed it, names the mission route in this workspace. */
export function isMissionRoute(workspaceRoot: string, path: unknown): boolean {
  if (typeof path !== "string" || path.trim() === "") return false;
  let p = path.trim().replace(/\\/g, "/");
  if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
  const asked = isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p);
  const route = resolve(workspaceRoot, MISSION_ROUTE);
  return CASE_BLIND ? asked.toLowerCase() === route.toLowerCase() : asked === route;
}

/** The mission, in the shape `read_file` answers in: numbered lines and the file's own facts. */
function asReadResult(content: string, args: Record<string, unknown>): string {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const limit =
    typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : lines.length;
  const shown = lines.slice(offset, offset + limit);
  return JSON.stringify({
    bytes: Buffer.byteLength(content, "utf8"),
    content: shown.map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`).join("\n"),
    hash: createHash("sha256").update(content).digest("hex"),
    kind: "text",
    lines_shown: shown.length,
    offset,
    // The route, not the location: the name the model was given is the name
    // it gets back, and the only one that works.
    path: MISSION_ROUTE,
    total_lines: lines.length,
    truncated: offset + shown.length < lines.length,
  });
}

/**
 * `read_file`, answering the mission route from the session's own file.
 *
 * Only that one path, and only when this session HAS a mission. Everything
 * else — including the route itself for a session with none, which is how a
 * workspace still carrying a mission file from an older version keeps working
 * — goes to the real tool untouched.
 */
export function withMissionRoute(handler: ToolHandler, home?: () => string): ToolHandler {
  return {
    schema: handler.schema,
    validate: (args) => handler.validate(args),
    async execute(input: ToolCallInput): Promise<ToolCallOutput> {
      if (isMissionRoute(input.workspaceRoot, input.args.path)) {
        const mission = readMission(input.sessionId, home?.());
        if (mission !== null) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: true,
            result: asReadResult(mission, input.args),
            durationMs: 0,
          };
        }
      }
      return handler.execute(input);
    },
  };
}
