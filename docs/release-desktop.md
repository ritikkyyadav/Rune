# Releasing Gear Desktop

`.github/workflows/desktop-release.yml` bundles the app for macOS, Windows and
Linux and publishes the update manifest. It is separate from
`release.yml`, which owns the CLI and `gear-tools`: two release paths editing one
file is how two people discover they were changing the same job.

Trigger it with a tag (`git tag v0.3.0 && git push origin v0.3.0`) or run it from
the Actions tab with `publish: false` for a build-only dry run.

---

## What it produces

| Platform    | Artifacts                         | Runner           |
| ----------- | --------------------------------- | ---------------- |
| macOS arm64 | `.dmg`, `.app`, updater `.tar.gz` | `macos-latest`   |
| macOS x64   | `.dmg`, `.app`, updater `.tar.gz` | `macos-latest`   |
| Windows x64 | `.msi`, NSIS `.exe`               | `windows-latest` |
| Linux x64   | `.AppImage`, `.deb`               | `ubuntu-22.04`   |

`fail-fast` is off. One platform's toolchain breaking must not hide whether the
others built.

## The sidecar

A packaged app ships the compiled `gear` binary and runs `gear engine-host`, so
a user needs neither Bun nor a source checkout. `scripts/stage-desktop-sidecar.sh`
compiles it to `apps/desktop/src-tauri/binaries/gear-<target-triple>`, which is
the filename Tauri's `externalBin` looks for. The script runs in CI and from
`beforeBuildCommand`, so a local `tauri build` stages it too.

`cargo check` **fails** when that file is missing — the sidecar is not optional
at build time. Run the script once after cloning:

```bash
bash scripts/stage-desktop-sidecar.sh
```

At runtime, `lib.rs` prefers the bundled binary and falls back to
`~/.gear/desktop.json` + Bun for a source checkout. The bundled one is checked
first only when it exists, so a developer running from source keeps their own
tree.

### Size, measured

From a real unsigned `tauri build` on macOS arm64, 2026-09-02:

| Artifact                                     | Size      |
| -------------------------------------------- | --------- |
| `Gear_0.3.0_aarch64.dmg` (what you download) | **30 MB** |
| `Gear.app` (what you install)                | **80 MB** |
| ↳ the `gear` sidecar inside it               | 69 MB     |
| ↳ `gear-desktop`, the Tauri shell            | 14 MB     |

The download meets the 30 MB budget; **the installed app does not, by 50 MB.**
Nearly all of it is one file: the compiled `gear` CLI embeds Bun's runtime.

The trade is deliberate. A person who never opens a terminal has no other way to
obtain an engine, and an app that refuses to start until you install a CLI is
not a desktop product. Getting the installed size down means not embedding a
JavaScript runtime — a Rust rewrite of the host, or a dependency on a
system-installed `node` — and neither is a Phase 3 decision.

## Signing

Every signing step is **guarded on its secret being present** and prints why it
skipped when it is not. This follows the pattern Phase 1 established in
`.github/workflows/release.yml` (lane A, PR #4) rather than re-implementing it.
An unsigned release is a worse product; a release workflow that fails because a
certificate has not been bought yet is a worse repository.

| Secret                                                                 | Used for                            | Absent →                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PWD`, `MACOS_SIGNING_IDENTITY` | Developer ID signing                | `.dmg` ships unsigned; Gatekeeper warns                                   |
| `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`                      | Notarization + stapling             | signed but not notarized; Gatekeeper still warns                          |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PWD`                       | Authenticode                        | `.msi` ships unsigned; SmartScreen warns                                  |
| `TAURI_UPDATER_PRIVATE_KEY`, `TAURI_UPDATER_KEY_PASSWORD`              | The update manifest's own signature | `latest.json` is unsigned and **no installed app will accept the update** |

The first three are the CLI's secrets, reused. The last pair is new and specific
to the app.

## The updater

`tauri-plugin-updater` is registered unconditionally in `lib.rs` and configured
in `tauri.conf.json`. It checks
`https://github.com/ritikkyyadav/Alan/releases/latest/download/latest.json` and
verifies the signature against the public key compiled into the app.

**`pubkey` is empty and must be filled in before auto-update works.** That is
not an oversight: an updater that installs whatever a URL hands it is worse than
no updater, and with an empty key the plugin accepts nothing. To arm it:

```bash
bun x tauri signer generate -w ~/.gear/keys/tauri-updater.key
# → prints a public key; paste it into tauri.conf.json plugins.updater.pubkey
# → store the private key as TAURI_UPDATER_PRIVATE_KEY (and its password as
#   TAURI_UPDATER_KEY_PASSWORD) in the repository's Actions secrets
```

Each matrix leg emits its own one-platform `latest.json`; the publish job merges
them into a single document, because the updater reads one and four last-writers
is not a merge strategy.

## Founder actions

Nothing below can be done by an agent — each needs an account, a purchase, or a
key that must not be in a repository.

1. **Generate the updater key pair** and paste the public half into
   `tauri.conf.json` (`plugins.updater.pubkey`). Until then, auto-update is
   inert by design.
2. **Buy an Apple Developer ID** ($99/yr) and add `MACOS_CERTIFICATE`,
   `MACOS_CERTIFICATE_PWD`, `MACOS_SIGNING_IDENTITY`, `APPLE_ID`,
   `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`.
3. **Buy a Windows code-signing certificate** (OV or EV) and add
   `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PWD`. Without it SmartScreen
   warns on every install until reputation accrues.
4. **Decide the download host.** The repository is private (D1), so the
   `releases/latest/download/...` endpoint the updater points at is not publicly
   reachable. Either the repository goes public, or a releases-only mirror
   serves the manifest and the endpoint changes.
5. **Supply the app icon** (D2). The icons in `src-tauri/icons/` are the
   pre-rebrand gear mark.

## Verifying a build locally

```bash
bash scripts/stage-desktop-sidecar.sh
bun x --cwd apps/desktop tauri build --bundles dmg,app     # unsigned
open apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg
```

An unsigned local `.app` will be quarantined by Gatekeeper on first open;
right-click → Open, or `xattr -dr com.apple.quarantine <app>`.

**If `bundle_dmg.sh` fails** with `failed to run .../bundle_dmg.sh`, an earlier
interrupted build left its scratch image mounted. It is not a code failure:

```bash
hdiutil info | grep /Volumes          # find the stale dmg.XXXXXX mount
hdiutil detach /Volumes/dmg.XXXXXX -force
rm -f apps/desktop/src-tauri/target/*/release/bundle/macos/rw.*.dmg
```

### Why updater artifacts are off by default

`bundle.createUpdaterArtifacts` is `false` in `tauri.conf.json`. Tauri refuses
to emit an updater artifact it cannot sign, so enabling it unconditionally makes
**every** unsigned build fail at the last step — CI's, and every developer's.
The release workflow merges `src-tauri/tauri.release.conf.json` in with
`--config` only when `TAURI_SIGNING_PRIVATE_KEY` is present. Guarding the
artifact rather than the failure is the same rule the certificates follow.
