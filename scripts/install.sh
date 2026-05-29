#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Alan — Install Script
#  Builds a standalone compiled CLI and the alan-tools Rust binary,
#  then installs both into ~/.alan/bin/.
#
#  Usage: bash scripts/install.sh
#         (run from the repo root, or from any path — it self-locates)
# ──────────────────────────────────────────────────────────
set -euo pipefail

# ─── Resolve repo root from this script's real location ───
_resolve_script_dir() {
  local src="${BASH_SOURCE[0]}"
  while [ -L "$src" ]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" && pwd
}

SCRIPT_DIR="$(_resolve_script_dir)"
ALAN_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"

# ─── Colors ───
red()    { printf '\033[38;5;166m%s\033[0m' "$*"; }
green()  { printf '\033[38;5;65m%s\033[0m' "$*"; }
yellow() { printf '\033[38;5;179m%s\033[0m' "$*"; }
cyan()   { printf '\033[38;5;24m%s\033[0m' "$*"; }
dim()    { printf '\033[38;5;245m%s\033[0m' "$*"; }
bold()   { printf '\033[1m%s\033[0m' "$*"; }

echo ""
echo "  $(bold '  Alan Installer')"
echo "  $(dim '──────────────────────────────────────')"
echo "  $(dim "Repo root: $ALAN_ROOT")"
echo ""

INSTALL_DIR="$HOME/.alan/bin"
mkdir -p "$INSTALL_DIR"

# ─── 1. Find / verify Bun ───
if [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
elif command -v bun &>/dev/null; then
  BUN="$(command -v bun)"
else
  echo "  $(red '✗') Bun not found. Install it first: https://bun.sh"
  echo "     or run: $(bold 'alan setup')"
  exit 1
fi
echo "  $(green '✓') Bun: $(dim "$BUN")"

# ─── 2. Find / verify Cargo ───
if command -v cargo &>/dev/null; then
  CARGO="$(command -v cargo)"
else
  echo "  $(red '✗') Rust/cargo not found. Install it first: https://rustup.rs"
  echo "     or run: $(bold 'alan setup')"
  exit 1
fi
echo "  $(green '✓') Cargo: $(dim "$CARGO")"

# ─── 3. Build standalone TypeScript CLI ───
CLI_ENTRY="$ALAN_ROOT/packages/orchestrator/src/bin/alan-cli.ts"
CLI_OUT="$INSTALL_DIR/alan"

echo ""
echo "  $(dim '...') Compiling TypeScript CLI (bun build --compile)"
echo "  $(dim "    $BUN build --compile $CLI_ENTRY --outfile $CLI_OUT")"

# Install bun dependencies first so the build can resolve imports
(cd "$ALAN_ROOT" && "$BUN" install --frozen-lockfile 2>&1 | tail -2)

# Compile to a self-contained executable.
# The compiled binary reads ALAN_TOOLS_BIN from the environment at runtime
# (set by the user's shell, or by a wrapper script).
(cd "$ALAN_ROOT" && "$BUN" build --compile "$CLI_ENTRY" --outfile "$CLI_OUT")
chmod +x "$CLI_OUT"
echo "  $(green '✓') Compiled CLI installed: $(dim "$CLI_OUT")"

# ─── 4. Build Rust alan-tools binary ───
echo ""
echo "  $(dim '...') Building Rust tools binary (cargo build --release)"
(cd "$ALAN_ROOT" && "$CARGO" build --release -p alan-tools 2>&1 | tail -3)

TOOLS_SRC="$ALAN_ROOT/target/release/alan-tools"
TOOLS_DST="$INSTALL_DIR/alan-tools"
cp "$TOOLS_SRC" "$TOOLS_DST"
chmod +x "$TOOLS_DST"
echo "  $(green '✓') alan-tools installed: $(dim "$TOOLS_DST")"

# ─── 5. Write a thin launcher that sets ALAN_TOOLS_BIN ───
# The compiled alan binary needs to know where alan-tools lives.
# We create a wrapper script `~/.alan/bin/alan` that sets the env var
# and then execs the compiled binary (renamed to alan-compiled).
mv "$INSTALL_DIR/alan" "$INSTALL_DIR/alan-compiled"

cat > "$INSTALL_DIR/alan" <<'WRAPPER'
#!/usr/bin/env bash
# Thin launcher: sets ALAN_TOOLS_BIN so the compiled CLI can find it.
ALAN_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ALAN_TOOLS_BIN="$ALAN_BIN_DIR/alan-tools"

# Load API keys if present
ALAN_ENV="$HOME/.alan/.env"
if [ -f "$ALAN_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ALAN_ENV"
  set +a
fi

exec "$ALAN_BIN_DIR/alan-compiled" "$@"
WRAPPER
chmod +x "$INSTALL_DIR/alan"
echo "  $(green '✓') Wrapper launcher written: $(dim "$INSTALL_DIR/alan")"

# ─── 6. Done — PATH instructions ───
echo ""
echo "  $(green '✓') $(bold 'Installation complete!')"
echo ""
echo "  $(bold 'Add ~/.alan/bin to your PATH:')"
echo ""
echo "  $(yellow '  # bash — add to ~/.bashrc or ~/.bash_profile')"
echo "  $(cyan '  export PATH=\"\$HOME/.alan/bin:\$PATH\"')"
echo ""
echo "  $(yellow '  # zsh  — add to ~/.zshrc')"
echo "  $(cyan '  export PATH=\"\$HOME/.alan/bin:\$PATH\"')"
echo ""
echo "  $(dim '  Then reload your shell: source ~/.zshrc (or open a new terminal)')"
echo ""
echo "  $(dim '  After that, simply type:') $(bold 'alan')"
echo ""
