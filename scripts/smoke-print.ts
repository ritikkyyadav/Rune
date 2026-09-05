// ─── The end-to-end smoke: a real binary, a real prompt, a fake model ───
//
// `rune --version` proves a binary starts. `rune tools-smoke` proves the native
// executor works. Neither proves the thing a user actually does: type a prompt
// and get an answer back. That path runs the engine, the gateway, a provider
// adapter, the session store and the headless printer, and until now nothing in
// CI exercised it end to end because doing so appeared to need a paid API key.
//
// It does not. Ollama needs no credential and reads its base URL from
// OLLAMA_HOST, so a thirty-line server that speaks /api/chat and /api/tags is a
// complete provider as far as Rune is concerned.
//
// This runner is a TypeScript program rather than a shell snippet on purpose.
// The obvious version — start a server with `&`, run the binary, `kill %1` —
// is three POSIX assumptions, and this smoke has to pass on windows-latest.
// Bun runs identically on all four runners; `&` does not exist in PowerShell.
//
// Usage:  bun scripts/smoke-print.ts <path-to-rune-binary> [expected-word]

import { spawn } from "node:child_process";

const binary = process.argv[2];
const expected = (process.argv[3] ?? "ok").toLowerCase();
if (!binary) {
  console.error("usage: bun scripts/smoke-print.ts <path-to-rune-binary> [expected-word]");
  process.exit(2);
}

const MODEL = "smoke-model";

/**
 * The whole model: it answers with the word it was asked to print, in one
 * chunk, and never calls a tool. The point of the smoke is the plumbing between
 * the prompt and the answer, not the answer.
 */
function chatStream(reply: string): Response {
  const body =
    JSON.stringify({
      model: MODEL,
      message: { role: "assistant", content: reply },
      done: false,
    }) +
    "\n" +
    JSON.stringify({
      model: MODEL,
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 12,
      eval_count: 3,
    }) +
    "\n";
  return new Response(body, {
    headers: { "content-type": "application/x-ndjson" },
  });
}

const server = Bun.serve({
  port: 0, // let the OS pick, so parallel matrix legs never collide
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/tags") {
      return Response.json({ models: [{ name: MODEL, model: MODEL, size: 1 }] });
    }
    if (url.pathname === "/api/chat") {
      await req.text(); // drain the request; the reply does not depend on it
      return chatStream(expected);
    }
    if (url.pathname === "/api/show") {
      return Response.json({ capabilities: ["completion"] });
    }
    return new Response("not found", { status: 404 });
  },
});

const host = `http://127.0.0.1:${server.port}`;
console.error(`[smoke] mock provider on ${host}`);

const child = spawn(
  binary,
  ["-P", `print the word ${expected}`, "-p", "ollama", "-m", MODEL, "--gear", "1"],
  {
    env: {
      ...process.env,
      OLLAMA_HOST: host,
      // Keep the run inside the sandbox's temp area and away from the
      // developer's real ~/.rune — a smoke must never touch real sessions.
      RUNE_HOME: process.env.RUNE_SMOKE_HOME ?? undefined,
      NO_COLOR: "1",
      CI: "1",
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += String(d)));
child.stderr.on("data", (d) => (stderr += String(d)));

// A wedged binary must fail the job, not hang the runner until GitHub's
// six-hour ceiling.
const timeout = setTimeout(() => {
  console.error("[smoke] TIMEOUT after 120s — killing");
  child.kill("SIGKILL");
}, 120_000);

const code: number = await new Promise((resolve) => {
  child.on("close", (c) => resolve(c ?? 1));
  child.on("error", (err) => {
    console.error(`[smoke] failed to spawn ${binary}: ${err.message}`);
    resolve(127);
  });
});
clearTimeout(timeout);
server.stop(true);

if (stderr.trim()) console.error(stderr.trimEnd());
console.error(`[smoke] exit=${code}`);
console.error(`[smoke] stdout=${JSON.stringify(stdout)}`);

if (code !== 0) {
  console.error(`[smoke] FAIL — the binary exited ${code}`);
  process.exit(1);
}
if (!stdout.toLowerCase().includes(expected)) {
  console.error(`[smoke] FAIL — expected the answer to contain "${expected}"`);
  process.exit(1);
}
console.error("[smoke] PASS — prompt in, answer out, through the real binary");
