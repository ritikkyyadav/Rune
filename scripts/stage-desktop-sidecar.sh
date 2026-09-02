#!/usr/bin/env bash
# ─── Stage the engine sidecar for a desktop bundle (P3.6) ───
#
# A packaged Gear Desktop ships the compiled `gear` binary and runs
# `gear engine-host`, so the user needs no Bun and no source checkout. Tauri
# takes that binary from `src-tauri/binaries/gear-<target-triple>` — the name is
# the contract, and it is why this script exists rather than a `cp` in a
# workflow: the triple has to be computed the same way on every platform, and
# `cargo check` fails outright when the file is missing.
#
# It compiles from source when it must and reuses an existing build when it can.
# Idempotent; safe to run before every build.
#
#   bash scripts/stage-desktop-sidecar.sh              # host platform
#   TARGET_TRIPLE=x86_64-apple-darwin bash scripts/... # cross-compile
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$root/apps/desktop/src-tauri/binaries"
mkdir -p "$out_dir"

# The Rust target triple Tauri will look for. `rustc -vV` is the authority;
# nothing here guesses from `uname`, because the two disagree on Apple Silicon.
if [ -n "${TARGET_TRIPLE:-}" ]; then
  triple="$TARGET_TRIPLE"
else
  triple="$(rustc -vV | awk '/^host:/ {print $2}')"
fi
[ -n "$triple" ] || { echo "could not determine the Rust target triple" >&2; exit 1; }

ext=""
case "$triple" in *windows*) ext=".exe" ;; esac
dest="$out_dir/gear-$triple$ext"

# Bun's cross-compile target names, from the Rust triple.
case "$triple" in
  aarch64-apple-darwin)      bun_target="bun-darwin-arm64" ;;
  x86_64-apple-darwin)       bun_target="bun-darwin-x64" ;;
  x86_64-unknown-linux-gnu)  bun_target="bun-linux-x64" ;;
  aarch64-unknown-linux-gnu) bun_target="bun-linux-arm64" ;;
  x86_64-pc-windows-msvc)    bun_target="bun-windows-x64" ;;
  *) echo "no bun target known for $triple" >&2; exit 1 ;;
esac

# A binary already staged for this triple and newer than the CLI entrypoint is
# reused: a desktop build should not pay for a CLI compile it does not need.
entry="$root/packages/orchestrator/src/bin/gear-cli.ts"
if [ -f "$dest" ] && [ "$dest" -nt "$entry" ]; then
  echo "sidecar up to date: $dest"
  exit 0
fi

echo "compiling the engine sidecar for $triple ($bun_target)…"
bun build --compile --minify --target="$bun_target" "$entry" --outfile "$dest"
chmod +x "$dest" 2>/dev/null || true
echo "staged $dest ($(du -h "$dest" | cut -f1))"
