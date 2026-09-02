# Phase 1 — Ship

**Lane A · 6–9 days · prerequisite for everything the world can see**

## Goal

v0.3.0 exists as something another person can install on macOS, Linux and Windows with one command, and the working tree is clean enough that every later phase starts from a commit.

## Evidence (2026-09-02)

- Only tag: `v0.2.0`. Every `package.json` and `packages/orchestrator/src/bin/ui/brand.ts:15` say `0.3.0`. Nothing injects the version at build time; four hand-maintained copies (`brand.ts:15`, six `package.json`, `scripts/install.sh:38`, `scripts/web-install.sh:12`).
- 53 modified or untracked files, including the entire plan-ledger and self-evolution programs. `retro.ts`, `playbook.ts`, `evolve-cli.ts`, `docs/self-evolution.md`, `docs/plan-ledger.md`, `audit-cli.ts` are **untracked**: a self-modifying system whose source is not in version control has no revert story.
- `.github/workflows/release.yml` is tag-driven, builds five targets on ubuntu, generates `SHA256SUMS` beside the artifacts (`release.yml:107-111`), smoke-runs the Linux pair, and re-installs from the published release (`release.yml:130-153`). Keep it.
- The README's headline `curl | bash` (`README.md:132`) cannot work: the repo is private (`README.md:135`). `scripts/web-install.sh:45-49` hard-exits on Windows; there is no `.ps1`; Windows binaries are built and nothing can install or smoke them (`ci.yml:143-152` typechecks only).
- Nothing is code-signed anywhere: `grep -rn codesign` over `*.sh *.ts *.yml *.rs *.md` returns zero hits. macOS downloads will hit Gatekeeper. `web-install.sh:74-94` does not verify checksums.
- No auto-update, no `gear upgrade`, no CHANGELOG. The launcher's staleness nag (`install.sh:256-268`) only exists for source installs.
- `dist/` holds stale 2026-08-25 artifacts with one `gear-tools` for five CLIs; uploading it by hand ships a broken release for four platforms.
- The engine imports a terminal-UI module once: `packages/orchestrator/src/engine.ts:162` imports `isVerificationCommand` from `./bin/ui/activity`, which drags the ANSI/theme stack into the engine graph. The function lives in `brief.ts:42`.
- `docs/auto-mode.md:44-66` describes a conversational-escalation loop and a fast in-path stage the code no longer has (`auto-mode.ts:1116-1126`; `conversationalEscalation` is resolved at `auto-mode.ts:199` and never read in `review()`). `docs/byop.md:16` says no device-code provider is wired; Copilot is (`oauth-registry.ts:44-49`).
- `docs/auto-mode.md:275` says "ten generic scenarios"; the corpus has 19 (`tests/eval/auto-mode-safety.ts`).

## Work items

### P1.1 Day-0 defects (half a day)
- `engine.ts:162` → import from `./brief`. Add a test that greps the engine graph for `bin/ui` imports and fails on any.
- Retro scoping (the fix is small and unblocks Phase 7's measurement): `retro.ts:214` compute `steps` as a delta over the window using a prior `task_state` snapshot passed through `DeriveOptions`; `retro.ts:261` add `scope: "turn" | "session"` and omit `goal` on turn-scoped retros; `evolve-cli.ts:97-111` fold N turn-retros of one session into one sample. `engine.ts:3900` passes the prior snapshot (`priorEvents` at `engine.ts:3185`).
- Rewrite the stale sections of `docs/auto-mode.md` to describe the code: supervised tier, out-of-band supervisor, containment routes, fails contained. Delete the `conversationalEscalation` knob (`auto-mode.ts:199`, `config.ts`, status at `auto-mode.ts:550`) or reimplement it; do not leave a dead option. Fix `docs/byop.md:16` and the comment at `device-code-strategy.ts:6-7`.
- README: remove "Current release: v0.3.0" until it is true; correct the install section per P1.4.

### P1.2 Commit the tree (half a day)
Stage by group, one commit each, never `add -A`: (1) plan-ledger program (`task-state.ts`, `agent-loop.ts` gates, `docs/plan-ledger.md`, tests); (2) self-evolution organ (`retro.ts`, `playbook.ts`, `evolve-cli.ts`, `notebook/*`, `docs/self-evolution.md`, tests); (3) audit CLI; (4) cost meter and UI fixes; (5) everything else with a truthful subject. Run the five gates before pushing.

### P1.3 One version source (1 day)
- `bun build --compile --define PRODUCT_VERSION=...` from the git tag (or `package.json` when untagged, suffixed `-dev+<sha>`), in `scripts/build-release.sh`, `scripts/install.sh`, `release.yml`, `ci.yml`. One target list in one place (`scripts/targets.sh` or a JSON read by all three).
- `release.yml`: refuse to publish when the tag ≠ the version the binary reports. Add `workflow_dispatch` with a `--dry-run` that builds and smokes without publishing; a `prerelease` input; `retention-days: 7` on intermediates.
- `CHANGELOG.md` (Keep a Changelog); `--generate-notes` stays as the GitHub body.

### P1.4 Installers for three OSes (1.5 days)
- Per D1: either make the repo public, or publish releases to a public mirror and host `web-install.sh` at a stable URL. The README one-liner must work anonymously.
- `web-install.sh`: verify `SHA256SUMS` before promoting; `GEAR_INSTALL_DIR`; non-interactive PATH write with a printed diff; `--uninstall`.
- `scripts/install.ps1` (`irm … | iex`): downloads `gear-windows-x64.exe` + `gear-tools-windows-x64.exe`, verifies, installs to `%LOCALAPPDATA%\Gear\bin`, updates user PATH. Add a Windows runtime smoke to CI (`packaged-e2e` matrix) and burn down the POSIX assumptions `ci.yml:144-146` documents.
- Homebrew tap (`savoir/tap`) with a formula generated by the release workflow.

### P1.5 Signing and provenance (1.5 days, needs secrets)
- macOS: Developer ID signing + notarization + stapling in `release.yml` for `gear` and `gear-tools` (and the desktop bundle in Phase 3). Windows: Authenticode if a certificate exists; otherwise document the SmartScreen caveat in the installer output. Linux: detached Ed25519 signature using the existing `packages/orchestrator/src/signing.ts` primitive, public key published in the README.
- `actions/attest-build-provenance` on every artifact.

### P1.6 `gear upgrade` (1 day)
- `gear upgrade [--check]`: `GET releases/latest`, compare with `PRODUCT_VERSION`, download + verify + atomic promotion (reuse `install.sh:294-311`), keep one backup. Daily rate-limited check on startup with a one-line nag; `[update] check = false` kill switch; never auto-apply without the user typing the command.

### P1.7 Release smoke on all three OSes (half a day)
`install-smoke` matrix: `ubuntu-latest, macos-latest, macos-13, windows-latest`, each running `gear --version`, `gear doctor`, `gear tools-smoke`, and `gear -P "print the word ok"` against a mock provider.

### P1.8 External validation (ongoing from day 3)
Two named people on two machines that are not the author's install from the public one-liner, run `gear tools-smoke` and one real task on a repo of their choice, and write what happened. Record in `docs/validation.md` with date, OS, version, outcome. This is the 25% of maturity that sits at 0.5.

## Gate

```bash
git status --porcelain | wc -l            # 0
bun run typecheck && bun test tests/unit/ # green, unsandboxed
gh release view v0.3.0                    # exists, 10 artifacts + SHA256SUMS + signatures
# fresh VM (or container) per OS:
curl -fsSL <public-url>/web-install.sh | bash && gear doctor && gear tools-smoke
irm <public-url>/install.ps1 | iex; gear doctor
gear upgrade --check                      # prints "up to date"
```

Done means: a stranger installs it in under five minutes on all three OSes, and `docs/validation.md` has two entries.
