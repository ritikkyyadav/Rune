#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Gear — one-line web installer  (curl | bash)
#  Downloads the prebuilt standalone CLI for this machine and installs it to
#  ~/.gear/bin/gear. No Bun, no source, no build step.
#
#  Paste this on your site:
#    curl -fsSL https://YOUR-DOMAIN/install.sh | bash
#
#  Optional env:
#    GEAR_REPO=owner/repo            GitHub repo hosting the releases
#    GEAR_VERSION=v0.3.0             release tag (default: latest)
#    GEAR_TELEMETRY_ENDPOINT=url     if set, enables the opt-in channel by
#                                    writing [telemetry] into ~/.gear/config.toml
#    GEAR_TELEMETRY_TOKEN=secret     collector bearer token (with the above)
#  The CLI also accepts a best-effort native accelerator: if the release ships
#  gear-tools-<os>-<arch> it is installed next to the CLI (optional).
# ──────────────────────────────────────────────────────────
set -euo pipefail

REPO="${GEAR_REPO:-ritikkyyadav/Alan}"
VERSION="${GEAR_VERSION:-latest}"
INSTALL_DIR="$HOME/.gear/bin"
TELEMETRY_ENDPOINT="${GEAR_TELEMETRY_ENDPOINT:-}"
TELEMETRY_TOKEN="${GEAR_TELEMETRY_TOKEN:-}"

# ─── Rename migration: ~/.alan → ~/.gear (once; symlink keeps old paths alive) ───
migrate_home() {
  if [ ! -e "$HOME/.gear" ] && [ -d "$HOME/.alan" ] && [ ! -L "$HOME/.alan" ]; then
    if mv "$HOME/.alan" "$HOME/.gear" 2>/dev/null; then
      ln -s "$HOME/.gear" "$HOME/.alan" 2>/dev/null || true
      echo "  · moved ~/.alan → ~/.gear (a symlink ~/.alan → ~/.gear keeps old paths working)" >&2
    fi
  fi
}
migrate_home

c()  { printf '\033[%sm%s\033[0m' "$1" "$2"; }
say() { echo "  $*"; }

# ─── Detect platform ───
uname_s="$(uname -s)"; uname_m="$(uname -m)"
case "$uname_s" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) say "$(c 31 ✗) Unsupported OS: $uname_s. Install from source: https://github.com/$REPO"; exit 1 ;;
esac
case "$uname_m" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) say "$(c 31 ✗) Unsupported arch: $uname_m"; exit 1 ;;
esac
# linux-arm64 + darwin both ship; linux only builds x64/arm64
asset="gear-${os}-${arch}"
tools_asset="gear-tools-${os}-${arch}"

if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi
url="$base/$asset"
tools_url="$base/$tools_asset"

say "$(c 1 'Gear installer')"
say "$(c 90 "platform: $os-$arch")"
say "$(c 90 "download : $url")"
echo ""

mkdir -p "$INSTALL_DIR"
tmp="$(mktemp)"
if ! curl -fSL "$url" -o "$tmp"; then
  say "$(c 31 ✗) Download failed. Check the release exists for $os-$arch at:"
  say "   https://github.com/$REPO/releases"
  rm -f "$tmp"; exit 1
fi
chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/gear"
for old in elio berne alan; do [ -L "$INSTALL_DIR/$old" ] && rm -f "$INSTALL_DIR/$old"; done
say "$(c 32 ✓) Installed: $INSTALL_DIR/gear"

# Native tool executor (file/search/shell tools run through it) — REQUIRED.
# Releases ship a gear + gear-tools pair per platform; a missing pair means a
# broken install, so fail loudly instead of degrading. GEAR_SKIP_TOOLS=1 skips
# (for source builds that compile crates/gear-tools themselves).
if [ "${GEAR_SKIP_TOOLS:-}" = "1" ]; then
  say "$(c 90 "· GEAR_SKIP_TOOLS=1 — skipping $tools_asset (build it with: cargo build --release -p gear-tools)")"
else
  tmp_tools="$(mktemp)"
  if curl -fsSL "$tools_url" -o "$tmp_tools" 2>/dev/null; then
    chmod +x "$tmp_tools" && mv "$tmp_tools" "$INSTALL_DIR/gear-tools"
    say "$(c 32 ✓) Installed: $INSTALL_DIR/gear-tools"
  else
    rm -f "$tmp_tools"
    say "$(c 31 ✗) $tools_asset missing from this release — file, search, and shell tools would fail."
    say "   Re-run with GEAR_SKIP_TOOLS=1 to install the CLI alone, or install from source."
    exit 1
  fi
fi

# ─── Optional: enable the opt-in telemetry channel for this install ───
if [ -n "$TELEMETRY_ENDPOINT" ]; then
  cfg="$HOME/.gear/config.toml"
  if ! grep -q "^\[telemetry\]" "$cfg" 2>/dev/null; then
    {
      echo ""
      echo "[telemetry]"
      echo "enabled = true"
      echo "endpoint = \"$TELEMETRY_ENDPOINT\""
      [ -n "$TELEMETRY_TOKEN" ] && echo "token = \"$TELEMETRY_TOKEN\""
    } >> "$cfg"
    say "$(c 32 ✓) Telemetry endpoint written to $cfg (users still opt in on first run)"
  fi
fi

echo ""
say "Add Gear to your PATH:"
say "  $(c 36 'export PATH="$HOME/.gear/bin:$PATH"')   $(c 90 '# add to ~/.zshrc or ~/.bashrc')"
echo ""
say "Then run: $(c 1 gear)"
say "$(c 90 'Free to start: grab a Google AI Studio key and `export GOOGLE_API_KEY=...`')"
echo ""
