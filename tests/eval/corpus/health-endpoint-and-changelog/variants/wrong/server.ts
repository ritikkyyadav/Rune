export const startedAt = Date.now();

export function handle(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/")
    return new Response("Fieldnotes API", { headers: { "content-type": "text/plain" } });
  if (path === "/health")
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  return new Response("not found", { status: 404 });
}
