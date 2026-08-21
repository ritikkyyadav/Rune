#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Gear — one-line web installer  (curl | bash)
#  Downloads the prebuilt standalone CLI for this machine and installs it to
#  ~/.alan/bin/gear. No Bun, no source, no build step.
#
#  Paste this on your site:
#    curl -fsSL https://YOUR-DOMAIN/install.sh | bash
#
#  Optional env:
#    GEAR_REPO=owner/repo            GitHub repo hosting the releases
#    GEAR_VERSION=v0.2.0             release tag (default: latest)
#    GEAR_TELEMETRY_ENDPOINT=url     if set, enables the opt-in channel by
#                                    writing [telemetry] into ~/.alan/config.toml
#    GEAR_TELEMETRY_TOKEN=secret     collector bearer token (with the above)
#  Legacy ELIO_* and BERNE_* names remain accepted for deployment migration.
# ──────────────────────────────────────────────────────────
set -euo pipefail

REPO="${GEAR_REPO:-${ELIO_REPO:-${BERNE_REPO:-ritikkyyadav/Alan}}}"
VERSION="${GEAR_VERSION:-${ELIO_VERSION:-${BERNE_VERSION:-latest}}}"
INSTALL_DIR="$HOME/.alan/bin"
TELEMETRY_ENDPOINT="${GEAR_TELEMETRY_ENDPOINT:-${ELIO_TELEMETRY_ENDPOINT:-${BERNE_TELEMETRY_ENDPOINT:-}}}"
TELEMETRY_TOKEN="${GEAR_TELEMETRY_TOKEN:-${ELIO_TELEMETRY_TOKEN:-${BERNE_TELEMETRY_TOKEN:-}}}"

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

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

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
ln -sf "$INSTALL_DIR/gear" "$INSTALL_DIR/elio"
ln -sf "$INSTALL_DIR/gear" "$INSTALL_DIR/berne"
ln -sf "$INSTALL_DIR/gear" "$INSTALL_DIR/alan"
say "$(c 32 ✓) Installed: $INSTALL_DIR/gear"

# ─── Optional: enable the opt-in telemetry channel for this install ───
if [ -n "$TELEMETRY_ENDPOINT" ]; then
  cfg="$HOME/.alan/config.toml"
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
say "  $(c 36 'export PATH="$HOME/.alan/bin:$PATH"')   $(c 90 '# add to ~/.zshrc or ~/.bashrc')"
echo ""
say "Then run: $(c 1 gear)"
say "$(c 90 'Free to start: grab a Google AI Studio key and `export GOOGLE_API_KEY=...`')"
echo ""
