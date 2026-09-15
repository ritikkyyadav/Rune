// WRONG on purpose: uptimeMs is the wall clock, not the time since startedAt.
export const startedAt = Date.now();

export function handle(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/")
    return new Response("Fieldnotes API", { headers: { "content-type": "text/plain" } });
  if (path === "/health")
    return new Response(JSON.stringify({ ok: true, uptimeMs: Date.now() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return new Response("not found", { status: 404 });
}
