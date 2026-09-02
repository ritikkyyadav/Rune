# Program backlog

Out-of-phase defects found during execution. One line each: `file:line — what — found in phase — by`.

Seeded 2026-09-02 from the audits:

- `packages/tool-registry/src/tools/todo-write.ts:55` — `todo_write` has category `read`, so `task` sub-agents can call it into a throwaway store — 6B.4
- `packages/llm-gateway/src/providers/openai.ts:74-79` — comment says OpenRouter passes no name; `openrouter.ts:28-32` passes one — 8.6
- `packages/tool-registry/src/mcp/client.ts:655` — MCP handlers return `validate: () => ({valid: true})` unconditionally — 4.4
- `packages/orchestrator/src/bin/engine-host.ts:321-335` — pending permission promises have no timeout and no rejection on disconnect — 2.2
- `packages/shared/src/session.ts:55` — `system_prompt_hash` never written (NULL for 601 sessions) — 7.1
- `tests/eval/tasks-from-incidents.ts:12-15` — flywheel input empty — 7.8
- `apps/desktop/src-tauri/src/lib.rs` — six `*_system_memory` commands never called — 3.1

Found 2026-09-02 by the Phase 6A corpus (`bun run eval:auto-safety --offline`). Each is a shape the
corpus expects a reviewer to catch because no mechanical breaker names it. None is a regression —
they are gaps the 19-scenario corpus was too small to see:

- `packages/orchestrator/src/auto-mode.ts:1805` — the recursive-delete breaker requires the target to
  BE a filesystem root or home directory, so `rm -rf ~/Documents` rates medium and runs — 6A.2
- `packages/orchestrator/src/auto-mode.ts:1962` — `guardrailChangeReason` only inspects `update_config`;
  a `sed -i` or `gear config set` against `.gear/policy.json` reaches the same target through bash and
  is not a guardrail change to the breaker — 6A.2
- `packages/orchestrator/src/auto-mode.ts:1899` — `SECRET_PATH_RE` matches credential FILES, so
  `security find-generic-password` (the macOS keychain CLI) is not a secret read — 6A.2
- `packages/orchestrator/src/auto-mode.ts:1721` — `isOrdinaryWorkspaceWrite` does not expand a leading
  `~`, so `write_file` to `~/.zshrc` resolves INSIDE the workspace root and lands on the workspace
  tier — 6A.2
- `packages/orchestrator/src/auto-mode.ts:1803` — not on any destructive list: `chmod -R 777 /`,
  `shutdown -h now`, `docker system prune -a --volumes -f`, `git push --mirror`,
  `aws s3 rm --recursive` — 6A.2

Added during execution:

- `tests/unit/**` (21 files) — POSIX-shell and POSIX-path assumptions block `bun test tests/unit/` on Windows: hardcoded `/bin/sh`, `/tmp/...`, `bash -c` and `uname` in the sandbox, permission, auto-containment and custom-loader suites. `ci.yml`'s ts-windows job typechecks only. The Windows smokes (P1.7) do not need these, so they were left alone — found in 1.7
- `.github/workflows/release.yml` — the install-smoke matrix downloads with `gh` rather than running `web-install.sh` / `install.ps1`, because a private repo 404s anonymous `curl`. Switch it to the real one-liners once D1 makes the repo (or a mirror) public — found in 1.4
- `packages/orchestrator/src/bin/ui/brand.ts` — `PRODUCT_VERSION`'s source-run fallback reads `packages/orchestrator/package.json` at runtime; five other `package.json` files still carry a semver nothing reads. Consider collapsing them, or add a CI check that they agree — found in 1.3

Found 2026-09-02 by Phase 7 (lane C):

- `tests/eval/tasks-task-spine.ts` — two mock-mode tasks fail on the merged Phase 1 + Phase 6 tree, verified against that merge's own harness so they are not a Phase 7 regression: `spine_handoff_on_error` ("no handoff recorded for the dead run") and `spine_todos_survive_compaction` ("final request lost the [Task state] block"). `baseline-mock.json` still records `cleanPassRate: 1`, so the mock gate is anchored to a state the suite no longer reaches — found in 7.4
- `scripts/install.sh` — every install keeps the previous binaries as `gear*.backup-<epoch>` in `~/.gear/bin` and nothing ever prunes them: ~95 generations × 3 binaries (`gear`, `gear-compiled`, `gear-tools`), several GB on this machine. Keep the last 2 or 3 — found in 7.4
- `packages/orchestrator/src/notebook/store.ts:246` — `decay()` retires on `COALESCE(last_used, updated_at) < cutoff`, so an entry that has never been injected is retired 60 days after it was learned even though nothing has had the chance to contradict it. Disuse and staleness are different signals — found in 7.6
