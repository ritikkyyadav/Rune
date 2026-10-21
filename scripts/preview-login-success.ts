/** Preview the production completion renderer locally, without signing in. */
import { successPage } from "../packages/llm-gateway/src/auth/success-page";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(Bun.argv[2] ?? 8767),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/mobile") {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Rune mobile preview</title>' +
          "<style>body{margin:0}iframe{display:block;width:390px;height:844px;border:0}</style>" +
          '<iframe title="Rune sign-in completion" src="/auth/callback"></iframe>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (path !== "/" && path !== "/auth/callback")
      return new Response("Not found", { status: 404 });
    return new Response(successPage("ChatGPT (Codex)"), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  },
});
console.log(`Rune login completion preview: http://127.0.0.1:${server.port}`);
