#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Berne — one-line web installer  (curl | bash)
#  Downloads the prebuilt standalone CLI for this machine and installs it to
#  ~/.alan/bin/berne. No Bun, no source, no build step.
#
#  Paste this on your site:
#    curl -fsSL https://YOUR-DOMAIN/install.sh | bash
#
#  Optional env:
#    BERNE_REPO=owner/repo           GitHub repo hosting the releases
#    BERNE_VERSION=v0.2.0            release tag (default: latest)
#    BERNE_TELEMETRY_ENDPOINT=url    if set, enables the opt-in channel by
#                                    writing [telemetry] into ~/.alan/config.toml
#    BERNE_TELEMETRY_TOKEN=secret    collector bearer token (with the above)
# ──────────────────────────────────────────────────────────
set -euo pipefail

REPO="${BERNE_REPO:-ritikkyyadav/Alan}"
VERSION="${BERNE_VERSION:-latest}"
INSTALL_DIR="$HOME/.alan/bin"

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
asset="berne-${os}-${arch}"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

say "$(c 1 'Berne installer')"
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
mv "$tmp" "$INSTALL_DIR/berne"
say "$(c 32 ✓) Installed: $INSTALL_DIR/berne"

# ─── Optional: enable the opt-in telemetry channel for this install ───
if [ -n "${BERNE_TELEMETRY_ENDPOINT:-}" ]; then
  cfg="$HOME/.alan/config.toml"
  if ! grep -q "^\[telemetry\]" "$cfg" 2>/dev/null; then
    {
      echo ""
      echo "[telemetry]"
      echo "enabled = true"
      echo "endpoint = \"$BERNE_TELEMETRY_ENDPOINT\""
      [ -n "${BERNE_TELEMETRY_TOKEN:-}" ] && echo "token = \"$BERNE_TELEMETRY_TOKEN\""
    } >> "$cfg"
    say "$(c 32 ✓) Telemetry endpoint written to $cfg (users still opt in on first run)"
  fi
fi

echo ""
say "Add Berne to your PATH:"
say "  $(c 36 'export PATH="$HOME/.alan/bin:$PATH"')   $(c 90 '# add to ~/.zshrc or ~/.bashrc')"
echo ""
say "Then run: $(c 1 berne)"
say "$(c 90 'Free to start: grab a Google AI Studio key and `export GOOGLE_API_KEY=...`')"
echo ""
