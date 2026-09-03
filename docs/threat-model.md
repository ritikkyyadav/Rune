# Gear threat model

_Last reviewed: 2026-09-02 · covers the engine, CLI, `gear-tools`, the desktop developer preview,
and the served engine (`gear serve` / `gear web` / `gear attach ws://…`)._

Gear is a **local-first agentic coding assistant**: a model plans, and a local harness executes
tools (file edits, search, shell) inside the user's workspace. The security design starts from one
assumption: **model output is untrusted input.** Everything between the model and the machine is a
control surface.

## Assets

- The user's source code and workspace files.
- Provider credentials (API keys, OAuth tokens) held by the credential store.
- The session record and audit chain (evidence of what the agent actually did).
- The user's machine outside the workspace (dotfiles, keychains, other projects).

## Trust boundaries and controls

| Boundary             | Control                                                                                                                                            | Where                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Model → tools        | Permission engine: mechanical deny/ask/allow rules, gears I–III, signed org policy                                                                 | `packages/orchestrator/src/permissions.ts`, `org-policy.ts`   |
| Model → tools (Auto) | Two-stage isolated action classifier reviews shell/network/protected writes/delegation; failures close to a human prompt (`GEAR_AUTO_FAIL_CLOSED`) | `packages/orchestrator/src/auto-mode.ts`, `docs/auto-mode.md` |
| Tool results → model | Prompt-injection probe scans results before they enter model context; hits are flagged into the audit trail                                        | auto-mode pipeline                                            |
| Shell → OS           | OS sandbox per platform (see matrix) + PathGuard command screening + egress redaction + per-tool rate limits                                       | `crates/gear-sandbox`                                         |
| Plugin tool → OS     | Per-tool OS sandbox profile built from the manifest's declared capability; refused where no backend exists                                         | `crates/gear-sandbox/src/spawn.rs`, `docs/plugins.md`         |
| Actions → evidence   | Hash-chained audit log; exports optionally signed (Ed25519)                                                                                        | `packages/orchestrator/src/session-export.ts`                 |

## OS sandbox matrix

| Platform                                    | Mechanism                                                                                       | OS-level isolation |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------ |
| macOS                                       | `sandbox-exec` (Seatbelt) profile: workspace-scoped writes, secret paths denied, network toggle | Yes                |
| Linux                                       | `bwrap` (bubblewrap)                                                                            | Yes                |
| Windows                                     | **None** — PathGuard screening + audit only                                                     | **No**             |
| macOS/Linux without the mechanism installed | Falls back to PathGuard + audit                                                                 | No                 |

The engine surfaces this honestly: when the sandbox is enabled but OS isolation is unavailable,
status reports `sandboxDegraded` and the UI shows it. `[sandbox] requireOs = true` refuses to run
shell tools without real OS isolation. **Treat Windows as a lower-assurance platform** until a
Job-Object/AppContainer executor lands.

## Plugins

A plugin is a directory someone else wrote, dropped into `.gear/plugins/`. Its parts do not carry
the same assurance, and the difference is the whole design:

| Part                              | Contained by                            | Assurance                                                                                      |
| --------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Skills, commands                  | nothing to contain — they are text      | The model reads them. Treat a skill as untrusted instructions, not as policy                   |
| Hooks                             | **nothing**                             | A hook is a shell command the plugin asked Gear to run, with the user's access                 |
| MCP servers                       | **nothing**                             | A stdio server is a process the plugin asked Gear to start, with the user's access             |
| Executable tools (`tools`, D6 v2) | the OS sandbox, per declared capability | Workspace reads/writes and outbound network are enforced by Seatbelt/bwrap, not by the program |

So `permissions` in a manifest (`hosts`, `paths`, `blockingHooks`) is **disclosure**: it exists so
a user can read what a bundle intends before enabling it, and both the installer and `gear plugin
list` say it is not enforced. `tools` is the one block that _is_ enforced.

**Integrity.** `gear plugin add <name>` verifies the index's published sha256 against the staged
tree before installing; discovery re-verifies the installed tree's digest on every scan and refuses
a bundle whose files changed since installation. Neither is a signature: the index and the bundle
share a trust root (the repository), so integrity here proves _unchanged since published_, not
_written by whom it claims_. Plugin signing is not implemented.

**Executable tools.** Each declared tool is a subprocess under a profile built from its capability
(`none` / `workspace-read` / `workspace-write` / `network`), never code loaded into the Gear
process. The capability becomes the tool's permission category, so a write-capable plugin tool is
not auto-approved in 1st gear and a network one reaches the Auto classifier like `web_fetch`; every
plugin tool's output crosses the prompt-injection probe. Org policy denies a bundle with
`plugin:<name>:*`. Two limits stated plainly:

- **Host filtering is port-level on macOS and absent on Linux.** Seatbelt's `remote ip` filter
  takes a port and `*`/`localhost` only, so a declared `api.example.com:443` is enforced as "port
  443, nothing else"; bubblewrap's network isolation is all-or-nothing, so on Linux the host list
  is disclosure. The launch plan reports which of the two is in force.
- **A machine with no backend refuses to run plugin tools at all** — including when the sandbox
  state could not be determined. `[extensions] allowUnsandboxedTools` lifts that per plugin and
  means a stranger's program runs with the user's full access; it is warned in the log, at startup,
  and in the tool description the model reads.

`[extensions] localTools` is a different thing and stays one: in-process TypeScript from the
**user's own** `.gear/tools`, off by default, never reachable from a plugin.

## The served engine (`gear serve`, `gear web`, `gear attach ws://…`)

State the thing plainly, because every control below follows from it:

> **A served engine is remote code execution on this machine, with the user's provider
> credentials attached.** Anyone holding the bearer token can run tools in the workspace, read
> whatever the workspace can read, and spend the user's model budget. It is not a read-only
> dashboard and there is no second authorization step behind it.

So the posture is: **no auth, no server.** There is no anonymous mode, no "just for a minute"
flag, and no way to start one without a token.

| Control           | Rule                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bind              | **Loopback by default.** `--host` is opt-in and prints a banner naming what became reachable and where                                                         |
| Token             | **Mandatory on every connection.** 32 random bytes, base64url, minted fresh per start, `~/.gear/serve.json` at 0600, compared in constant time                 |
| Token lifetime    | Per server start. Stopping the server invalidates it; there is no long-lived server key                                                                        |
| Origin            | Browser origins allowlisted. A missing `Origin` is a non-browser client and is allowed — browsers always send one, so its absence cannot be forged from a page |
| Credential writes | `save_settings`, login and key writes are **refused over a non-loopback link** unless the token was minted with `--allow-remote-settings`                      |
| Transport         | **Plaintext `ws://`.** Anyone who can see the traffic sees the token and the session                                                                           |
| Session isolation | One engine-host process per session; a wedged session cannot take the server with it                                                                           |
| Shutdown          | Graceful — the front door closes and running session hosts keep going, as `gear detach` does                                                                   |

**The token never goes in a query string.** `gear web --host` prints
`http://<lan-ip>:<port>/#token=…` — a **fragment**, which the browser does not send to the server
and which therefore cannot reach an access log, a proxy log, or a `Referer` header on the way
somewhere else. The page reads it once and removes it from the address bar. The consequence is
that the server cannot recognise a remote page request, so off-loopback it serves the bundle with
**no token embedded**; that bundle is public JavaScript and inert without one. On loopback the
token is embedded directly, because a process that can make that request already runs as the user
and can read `~/.gear/serve.json` anyway. `?token=` is still accepted for compatibility and is
documented as a last resort for exactly this reason.

`gear attach ws://host:port` takes its token from `--token`, then `GEAR_SERVE_TOKEN`, then
`~/.gear/serve.json` — and the last of those **only for a loopback URL**, because a token minted
for this machine's server is not a credential for someone else's and offering it to a remote host
would be a disclosure. Prefer the environment variable: a token on a command line is written to
shell history.

### What a LAN bind is and is not

`--host` is for a trusted network you control — your own LAN, a tailnet, an SSH tunnel. It is
**not** an internet-facing deployment: there is no TLS, no rate limiting on the door, no account
model, no revocation beyond restarting, and no audit of who connected. Exposing a port to the
public internet with `--host 0.0.0.0` is outside this model; put it behind a tunnel or a reverse
proxy that terminates TLS and authenticates, and treat the token as a second factor rather than
the only one.

## Credential storage

Backends in order: macOS Keychain → Linux `secret-tool` (Secret Service) → Windows Credential
Manager → **plaintext file fallback** (`~/.gear/credentials.json`, `secure=false`). The fallback
never engages silently in user-facing flows: `/keys`, `/providers`, and login print
"⚠ credentials stored unencrypted…" whenever the plaintext store is active. Force a backend with
`GEAR_CREDENTIAL_BACKEND`. On shared or compliance-sensitive machines, install a real keyring or
export keys per-session instead.

## Known gaps (accepted for the current release, tracked)

1. **Windows has no OS isolation** (PathGuard-only; see matrix).
2. **Plaintext credential fallback exists** (warned, not blocked).
3. **The export signing key is a local trust root** (`~/.gear/keys`) — exports prove integrity
   against tampering-after-the-fact, not against a compromised machine at export time.
4. **The desktop app is a developer preview**: it launches the engine from a source checkout and
   inherits that checkout's trust; it is not hardened, signed, or notarized.
5. **A served engine speaks plaintext `ws://`** — no TLS, so a LAN bind assumes a trusted network
   (see above). Anyone who can observe the traffic can take the token.
6. **A served engine has one credential, not identities**: the token is the whole access model.
   There is no per-user attribution in the audit trail for a remote connection, and revoking
   access means restarting the server.
7. **Plugins are not signed**, and their declarative parts (hooks, MCP servers) are not contained
   — see Plugins above. A plugin tool's declared hosts are enforced by port on macOS and not at
   all on Linux.
8. No independent third-party security review has been performed yet.

## Out of scope

A malicious local user, a compromised OS/toolchain, and providers themselves (Gear sends prompts
and receives completions over each provider's official API; what providers retain is governed by
their terms).
