# Rune — Privacy & Telemetry

Rune is local-first. **Telemetry is off by default and transmits nothing unless
you explicitly opt in.** This document describes exactly what the opt-in channel
does, because "you can verify it" is the whole point.

## The short version

- **Off by default.** Nothing leaves your machine until (a) the build is
  configured with a collector endpoint **and** (b) you answer _yes_ to the
  first-run prompt (or run `rune telemetry on`).
- **You can see the exact bytes.** `rune telemetry preview` prints the complete
  set of payloads that could ever be sent — no hidden fields.
- **Change your mind any time.** `rune telemetry off` stops it; `rune telemetry
reset` also throws away your anonymous install id.

## What is collected when you opt in

Two streams, both minimal and redacted at the source:

1. **Crash / error reports** — drawn from the local Black Box flight recorder:
   the incident class (e.g. `provider.rate_limit`), severity, the code site, a
   stable fingerprint, a redacted one-line message and (for crashes) a redacted
   stack, plus coarse context (provider/model/tier, OS, arch, HTTP status).
2. **A daily usage heartbeat** — an anonymous, once-per-day count: app version,
   OS/arch, and coarse tallies such as sessions started and incidents seen.

Every payload carries a random **install id** (a UUID minted on opt-in) so
reports from one install can be grouped. It is **not derived from your machine**
— no MAC address, hostname, or hardware serial — and `rune telemetry reset`
replaces it.

## What is never collected

- File contents, diffs, code, or your prompts.
- Your **IP address** or any **device / hardware fingerprint**.
- File paths (your home directory is collapsed to `~`) or the flight trail's
  content summaries.
- API keys or secrets — these are stripped at a single redaction chokepoint
  _before_ anything is even written to the local Black Box, and again before
  transmission.

### A note on IP addresses

Any HTTPS request necessarily reveals the connection's source IP to the server
at the network layer — that is true of every website and every update check, and
it is unavoidable for any network request. Rune's design response is: **the IP
is never placed in a telemetry payload**, and the reference collector
(`collector/rune-collector.ts`) **never stores it** — at most it is passed to an
optional coarse country lookup and then discarded. If that is still more than you
want, keep telemetry off (the default).

## Where your data lives locally

- `~/.rune/blackbox.db` — the local flight recorder (always local; browse with
  `rune doctor` / `rune incidents`).
- `~/.rune/telemetry.json` — your consent decision + anonymous install id.
- `~/.rune/telemetry-queue.jsonl` — reports waiting to send (only exists after
  opt-in); delivered best-effort at the next launch.
- `~/.rune/telemetry-usage.json` — the pending usage counters.

## Controls

| Command                     | Effect                                              |
| --------------------------- | --------------------------------------------------- |
| `rune telemetry status`     | Show config, consent, install id, and what's queued |
| `rune telemetry preview`    | Print the exact payloads that could be sent         |
| `rune telemetry on` / `off` | Opt in / out                                        |
| `rune telemetry reset`      | Forget the decision + install id                    |

Config lives under `[telemetry]` in `~/.rune/config.toml` (or a project
`.rune/config.toml`); env overrides `RUNE_TELEMETRY`,
`RUNE_TELEMETRY_ENDPOINT`, `RUNE_TELEMETRY_TOKEN`. Setting `enabled = false` or
blanking `endpoint` is a hard kill-switch — no prompt, no network.
