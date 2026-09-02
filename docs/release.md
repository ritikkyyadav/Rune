# Releasing Gear

Everything a release needs is automated. What is _not_ automated is anything that requires an
account, a credential, or a decision only the founder can make — those are listed at the bottom, by
name, with exactly what to do.

---

## The one version source

The version lives in exactly one place: `scripts/version.sh`. Every build path calls it and injects
the answer into the binary with `bun build --define=GEAR_BUILD_VERSION=...`.

```
1. $GEAR_VERSION            an explicit override (CI passes the tag)
2. the exact git tag at HEAD   v1.2.3 → 1.2.3
3. package.json + -dev+<sha>   everything else
```

```bash
bash scripts/version.sh          # what would this build report?
```

`scripts/targets.sh` is the same idea for platforms: one list, read by `scripts/build-release.sh` and
by `release.yml`. Adding a platform means editing one file.

Nothing else — no `package.json`, no `brand.ts` literal, no installer banner — carries a version.
`release.yml` reads the built binary's own `--version` and **refuses to publish** when it disagrees
with the tag.

---

## Cutting a release

```bash
# 1. Update CHANGELOG.md: rename [Unreleased] to the version, date it,
#    open a fresh [Unreleased] section.
# 2. Bump the semver in packages/*/package.json and apps/web/package.json.
#    (This is the fallback for dev builds; the tag is what a release reports.)
# 3. Commit, then tag and push.
git tag v0.3.0
git push origin v0.3.0
```

The tag push runs `.github/workflows/release.yml`, which:

1. resolves the version from the tag (one source);
2. cross-compiles the CLI for five targets, version injected;
3. builds `gear-tools` natively on four runners plus a cross build for `linux-arm64`;
4. verifies every asset the target list names is present — an incomplete set fails here rather than
   becoming a half-broken release;
5. generates `SHA256SUMS` **in the same job** that assembled the binaries, so checksum drift is
   impossible by construction;
6. smoke-runs the Linux pair end to end (`--version`, then a real `tools-smoke`);
7. **refuses to publish if the binary's version ≠ the tag**;
8. generates `Formula/gear.rb` into a `homebrew-tap` artifact from the checksums it just computed;
9. publishes the GitHub release with `--generate-notes`;
10. re-installs from the published release exactly the way the README instructs, and runs it.

### Rehearsing without publishing

`workflow_dispatch` runs the entire pipeline with `publish: false` by default — build, checksums,
smoke and the version check, no release created. Use it to exercise the release path on a branch
before any tag exists.

```
Actions → Release → Run workflow
  version:    0.3.0-rc1     (optional; defaults to the dev version)
  publish:    false         (dry run)
  prerelease: false
```

---

## Installing

| Platform            | Command                                                          |
| ------------------- | ---------------------------------------------------------------- |
| macOS, Linux        | `curl -fsSL <url>/web-install.sh \| bash`                        |
| Windows             | `irm <url>/install.ps1 \| iex`                                   |
| Homebrew            | `brew install savoir/tap/gear` (once the tap exists — see below) |
| Uninstall (POSIX)   | `curl -fsSL <url>/web-install.sh \| bash -s -- --uninstall`      |
| Uninstall (Windows) | `.\install.ps1 -Uninstall`                                       |

Both installers verify every download against the release's `SHA256SUMS` **before** anything reaches
the install directory. A mismatch, or a release with no `SHA256SUMS`, exits non-zero with the old
binary untouched. `GEAR_INSTALL_DIR` (POSIX) and `-InstallDir` (Windows) relocate the install.

The POSIX installer prints the exact PATH line before appending it, and when piped from `curl` — where
there is nobody to ask — it prints the line for you to add rather than editing a profile behind your
back. `--path` opts into the write; `--no-path` forbids it.

### Updating

```bash
gear upgrade --check    # is there a newer release?
gear upgrade            # download, verify, install; keeps one .backup
```

Gear looks at the latest release at most once a day in the background and the only result is one line
at startup. Nothing is ever replaced without the command being typed. `[update] check = false` in
`~/.gear/config.toml` turns the background look off entirely.

---

## Founder actions

These need an account, a credential, or a decision. Nothing in the repo can do them.

### D1 — Make the install one-liner work (blocks Phase 1's gate)

The README's `curl | bash` cannot work today: the repo is private, so anonymous `curl` gets a 404.
Until this is done, the "install: one command, three OSes" scorecard row stays at 0 of 3 and external
validation (25% of the maturity score) cannot move.

Pick one:

**A. Make the repo public** (the program's recommendation, D1 open-core). Then:

1. Settings → General → Danger Zone → Change visibility → Public.
2. Confirm the release assets are reachable anonymously:
   ```bash
   curl -fsSLI https://github.com/ritikkyyadav/Alan/releases/latest/download/SHA256SUMS
   ```
3. Replace `<url>` in the README with
   `https://raw.githubusercontent.com/ritikkyyadav/Alan/main/scripts` and check the one-liner from a
   machine that is not signed in.

A `LICENSE` file (Apache-2.0) is already in the tree, added under the D1 default. Drop that commit if
open-core is not the decision.

**B. Keep the repo private and publish through a mirror.** Create a public repo (say
`savoir/gear-releases`) that holds only the two install scripts and the release assets, add a step to
`release.yml` that pushes assets there with a PAT, and point the README at the mirror. More moving
parts and a second place to keep in sync; only worth it if the source must stay closed.

Either way the installer needs a stable URL. `raw.githubusercontent.com` is free and works; a
`get.gear.dev` vanity URL is a CNAME plus a redirect and is purely cosmetic.

### D1b — The Homebrew tap

`release.yml` generates `Formula/gear.rb` and uploads it as a `homebrew-tap` artifact. It does not
push to another repository, because that needs a token this workflow should not hold.

1. Create a public repo named **`homebrew-tap`** under the tap owner (`savoir/homebrew-tap` makes
   `brew install savoir/tap/gear` work).
2. After each release, download the `homebrew-tap` artifact from the run and commit
   `Formula/gear.rb` into it.
3. To automate later: create a fine-grained PAT with `contents: write` on the tap repo only, store it
   as the `HOMEBREW_TAP_TOKEN` secret, and add a push step. Keep it scoped to the tap — a token that
   can write to the source repo has no business in a release workflow.

Verify with:

```bash
brew install --build-from-source savoir/tap/gear && gear --version && gear tools-smoke
```

### D1c — Signing secrets

`release.yml` signs when the secrets exist and skips, with a printed note, when they do not.
Unsigned macOS downloads hit Gatekeeper ("cannot be opened because the developer cannot be
verified") and unsigned Windows downloads hit SmartScreen. Both are the difference between an
install that works and one a stranger abandons.

| Secret                     | What it is                                                              | Where it comes from                                                                              |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `MACOS_CERTIFICATE`        | Developer ID Application cert + key, exported as `.p12`, base64-encoded | Apple Developer Program membership ($99/yr) → Certificates → Developer ID Application            |
| `MACOS_CERTIFICATE_PWD`    | The password used when exporting the `.p12`                             | You choose it at export time                                                                     |
| `MACOS_SIGNING_IDENTITY`   | e.g. `Developer ID Application: Savoir Ltd (TEAMID)`                    | `security find-identity -v -p codesigning` after importing                                       |
| `APPLE_ID`                 | The Apple ID used for notarization                                      | Your developer account email                                                                     |
| `APPLE_APP_PASSWORD`       | An app-specific password, **not** the account password                  | appleid.apple.com → Sign-In and Security → App-Specific Passwords                                |
| `APPLE_TEAM_ID`            | 10-character team identifier                                            | developer.apple.com → Membership                                                                 |
| `WINDOWS_CERTIFICATE`      | Authenticode code-signing cert as base64 `.pfx`                         | A CA (DigiCert, Sectigo, SSL.com); OV ≈ $200–400/yr, EV more and needs a token                   |
| `WINDOWS_CERTIFICATE_PWD`  | The `.pfx` password                                                     | You choose it                                                                                    |
| `GEAR_SIGNING_PRIVATE_KEY` | Ed25519 private key (base64) for detached Linux signatures              | `bun run scripts/keygen.ts`, or any Ed25519 keypair — see `packages/orchestrator/src/signing.ts` |

Add each at Settings → Secrets and variables → Actions → New repository secret.

Every signing step is guarded on its own secret and prints a GitHub warning naming what was skipped
and what the consequence is. A release with no secrets configured still builds, checksums, smokes and
publishes — it is simply unsigned. A release workflow that fails because a certificate has not been
bought yet would be a worse repository than an unsigned release.

macOS is the one that matters most — Gatekeeper blocks by default, SmartScreen only warns — so if you
buy one certificate, buy the Apple one. Note that a bare Mach-O executable cannot be _stapled_ (there
is nowhere in the file to put the ticket); the workflow attempts it, says so when it cannot, and the
notarization ticket is looked up online instead. That is normal for CLI binaries.

**The Linux signing key**, which costs nothing and is the one you can do today:

```bash
bun scripts/keygen.ts
```

It prints the keypair rather than writing it — a private key inside a git repository is one
`git add -A` away from being public, and that has happened in this repo before. Paste the base64
private half into `GEAR_SIGNING_PRIVATE_KEY`, put the public half in the README's verification block
(replacing the placeholder), and store the private key in a password manager too: losing it means
publishing a new public key that every existing verifier will reject.

What gets signed is `SHA256SUMS`, not each binary — that file names every artifact with its digest
and is generated in the same job that built them, so one signature covers the release. The workflow
verifies its own signature before writing it, against the public key derived from the same private
key, so a broken signature cannot ship.

Build provenance is free and needs no secret: `actions/attest-build-provenance` runs on every
release and ties the bytes to this workflow, this commit and this runner.

```bash
gh attestation verify gear-linux-x64 --repo ritikkyyadav/Alan
```

### D1d — External validation

Two named people, on two machines that are not yours, install from the public one-liner, run
`gear tools-smoke` and one real task, and write down what happened. Record each in
`docs/validation.md` with date, OS, version and outcome. This is the 25% of the maturity score
currently sitting at 0.5, and no amount of engineering moves it.

---

## Windows caveats

There is no OS sandbox on Windows. 1st and 2nd gear behave exactly as they do elsewhere; 3rd and 4th
gear run shell commands without the containment macOS and Linux provide. `install.ps1` says this out
loud after installing. WSL2 is the answer for anyone who needs the sandbox. A native Windows sandbox
is deferred (program decision D4).

Windows binaries are built for `x64` only. `install.ps1` refuses on ARM64 rather than silently
installing an emulated binary.
