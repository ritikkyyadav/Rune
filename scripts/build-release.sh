#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Rune — Release builder
#  Compiles the CLI into self-contained, standalone executables for each
#  platform via `bun build --compile`, so end users can download ONE file and
#  run it — no Bun, no source tree, no install step required.
#
#  The native Rust `rune-tools` executor cannot be cross-compiled here; this
#  script builds it for the HOST only (dist/rune-tools-<os>-<arch>) when cargo
#  is available. Build the other platforms on their own runners (CI does) and
#  upload them alongside — web-install.sh fetches them best-effort.
#
#  Usage: bash scripts/build-release.sh
#  Output: dist/rune-<os>-<arch> [+ dist/rune-tools-<host>] + dist/SHA256SUMS
# ──────────────────────────────────────────────────────────
set -euo pipefail

_resolve_script_dir() {
  local src="${BASH_SOURCE[0]}"
  while [ -L "$src" ]; do
    local dir; dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"; [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" && pwd
}
ROOT="$(cd -P "$(_resolve_script_dir)/.." && pwd)"
ENTRY="$ROOT/packages/orchestrator/src/bin/rune-cli.ts"
OUT="$ROOT/dist"

BUN="${BUN:-$( [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun" || command -v bun )}"
[ -z "$BUN" ] && { echo "✗ Bun not found (https://bun.sh)"; exit 1; }

# One target list, one version source - shared with release.yml and install.sh.
# shellcheck source=scripts/targets.sh
. "$ROOT/scripts/targets.sh"
# shellcheck source=scripts/version.sh
. "$ROOT/scripts/version.sh"
BUILD_VERSION="$(rune_version)"

echo "  Rune release builder"
echo "  ─────────────────────"
echo "  entry   : $ENTRY"
echo "  out     : $OUT"
echo "  version : $BUILD_VERSION"
echo ""

mkdir -p "$OUT"
( cd "$ROOT" && "$BUN" install --frozen-lockfile >/dev/null 2>&1 || true )

for pair in "${RUNE_TARGETS[@]}"; do
  target="${pair%%:*}"
  suffix="${pair##*:}"
  outfile="$OUT/rune-$suffix"
  printf "  building %-22s → %s\n" "$target" "$(basename "$outfile")"
  ( cd "$ROOT" && "$BUN" build --compile --minify --target="$target" \
      --define=RUNE_BUILD_VERSION="\"$BUILD_VERSION\"" "$ENTRY" --outfile "$outfile" ) \
    || { echo "    ✗ failed ($target) — skipping"; continue; }
done

# Host-native rune-tools (best effort).
if command -v cargo >/dev/null 2>&1; then
  host_os="$(uname -s | tr '[:upper:]' '[:lower:]')"; case "$host_os" in darwin|linux) ;; *) host_os="" ;; esac
  host_arch="$(uname -m)"; case "$host_arch" in arm64|aarch64) host_arch="arm64" ;; x86_64|amd64) host_arch="x64" ;; *) host_arch="" ;; esac
  if [ -n "$host_os" ] && [ -n "$host_arch" ]; then
    printf "  building %-22s → %s\n" "rune-tools (host)" "rune-tools-$host_os-$host_arch"
    if ( cd "$ROOT" && cargo build --release -p rune-tools >/dev/null 2>&1 ); then
      cp "$ROOT/target/release/rune-tools" "$OUT/rune-tools-$host_os-$host_arch"
    else
      echo "    ✗ cargo build failed — skipping rune-tools"
    fi
  fi
else
  echo "  · cargo not found — skipping the host rune-tools build"
fi

echo ""
echo "  checksums → dist/SHA256SUMS"
( cd "$OUT" && { command -v shasum >/dev/null && shasum -a 256 rune-* || sha256sum rune-*; } > SHA256SUMS )

echo ""
echo "  ✓ Done ($BUILD_VERSION). Upload dist/* to your GitHub release (tag = the version)."
echo "    Users then install with scripts/web-install.sh (curl | bash)."
