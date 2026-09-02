# @gear/sdk

Drive a Gear session from anywhere a WebSocket runs — Node, Bun, a browser, an
editor extension, a CI step.

The whole of `@gear/protocol` is re-exported, so the event union, the round-trip
shapes and the command map you code against are the same declarations the engine
and the terminal use. A client cannot drift from the server, because there is
only one copy.

## Start a server

```bash
gear serve                 # loopback, a fresh bearer token in ~/.gear/serve.json (0600)
gear serve --status        # what is running, and whether remote settings are allowed
```

## Connect, run a prompt, answer a permission

An agent stops for a human. That is the interesting half of a real turn, so the
round-trips are first-class here: register a handler and the client answers for
you.

```ts
import { GearClient, readServeToken } from "@gear/sdk";

const found = await readServeToken();
if (!found) throw new Error("gear serve is not running");

const gear = await GearClient.connect(found, {
  // The turn, event by event — the same 22-member union the terminal renders.
  onEvent(event) {
    if (event.type === "text_delta") process.stdout.write(event.text);
    if (event.type === "tool_call_end") console.log(`\n· ${event.output.toolName}`);
  },

  // A tool wants permission. Return a decision and the client sends it.
  async onPermission(prompt) {
    console.log(`\n? ${prompt.toolName}: ${prompt.argsSummary}`);
    return prompt.safety?.risk === "high" ? { kind: "deny" } : { kind: "allow_once" };
  },

  // The agent is asking YOU something (`ask_user`).
  async onQuestion(q) {
    console.log(`\n? ${q.question}`);
    return q.options[0] ?? "you decide";
  },

  // Auto mode's end-of-turn ledger: outward steps it declined to take
  // unattended. Approve one with `run_held_step`, decline with
  // `dismiss_held_steps` — both by id.
  onHeldSteps(steps) {
    for (const step of steps) console.log(`\n· held: ${(step as { summary: string }).summary}`);
  },
});

const sessionId = await gear.createSession();
await gear.run(sessionId, "add a health endpoint and prove it works");
gear.close();
```

Leave a handler unset and the host applies its stated unattended policy after
the timeout: permission → `deny`, `ask_user` → the "no answer" instruction so
the model proceeds and names its assumption, brief → accepted as stated, held
step → left unrun. That is the right outcome for a program with no human behind
it, and a much better one than a client inventing an answer.

## Everything else

`call()` is typed against the full command map:

```ts
const sessions = await gear.call("list_sessions");
const status = await gear.call("get_status", { sessionId });

// Reconnect: settled history, then live. `settled` is true because
// `text_delta` is never persisted — an assistant turn comes back as one block.
const sub = await gear.call("subscribe", { sessionId, sinceSeq: 0 });

await gear.call("abort_chat", { sessionId });
await gear.call("interject_chat", { sessionId, text: "use postgres, not sqlite" });
```

An unknown command is a compile error, not a runtime `unknown command`.

## Auth, briefly

- Loopback only unless `gear serve --host` was passed, which prints a warning
  naming what became reachable.
- The bearer token is required on every connection and compared in constant
  time. Send it as `Authorization: Bearer`, as the `gear.bearer.<token>`
  subprotocol (what this client does — the only header a browser can set), or
  as `?token=` (last resort: it lands in logs).
- Browser origins are allowlisted. A missing `Origin` is a non-browser client
  and is allowed; browsers always send one, so its absence cannot be forged
  from a page.
- `save_settings` writes API keys and is refused over a non-loopback link
  unless the token was minted with `--allow-remote-settings`.

Full contract: [`docs/protocol.md`](../../docs/protocol.md).
