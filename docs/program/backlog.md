# Program backlog

Out-of-phase defects found during execution. One line each: `file:line — what — found in phase — by`.

Seeded 2026-09-02 from the audits:

- `packages/tool-registry/src/tools/todo-write.ts:55` — `todo_write` has category `read`, so `task` sub-agents can call it into a throwaway store — 6B.4
- `packages/llm-gateway/src/providers/openai.ts:74-79` — comment says OpenRouter passes no name; `openrouter.ts:28-32` passes one — 8.6
- `packages/orchestrator/src/auto-mode.ts:199, 550` — `conversationalEscalation` resolved and reported, never read — 1.1
- `docs/auto-mode.md:275` — "ten scenarios"; there are 19 — 1.1
- `packages/tool-registry/src/mcp/client.ts:655` — MCP handlers return `validate: () => ({valid: true})` unconditionally — 4.4
- `packages/orchestrator/src/bin/engine-host.ts:321-335` — pending permission promises have no timeout and no rejection on disconnect — 2.2
- `packages/shared/src/session.ts:55` — `system_prompt_hash` never written (NULL for 601 sessions) — 7.1
- `tests/eval/tasks-from-incidents.ts:12-15` — flywheel input empty — 7.8
- `dist/` — stale partial artifacts from 2026-08-25 — 1.3
- `apps/desktop/src-tauri/src/lib.rs` — six `*_system_memory` commands never called — 3.1

Found during Phase 2 (lane B):

- `.gitignore:32-42` — a run writes `.gear/skills/playbook/SKILL.md` into the workspace and that path is NOT ignored, so every session dirties the tree it is working in; `.gear/cache/`, `logs/`, `worktrees/` are ignored but `skills/` is not — found in 2.8 while running the `--stream-json` gate — lane B
- `packages/orchestrator/src/bin/gear-cli.ts:112` — `--status` is declared `{type:"string"}` under `strict:false`, so a bare `--status` silently swallows the NEXT argument as its value (`gear serve --status --port 4999` parsed as `status:"--port"`). Worked around for `serve` by rewriting the flag to a positional before `parseArgs`; every other subcommand still has the hole — found in 2.4 — lane B
- `packages/orchestrator/src/engine.ts` — `Engine` holds one `currentAbort`/`liveLoop`, so `abort(sessionId)` cannot truly be per-session in one process. `gear serve` works around it with one host process per session (P2.3's supervisor). An in-process multiplexed Engine remains unbuilt and is the blocker for a single-process multi-session desktop — found in 2.3 — lane B
- `packages/shared/src/session.ts:44-107` — `tool_result` rows carry no `durationMs`, so a replayed tool call reports 0 and a client cannot tell "instant" from "unknown" — found in 2.5 — lane B

Found during Phase 3 (lane B):

- `apps/desktop/src-tauri/Cargo.toml` — the repo root's `exclude` for `apps/desktop/src-tauri` only works while the nearest ancestor manifest IS the repo root, so every cargo command from a git worktree checked out under the main checkout failed with "believes it's in a workspace when it's not". Fixed here with an empty `[workspace]` table in the package; the same trap applies to any future nested crate — found in 3.1 — lane B
- `packages/orchestrator/src/bin/login-cli.ts` — provider OAuth (Anthropic, Codex, OpenRouter) and the Copilot device flow are terminal-owned: they open a browser and catch a loopback redirect from the CLI process. The desktop settings panel prints `gear login <provider>` for those providers rather than offering a button that cannot work. Moving it in-app needs one host command (`start_provider_login` → returns the URL, completes the exchange, writes to the credential store) — found in 3.4 — lane B
- `packages/orchestrator/src/engine.ts` — `getTurnContext` records the last turn's assembly PER SESSION, not per turn, so the inspector shows the most recent assembly for the session rather than the one for the model span you clicked. Correct for a one-turn question and wrong for scrubbing back through a long session; a per-turn record needs a turn index on the capture — found in 3.4 — lane B
- `apps/desktop/src/lib/demo.ts` — the recorded demo turn predates the round-trip cards, the fleet panel and the auto chips, so "replay a recorded turn" shows a 2026-08 surface. Re-record it against the current reducers — found in 3.4 — lane B

Found during Phase 5 (lane B):

- `apps/desktop/src/lib/stream.ts:919` — `case "tool_call_args_delta"` is a duplicate of an earlier `case` in the same switch, so the second one is dead. esbuild warns on every `apps/desktop` build; the reducer still compiles because both branches do the same thing, which is exactly why it has survived. The exhaustiveness test reads case labels and finds one, so it does not catch a second — found in 5.2 while building the web bundle — lane B
- `packages/orchestrator/src/headless.ts:246` — `headlessEnvelope` is the only place a headless run reports itself, and it had no `sessionId`, so CI could not name the session it had just run and had to guess with `gear audit last` — wrong on any shared runner. Added in 5.3; the same gap exists for `gear detach`, whose registry records a run id that no envelope ever prints — found in 5.3 — lane B
- `packages/orchestrator/src/bin/serve-cli.ts` — the `HostPool` registry path (`~/.gear/run/serve-hosts.json`) is a single global file, so a `gear serve` and a `gear acp` running at once overwrite each other's record. It is only read by `gear serve --status`, so the damage is a wrong status page rather than a wrong route, but the file should be keyed by the owning process — found in 5.1 — lane B
- `packages/orchestrator/src/bin/gear-cli.ts` — `parseArgs` runs with `strict: false` and the options map is now 40+ entries shared by every subcommand, so a flag added for one command is silently accepted by all of them (`gear doctor --token x` parses fine). A per-command option set would catch typos that currently do nothing — found in 5.5 — lane B
