// ─── The prompt-cache key a session's requests carry ───
//
// A provider that caches prompts routes a request to the machine already
// holding its prefix by a key the caller sends (Codex: `prompt_cache_key` and
// the `session_id` header). The provider adapter has accepted one for a while
// (`StreamOpts.cacheKey`) and no caller passed it, so every request fell back
// to an id made when the adapter was constructed — one that changes whenever
// the gateway is rebuilt (`/model`, `/login`) and whenever the process is, and
// is shared by every session in a process. A warm cache was thrown away at each
// of those moments.
//
// The key is the session's: the same for every turn of it, across a rebuilt
// gateway and across a resumed process, and never two sessions' at once. It is
// a digest of the session id rather than the id itself — the id is a UUIDv7 and
// says when the session began, which is nobody's business but the user's.

import { createHash } from "node:crypto";

/** `rune-` and 32 hex characters: printable, header-safe, and stable for the session's life. */
export function sessionCacheKey(sessionId: string): string {
  const digest = createHash("sha256").update(`rune-prompt-cache\0${sessionId}`).digest("hex");
  return `rune-${digest.slice(0, 32)}`;
}
