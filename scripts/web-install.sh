#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Gear — one-line web installer  (curl | bash)
#  Downloads the prebuilt standalone CLI + native tools executor for this
#  machine, VERIFIES them against the release's SHA256SUMS, and installs them
#  to ~/.gear/bin. No Bun, no source, no build step.
#
#  Paste this on your site:
#    curl -fsSL https://YOUR-DOMAIN/install.sh | bash
#
#  Flags (curl … | bash -s -- <flag>):
#    --uninstall           remove the binaries, the PATH line, and nothing else
#    --path                write the PATH line without being asked
#    --no-path             never touch a shell profile
#
#  Optional env:
#    GEAR_REPO=owner/repo            GitHub repo hosting the releases
#    GEAR_VERSION=v0.3.0             release tag (default: latest)
#    GEAR_INSTALL_DIR=/usr/local/bin where the binaries go (default ~/.gear/bin)
#    GEAR_SKIP_TOOLS=1               install the CLI alone (source builds only)
#    GEAR_TELEMETRY_ENDPOINT=url     if set, enables the opt-in channel by
#                                    writing [telemetry] into ~/.gear/config.toml
#    GEAR_TELEMETRY_TOKEN=secret     collector bearer token (with the above)
#
#  Releases ship a gear + gear-tools pair per platform, and the pair is
#  REQUIRED — file and shell tools run through the native gear-tools executor.
#
#  On checksums: a `curl | bash` installer that does not verify what it
#  downloaded is a pipe from a CDN straight to an executable bit. The release
#  workflow generates SHA256SUMS in the same job that produced the binaries, so
#  verification here is end-to-end and not decorative.
# ──────────────────────────────────────────────────────────
set -euo pipefail

REPO="${GEAR_REPO:-ritikkyyadav/Alan}"
VERSION="${GEAR_VERSION:-latest}"
INSTALL_DIR="${GEAR_INSTALL_DIR:-$HOME/.gear/bin}"
TELEMETRY_ENDPOINT="${GEAR_TELEMETRY_ENDPOINT:-}"
TELEMETRY_TOKEN="${GEAR_TELEMETRY_TOKEN:-}"

MODE="install"
PATH_MODE="ask"
for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE="uninstall" ;;
    --path)      PATH_MODE="yes" ;;
    --no-path)   PATH_MODE="no" ;;
    -h|--help)   sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

c()  { printf '\033[%sm%s\033[0m' "$1" "$2"; }
say() { echo "  $*"; }

# ─── Rename migration: ~/.alan → ~/.gear (once; symlink keeps old paths alive) ───
migrate_home() {
  if [ ! -e "$HOME/.gear" ] && [ -d "$HOME/.alan" ] && [ ! -L "$HOME/.alan" ]; then
    if mv "$HOME/.alan" "$HOME/.gear" 2>/dev/null; then
      ln -s "$HOME/.gear" "$HOME/.alan" 2>/dev/null || true
      echo "  · moved ~/.alan → ~/.gear (a symlink ~/.alan → ~/.gear keeps old paths working)" >&2
    fi
  fi
}

# ─── The PATH line, and which profile carries it ───
# One line, in one file, printed before it is written. An installer that edits
# a shell profile silently is an installer you cannot review.
profile_file() {
  case "${SHELL##*/}" in
    zsh)  echo "$HOME/.zshrc" ;;
    bash) [ -f "$HOME/.bash_profile" ] && echo "$HOME/.bash_profile" || echo "$HOME/.bashrc" ;;
    fish) echo "$HOME/.config/fish/config.fish" ;;
    *)    echo "$HOME/.profile" ;;
  esac
}

path_line_for() {
  case "$1" in
    *config.fish) printf 'fish_add_path %s\n' "$INSTALL_DIR" ;;
    *)            printf 'export PATH="%s:$PATH"\n' "$INSTALL_DIR" ;;
  esac
}

already_on_path() {
  case ":$PATH:" in *":$INSTALL_DIR:"*) return 0 ;; *) return 1 ;; esac
}

write_path() {
  local file line
  file="$(profile_file)"
  line="$(path_line_for "$file")"
  if [ -f "$file" ] && grep -qF -- "$INSTALL_DIR" "$file" 2>/dev/null; then
    say "$(c 32 ✓) $INSTALL_DIR is already in $(basename "$file")"
    return 0
  fi
  echo ""
  say "$(c 1 'PATH change') — this exact line will be appended to $file:"
  echo ""
  say "    $(c 36 "$line")"
  echo ""
  mkdir -p "$(dirname "$file")"
  {
    echo ""
    echo "# Added by the Gear installer"
    printf '%s\n' "$line"
  } >> "$file"
  say "$(c 32 ✓) Appended to $file — open a new shell, or: $(c 36 "source $file")"
}

# ─── Uninstall ───
if [ "$MODE" = "uninstall" ]; then
  say "$(c 1 'Gear uninstaller')"
  removed=0
  for name in gear gear-compiled gear-tools gear-compiled.meta \
              gear.backup gear-tools.backup gear-compiled.backup; do
    if [ -e "$INSTALL_DIR/$name" ]; then
      # A guarded install marks its artifacts immutable on macOS.
      command -v chflags >/dev/null 2>&1 && chflags nouchg "$INSTALL_DIR/$name" 2>/dev/null || true
      rm -f "$INSTALL_DIR/$name"
      say "$(c 32 ✓) removed $INSTALL_DIR/$name"
      removed=1
    fi
  done
  [ "$removed" = "0" ] && say "$(c 90 "· nothing to remove in $INSTALL_DIR")"
  profile="$(profile_file)"
  if [ -f "$profile" ] && grep -qF -- "Added by the Gear installer" "$profile" 2>/dev/null; then
    tmp="$(mktemp)"
    grep -vF -- "Added by the Gear installer" "$profile" \
      | grep -vF -- "$INSTALL_DIR" > "$tmp" || true
    mv "$tmp" "$profile"
    say "$(c 32 ✓) removed the PATH line from $profile"
  fi
  echo ""
  say "Your data is untouched: $(c 36 "$HOME/.gear") still holds sessions, config and credentials."
  say "Remove it yourself if you mean to: $(c 36 "rm -rf ~/.gear")"
  echo ""
  exit 0
fi

migrate_home

# ─── Detect platform ───
uname_s="$(uname -s)"; uname_m="$(uname -m)"
case "$uname_s" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  MINGW*|MSYS*|CYGWIN*)
    say "$(c 31 ✗) This is the POSIX installer. On Windows, run PowerShell and:"
    say "   $(c 36 'irm https://raw.githubusercontent.com/'"$REPO"'/main/scripts/install.ps1 | iex')"
    exit 1 ;;
  *) say "$(c 31 ✗) Unsupported OS: $uname_s. Install from source: https://github.com/$REPO"; exit 1 ;;
esac
case "$uname_m" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) say "$(c 31 ✗) Unsupported arch: $uname_m"; exit 1 ;;
esac
asset="gear-${os}-${arch}"
tools_asset="gear-tools-${os}-${arch}"

if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

say "$(c 1 'Gear installer')"
say "$(c 90 "platform : $os-$arch")"
say "$(c 90 "release  : $VERSION")"
say "$(c 90 "install  : $INSTALL_DIR")"
echo ""

# ─── A staging directory nothing escapes until it is verified ───
STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

fetch() { curl -fsSL "$1" -o "$2"; }

# sha256 is spelled differently on macOS and Linux.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else echo ""; fi
}

# The expected digest for one asset, read out of the release's SHA256SUMS.
expected_sha() {
  awk -v want="$1" '$2 == want || $2 == "*" want { print $1; exit }' "$STAGE/SHA256SUMS"
}

verify() {
  local file="$1" name="$2" want got
  want="$(expected_sha "$name")"
  if [ -z "$want" ]; then
    say "$(c 31 ✗) SHA256SUMS does not list $name — refusing to install unverified bytes."
    exit 1
  fi
  got="$(sha256_of "$file")"
  if [ -z "$got" ]; then
    say "$(c 31 ✗) No sha256sum or shasum on this machine; cannot verify the download."
    say "   Install coreutils (or use the source install) rather than running unverified binaries."
    exit 1
  fi
  if [ "$want" != "$got" ]; then
    say "$(c 31 ✗) Checksum mismatch for $name."
    say "   expected $want"
    say "   got      $got"
    say "   Nothing was installed."
    exit 1
  fi
  say "$(c 32 ✓) verified $name"
}

# ─── Download everything first ───
if ! fetch "$base/SHA256SUMS" "$STAGE/SHA256SUMS"; then
  say "$(c 31 ✗) This release publishes no SHA256SUMS. Refusing to install unverified binaries."
  say "   Releases are at https://github.com/$REPO/releases"
  exit 1
fi
if ! fetch "$base/$asset" "$STAGE/$asset"; then
  say "$(c 31 ✗) Download failed. Check the release has $asset at:"
  say "   https://github.com/$REPO/releases"
  exit 1
fi
verify "$STAGE/$asset" "$asset"

want_tools=1
[ "${GEAR_SKIP_TOOLS:-}" = "1" ] && want_tools=0
if [ "$want_tools" = "1" ]; then
  if ! fetch "$base/$tools_asset" "$STAGE/$tools_asset"; then
    say "$(c 31 ✗) $tools_asset missing from this release — file, search, and shell tools would fail."
    say "   Re-run with GEAR_SKIP_TOOLS=1 to install the CLI alone, or install from source."
    exit 1
  fi
  verify "$STAGE/$tools_asset" "$tools_asset"
fi

# ─── Promote (nothing before this point touched the install directory) ───
mkdir -p "$INSTALL_DIR"
chmod +x "$STAGE/$asset"
mv "$STAGE/$asset" "$INSTALL_DIR/gear"
say "$(c 32 ✓) Installed: $INSTALL_DIR/gear"
if [ "$want_tools" = "1" ]; then
  chmod +x "$STAGE/$tools_asset"
  mv "$STAGE/$tools_asset" "$INSTALL_DIR/gear-tools"
  say "$(c 32 ✓) Installed: $INSTALL_DIR/gear-tools"
else
  say "$(c 90 "· GEAR_SKIP_TOOLS=1 — build it with: cargo build --release -p gear-tools")"
fi
for old in elio berne alan; do [ -L "$INSTALL_DIR/$old" ] && rm -f "$INSTALL_DIR/$old"; done

# ─── Optional: enable the opt-in telemetry channel for this install ───
if [ -n "$TELEMETRY_ENDPOINT" ]; then
  cfg="$HOME/.gear/config.toml"
  mkdir -p "$(dirname "$cfg")"
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

# ─── PATH ───
if already_on_path; then
  say "$(c 32 ✓) $INSTALL_DIR is already on your PATH"
elif [ "$PATH_MODE" = "yes" ]; then
  write_path
elif [ "$PATH_MODE" = "no" ]; then
  echo ""
  say "Add Gear to your PATH:"
  say "  $(c 36 "export PATH=\"$INSTALL_DIR:\$PATH\"")   $(c 90 '# add to your shell profile')"
elif [ -t 0 ]; then
  echo ""
  printf '  Add %s to your PATH in %s? [Y/n] ' "$INSTALL_DIR" "$(basename "$(profile_file)")"
  read -r reply
  case "$reply" in [nN]*) say "$(c 90 '· skipped')" ;; *) write_path ;; esac
else
  # Piped from curl: there is no one to ask, so say what to do rather than
  # editing a profile behind a user's back.
  echo ""
  say "Add Gear to your PATH:"
  say "  $(c 36 "export PATH=\"$INSTALL_DIR:\$PATH\"")   $(c 90 '# add to your shell profile')"
  say "$(c 90 "  or re-run with --path to have the installer append it for you")"
fi

echo ""
say "Then run: $(c 1 gear)"
say "$(c 90 'Free to start: grab a Google AI Studio key and `export GOOGLE_API_KEY=...`')"
say "$(c 90 'Later: `gear upgrade --check` tells you when a newer release exists.')"
echo ""
