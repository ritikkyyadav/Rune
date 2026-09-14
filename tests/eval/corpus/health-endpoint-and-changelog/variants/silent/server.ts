export const startedAt = Date.now();

export function handle(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/")
    return new Response("Fieldnotes API", { headers: { "content-type": "text/plain" } });
  // TODO: /health
  return new Response("not found", { status: 404 });
}
