#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Gear — Release builder
#  Compiles the CLI into self-contained, standalone executables for each
#  platform via `bun build --compile`, so end users can download ONE file and
#  run it — no Bun, no source tree, no install step required.
#
#  (The optional native Rust `alan-tools` accelerator is NOT bundled here; the
#   CLI runs fine without it. Users who want it build from source via
#   scripts/install.sh. The release binaries are the portable CLI.)
#
#  Usage: bash scripts/build-release.sh
#  Output: dist/gear-<os>-<arch>  +  dist/SHA256SUMS
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
ENTRY="$ROOT/packages/orchestrator/src/bin/alan-cli.ts"
OUT="$ROOT/dist"

BUN="${BUN:-$( [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun" || command -v bun )}"
[ -z "$BUN" ] && { echo "✗ Bun not found (https://bun.sh)"; exit 1; }

# bun-target → output-suffix
TARGETS=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-x64:linux-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-windows-x64:windows-x64.exe"
)

echo "  Gear release builder"
echo "  ─────────────────────"
echo "  entry : $ENTRY"
echo "  out   : $OUT"
echo ""

mkdir -p "$OUT"
( cd "$ROOT" && "$BUN" install --frozen-lockfile >/dev/null 2>&1 || true )

for pair in "${TARGETS[@]}"; do
  target="${pair%%:*}"
  suffix="${pair##*:}"
  outfile="$OUT/gear-$suffix"
  printf "  building %-22s → %s\n" "$target" "$(basename "$outfile")"
  ( cd "$ROOT" && "$BUN" build --compile --minify --target="$target" "$ENTRY" --outfile "$outfile" ) \
    || { echo "    ✗ failed ($target) — skipping"; continue; }
done

echo ""
echo "  checksums → dist/SHA256SUMS"
( cd "$OUT" && { command -v shasum >/dev/null && shasum -a 256 gear-* || sha256sum gear-*; } > SHA256SUMS )

echo ""
echo "  ✓ Done. Upload dist/* to your GitHub release (tag = the version)."
echo "    Users then install with scripts/web-install.sh (curl | bash)."
