// ─── rune attach ws://host:port — the terminal as a remote client ───
//
// `rune attach <session>` already reattaches to a detached run over a unix
// socket. A unix socket is a file on one machine, so everything that made
// detach useful — start a long run, close the laptop, come back to it — stopped
// at the machine boundary. This is the same command over the websocket
// transport: the engine can be a server in another room, and the terminal is
// just another client of it.
//
// It is deliberately the SAME `RuneClient` the desktop and the web page use,
// not a second implementation of the protocol in the CLI. The five round-trips
// come free with it: a remote turn that stops for a permission stops HERE, and
// answering from this terminal unblocks a run happening somewhere else. That
// is the whole difference between a remote console and a log tail.
//
// Auth: `--token`, then `RUNE_SERVE_TOKEN`, then `~/.rune/serve.json` when the
// server happens to be this machine's own. A token on the command line lands in
// shell history, which is why the environment variable is offered first in the
// docs and why nothing here ever prints it back.

import type { AgentTurnEvent } from "@rune/protocol";
import { RuneClient, readServeToken } from "@rune/sdk";

import { accent, danger, dim, info, muted, ok, text, warn } from "./ui/theme";

const say = (s = ""): void => {
  process.stdout.write(s + "\n");
};

/**
 * The token, from the least secret-leaking source available.
 *
 * `~/.rune/serve.json` is consulted last and only for a loopback URL: a token
 * minted for the server on THIS machine is not a credential for someone else's,
 * and silently trying it against a remote host would be both useless and a
 * disclosure.
 */
export function resolveToken(
  url: string,
  flag: unknown,
  env: Record<string, string | undefined>,
  local: { token: string; url: string } | null,
): { token: string; from: string } | null {
  if (typeof flag === "string" && flag.length > 0) return { token: flag, from: "--token" };
  const fromEnv = env.RUNE_SERVE_TOKEN;
  if (fromEnv && fromEnv.length > 0) return { token: fromEnv, from: "RUNE_SERVE_TOKEN" };
  if (local && isLoopbackUrl(url)) return { token: local.token, from: "~/.rune/serve.json" };
  return null;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    // `URL.hostname` keeps the brackets on an IPv6 literal, so `ws://[::1]:1`
    // reads back as `[::1]` and a bare `::1` comparison silently misses it.
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
  } catch {
    return false;
  }
}

/** One turn event, as one line of terminal. */
function render(event: AgentTurnEvent, out: (s: string) => void): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(text(event.text));
      return;
    case "tool_call_start":
      out(`\n  ${dim("·")} ${info(event.toolName)}`);
      return;
    case "tool_call_end":
      out(event.output.success ? `  ${ok("ok")}` : `  ${danger("failed")}`);
      return;
    case "error":
      out(`\n  ${danger("!")} ${event.error}`);
      return;
    case "notice":
    case "context_warning":
      out(`\n  ${warn("·")} ${muted(event.message)}`);
      return;
    case "turn_complete":
      out(`\n\n  ${dim(`turn complete — ${event.stopReason}, ${event.totalTurns} turn(s)`)}`);
      return;
    default:
      // Every other member is real and rendered elsewhere; a remote console is
      // a status line, not the full transcript. `rune audit` is the record.
      return;
  }
}

export async function runAttachRemote(
  url: string,
  values: Record<string, unknown>,
): Promise<number> {
  const local = await readServeToken();
  const found = resolveToken(url, values.token, process.env, local);
  if (!found) {
    say(`  ${danger("!")} no token for ${url}`);
    say(`    pass ${info("--token <token>")}, or export ${info("RUNE_SERVE_TOKEN")}.`);
    say(`    The server prints its token path on start: ${muted("~/.rune/serve.json (0600)")}`);
    return 1;
  }

  const prompt = typeof values.prompt === "string" ? values.prompt : undefined;

  let client: RuneClient;
  try {
    client = await RuneClient.connect(
      { url, token: found.token },
      {
        onEvent: (event) => render(event, say),

        // The point of attaching rather than tailing: a run that stops for a
        // human stops here, and this terminal is the human.
        onPermission: async (p) => {
          say(`\n  ${warn("?")} ${accent(p.toolName)} ${muted(p.argsSummary)}`);
          const answer = await ask(`    allow? ${dim("[y/N]")} `);
          return /^y(es)?$/i.test(answer.trim()) ? { kind: "allow_once" } : { kind: "deny" };
        },
        onQuestion: async (q) => {
          say(`\n  ${warn("?")} ${text(q.question)}`);
          for (const [i, opt] of q.options.entries()) say(`    ${dim(String(i + 1))} ${opt}`);
          const answer = (await ask("    > ")).trim();
          const picked = Number(answer);
          return Number.isInteger(picked) && q.options[picked - 1]
            ? q.options[picked - 1]!
            : answer;
        },
        onBrief: async (b) => {
          say(`\n  ${accent("brief")} ${text(b.reading)}`);
          for (const c of b.criteria) say(`    ${dim("·")} ${c.text}`);
          const answer = await ask(`    accept? ${dim("[Y/n]")} `);
          return { accepted: !/^n(o)?$/i.test(answer.trim()) };
        },
        onHeldSteps: (steps) => {
          if (steps.length === 0) return;
          say(`\n  ${warn("held")} ${muted(`${steps.length} step(s) left unrun`)}`);
          for (const s of steps) {
            say(`    ${dim("·")} ${(s as { summary?: string }).summary ?? "(step)"}`);
          }
        },
        onRoundTripResolved: (r) => {
          say(`\n  ${muted(`${r.kind} resolved without you: ${r.reason} → ${r.applied}`)}`);
        },
        onClose: (info_) => {
          say(
            `\n  ${dim(`disconnected (${info_.code}${info_.reason ? ` ${info_.reason}` : ""})`)}`,
          );
        },
      },
    );
  } catch (err) {
    say(`  ${danger("!")} could not attach to ${url}`);
    say(`    ${muted(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }

  const status = await client.call("get_status", {}).catch(() => null);
  say(`  ${ok("attached")} ${info(url)} ${muted(`(token from ${found.from})`)}`);
  if (status) {
    say(`  ${muted(`${String(status.model)} on ${String(status.provider)}`)}`);
  }
  say();

  let code = 0;
  try {
    if (prompt) {
      const sessionId =
        typeof values.session === "string" && values.session
          ? values.session
          : await client.createSession();
      say(`  ${dim(`session ${sessionId}`)}\n`);
      await client.run(sessionId, prompt);
    } else {
      // No prompt: stay attached and stream whatever the server is doing, the
      // way `rune attach <session>` does over a socket. Ctrl+C detaches; the
      // run keeps going, because it was never this process's run.
      say(`  ${muted("streaming — Ctrl+C detaches, the run continues")}\n`);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
      });
    }
  } catch (err) {
    say(`\n  ${danger("!")} ${err instanceof Error ? err.message : String(err)}`);
    code = 1;
  }

  client.close();
  return code;
}

/** One line from the terminal, or "" when there is no terminal to read. */
function ask(question: string): Promise<string> {
  process.stdout.write(question);
  if (!process.stdin.isTTY) {
    // A piped or detached invocation has no one to ask. Answering "" makes the
    // handler deny, which is the same policy the host applies unattended.
    process.stdout.write("\n");
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(chunk.toString("utf8"));
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
