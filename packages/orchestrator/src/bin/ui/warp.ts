// ─── Warp's CLI-agent channel ───
//
// Warp watches every pane's tty for OSC 777 notifications addressed to
// `warp://cli-agent`, and uses them to drive the things a terminal can only
// know if the program tells it: whether this pane is mid-turn, whether the run
// finished, and whether it needs the user back. Without them Warp sees an
// ordinary shell doing ordinary output.
//
//   ESC ] 777 ; notify ; warp://cli-agent ; {json} BEL
//
// What this does NOT buy is the logo. Warp picks an agent's icon by matching
// the launched command against its own list of known agents — claude, codex,
// gemini and so on — so a third-party CLI cannot supply one from here however
// it identifies itself in the payload. That is a request to Warp, not a
// sequence we can emit.
//
// Gated on running inside Warp. Every other terminal ignores an unknown OSC
// harmlessly, but a sequence nothing reads is still a sequence in the
// transcript, and this surface's whole argument is that what reaches the
// terminal is chosen.

const ESC = "\x1b";
const BEL = "\x07";

export type WarpEvent =
  "session_start" | "prompt_submit" | "tool_complete" | "stop" | "idle_prompt";

export interface WarpNotice {
  event: WarpEvent;
  sessionId: string;
  cwd: string;
  /** Truncated, and only where it genuinely helps the notification read. */
  query?: string;
  response?: string;
  toolName?: string;
}

/** Warp identifies itself here; nothing else claims this value. */
export function isWarp(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TERM_PROGRAM ?? "").toLowerCase() === "warpterminal";
}

/** Notifications carry user text, so they are clipped hard before they leave. */
function clip(value: string | undefined, max = 120): string | undefined {
  if (!value) return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  // ASCII: this string leaves the process as JSON for another program to
  // render, so it answers to that program's font, not our glyph budget.
  return flat.length > max ? flat.slice(0, max - 3) + "..." : flat;
}

/**
 * The sequence for one event, or "" when there is nobody to read it.
 *
 * Pure and exported so the payload can be asserted without a terminal — the
 * failure worth catching here is a malformed body, which Warp would drop in
 * silence, leaving a feature that looks implemented and does nothing.
 */
export function warpNotice(notice: WarpNotice, version: string, env = process.env): string {
  if (!isWarp(env)) return "";
  const body: Record<string, unknown> = {
    v: 1,
    agent: "gear",
    event: notice.event,
    session_id: notice.sessionId,
    cwd: notice.cwd,
    project: notice.cwd.split("/").filter(Boolean).pop() ?? "",
    plugin_version: version,
  };
  const query = clip(notice.query);
  const response = clip(notice.response);
  if (query) body.query = query;
  if (response) body.response = response;
  if (notice.toolName) body.tool_name = notice.toolName;
  // JSON.stringify escapes every control character, so a payload can never
  // carry a stray BEL and terminate its own sequence early.
  return `${ESC}]777;notify;warp://cli-agent;${JSON.stringify(body)}${BEL}`;
}

/** Write one, best-effort. A notification must never interrupt a session. */
export function notifyWarp(notice: WarpNotice, version: string): void {
  const seq = warpNotice(notice, version);
  if (!seq) return;
  try {
    process.stdout.write(seq);
  } catch {
    // The terminal is gone; there is nothing to tell.
  }
}
