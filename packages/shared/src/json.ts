// ─── Defensive JSON for model output ───
// Tool-call `arguments` come straight from the model and are NOT trustworthy JSON: smaller /
// cheaper models (glm, qwen, …) routinely emit them truncated mid-stream, wrapped in ```json
// fences, trailed by prose, or double-encoded as a JSON string. A bare `JSON.parse` on that
// throws ("Unable to parse JSON string") — and that throw used to take down the whole provider
// stream or turn. We never want a malformed argument blob to abort a turn: a best-effort parse
// that falls back to `{}` lets the tool run (and surface its own "missing arg" error back to the
// model, which can then retry) instead of crashing the session.

/** Parse, returning `undefined` on failure instead of throwing. */
export function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ─── Salvage observability ───
// Every salvage is a *provider defect we recovered from* — exactly the kind of
// small-but-real failure the black box wants counted. A module-level listener
// keeps this file dependency-free: the engine registers the recorder here at
// startup. The listener must never be able to break parsing — invocation is
// fully guarded.

export interface ToolArgsSalvageInfo {
  /** Which fallback produced a result: "fence" | "slice"; "gave_up" means {} was returned. */
  stage: "fence" | "slice" | "gave_up";
  /** First 120 chars of the raw blob (caller redacts before storing). */
  snippet: string;
}

let salvageListener: ((info: ToolArgsSalvageInfo) => void) | null = null;

/** Register (or clear, with null) the global salvage listener. */
export function setToolArgsSalvageListener(fn: ((info: ToolArgsSalvageInfo) => void) | null): void {
  salvageListener = fn;
}

function notifySalvage(stage: ToolArgsSalvageInfo["stage"], raw: string): void {
  if (!salvageListener) return;
  try {
    salvageListener({ stage, snippet: raw.slice(0, 120) });
  } catch {
    // The observer must never break the parse path.
  }
}

/** Coerce a parsed value to a plain object, or null if it isn't one (unwraps a double-encoded
 *  JSON string one level — e.g. `"{\"path\":\"x\"}"`). */
function asObject(v: unknown): Record<string, unknown> | null {
  if (typeof v === "string") {
    const inner = tryParseJson(v.trim());
    return inner && typeof inner === "object" && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : null;
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Extract the first balanced `{…}` run (brace-depth + string/escape aware). Salvages an object
 *  buried in surrounding prose or trailing junk. */
function firstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      if (--depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Best-effort parse of a model-produced tool-call `arguments` payload into an object. Never
 * throws — an unsalvageable blob yields `{}`. Tries, in order: a straight parse, stripping a
 * ```json fence, then salvaging the first balanced `{…}` substring.
 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  // Some OpenAI-compatible endpoints (e.g. ollama.com/v1) hand back `arguments` already parsed
  // as an object rather than a JSON string — take it as-is instead of stringifying it to junk.
  if (typeof raw === "object") {
    return Array.isArray(raw) ? {} : (raw as Record<string, unknown>);
  }
  const original = String(raw).trim();
  let s = original;
  if (!s) return {};

  // 1) straight parse (the common, well-formed case)
  let obj = asObject(tryParseJson(s));
  if (obj) return obj;

  // 2) strip a ```json … ``` fence and retry
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    s = fenced[1].trim();
    obj = asObject(tryParseJson(s));
    if (obj) {
      notifySalvage("fence", original);
      return obj;
    }
  }

  // 3) salvage the first balanced object substring (prose / trailing junk around the JSON)
  const slice = firstJsonObject(s);
  if (slice) {
    obj = asObject(tryParseJson(slice));
    if (obj) {
      notifySalvage("slice", original);
      return obj;
    }
  }

  // give up safely — an empty-arg tool call beats a dead turn
  notifySalvage("gave_up", original);
  return {};
}
