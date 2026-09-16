/**
 * Resolve a person's spelling of a session id to a stored session.
 *
 * The frame's header shows the LAST eight characters of the id (the random
 * part of a UUIDv7; the first eight are a timestamp that sessions opened in
 * the same minute share), so a tail must resolve as readily as the full id or
 * a head-prefix. An elision glyph copied from the header is tolerated.
 */
export function matchSessionIdish<T extends { id: string }>(
  sessions: readonly T[],
  idish: string,
): T | undefined {
  const wanted = idish.trim().replace(/^[\u2026.]+/, "");
  if (!wanted) return undefined;
  return (
    sessions.find((s) => s.id === wanted) ??
    sessions.find((s) => s.id.startsWith(wanted)) ??
    (wanted.length >= 4 ? sessions.find((s) => s.id.endsWith(wanted)) : undefined)
  );
}
