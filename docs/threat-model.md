# Gear threat model

_Last reviewed: 2026-08-25 · covers the engine, CLI, `gear-tools`, and the desktop developer preview._

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
5. No independent third-party security review has been performed yet.

## Out of scope

A malicious local user, a compromised OS/toolchain, and providers themselves (Gear sends prompts
and receives completions over each provider's official API; what providers retain is governed by
their terms).
