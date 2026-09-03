# Gear for VS Code

A thin client. The UI in the panel is Gear's own web client — the same React
bundle the desktop app runs, trace rail included — and this extension supplies
the editor bindings around it: a panel, a status bar, a selection, a trace.

That thinness is the design. A fourth client with its own chat UI would have to
be kept in step with the protocol by hand, which is exactly what
[`@gear/protocol`](../../docs/protocol.md) exists to prevent.

## Commands

| Command                            | What it does                                                      |
| ---------------------------------- | ----------------------------------------------------------------- |
| **Gear: Open Panel**               | The web client, beside your editor                                |
| **Gear: Send Selection to Gear**   | The selection with its file and line range (`⌘⌥G` / `Ctrl+Alt+G`) |
| **Gear: Open Trace for This File** | What this session's tool calls did to the file you are looking at |
| **Gear: Set Server Token**         | Store a bearer token for a configured server, in SecretStorage    |

The status bar shows the gear and the session cost. A cost with no data behind
it renders as **nothing at all**, never as `$0.00` — that would be a claim that
the run was free.

## Where the engine comes from

In this order, because it is the order that respects intent:

1. **`gear.serverUrl`**, if you set one and it answers. You meant it.
2. **A `gear serve` already running on this machine** (`~/.gear/serve.json`,
   probed before it is trusted — the file outlives the process that wrote it).
3. **One this extension starts**, `gear serve --web --port 7788`, stopped again
   when the extension deactivates. An engine that was already running is not
   ours to stop.

Starting a second engine beside one you are already watching is worse than any
connection error, which is why (2) exists.

## Settings

| Setting          | Default  | Notes                                         |
| ---------------- | -------- | --------------------------------------------- |
| `gear.path`      | `gear`   | The executable, if it is not on your PATH     |
| `gear.serverUrl` | _(none)_ | A server to attach to instead of starting one |

**The token is not a setting.** VS Code settings sync between machines and end
up committed in `.vscode/settings.json`, and this token is remote code
execution with your provider credentials attached
([`docs/threat-model.md`](../../docs/threat-model.md)). Run **Gear: Set Server
Token**; it goes to SecretStorage. For a local server the extension reads
`~/.gear/serve.json` directly and you never see a token at all.

The token reaches the page in the URL **fragment**, which the browser never
sends to the server — the same rule `gear web --host` follows for a LAN link.

## Building it

```bash
bun install
bun run --cwd apps/vscode build      # out/extension.js
bun run --cwd apps/vscode package    # gear-0.3.0.vsix
code --install-extension apps/vscode/gear-0.3.0.vsix
```

`bun run --cwd apps/vscode test` runs the unit tests. They cover
`serve.ts`, `panel.ts`, `editor.ts` and `status.ts` — every module that holds a
decision. `extension.ts` is the only file that imports `vscode`, and it is
wiring: an extension whose logic lives inside editor callbacks can only be
tested by launching VS Code.

## Testing it in a real VS Code

```bash
cargo build --release -p gear-tools
bun run --filter @gear/web build     # the bundle the webview frames
bun run --cwd apps/vscode test:vscode
```

`test/runTest.ts` downloads a pinned VS Code (1.135.0), starts a real
`gear serve --web` against a fake model, and launches the editor with this
extension in development mode. `test/suite/index.ts` runs inside the extension
host: it activates the extension, checks every contributed command is really
registered, selects two lines of a file and runs **Send Selection to Gear**.

The assertion happens **outside** the editor. A webview's iframe is cross-origin
to the extension host, so its DOM is opaque from in there; the launcher watches
the same server through `@gear/sdk` and waits for a session whose transcript
carries the selection and the model's reply. The two halves meet at a marker
file, so whichever one fails is the one that says why.

Until this existed, the extension typechecked, bundled, packaged, and could not
possibly have worked: the page it frames had no listener for the messages it
posts, so **Send Selection to Gear** posted into a window that ignored it. Both
halves were tested apart and never together. It runs on every pull request
(`vscode` job, under `xvfb-run`); locally it skips with a printed reason if the
download or the bundle is missing.

## Not published

The marketplace listing is a **founder action** under decision D1
([`docs/program/00-program.md`](../../docs/program/00-program.md) §8): it needs
a publisher account under Savoir, a license decision and an icon. Nothing in
this repo publishes. Install the `.vsix` by hand until then.
