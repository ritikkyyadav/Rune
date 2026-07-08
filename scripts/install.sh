#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Berne — Install Script
#  Builds a standalone compiled CLI and the alan-tools Rust binary,
#  then installs both into ~/.alan/bin/ and exposes them as `berne`.
#  (Internal codename: Alan — the data dir stays ~/.alan and the Rust
#   tools binary stays alan-tools; only the command you type is `berne`.)
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
echo "  $(bold '  Berne Installer')  $(dim 'v0.1')"
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
  echo "     or run: $(bold 'berne setup')"
  exit 1
fi
echo "  $(green '✓') Bun: $(dim "$BUN")"

# ─── 2. Find / verify Cargo ───
if command -v cargo &>/dev/null; then
  CARGO="$(command -v cargo)"
else
  echo "  $(red '✗') Rust/cargo not found. Install it first: https://rustup.rs"
  echo "     or run: $(bold 'berne setup')"
  exit 1
fi
echo "  $(green '✓') Cargo: $(dim "$CARGO")"

# ─── 3. Build standalone TypeScript CLI ───
CLI_ENTRY="$ALAN_ROOT/packages/orchestrator/src/bin/alan-cli.ts"
CLI_OUT="$INSTALL_DIR/berne-compiled"

echo ""
echo "  $(dim '...') Compiling TypeScript CLI (bun build --compile)"
echo "  $(dim "    $BUN build --compile $CLI_ENTRY --outfile $CLI_OUT")"

# Install bun dependencies first so the build can resolve imports
(cd "$ALAN_ROOT" && "$BUN" install --frozen-lockfile 2>&1 | tail -2)

# Compile to a self-contained executable.
# The compiled binary reads ALAN_TOOLS_BIN from the environment at runtime
# (set by the wrapper script written in step 5).
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

# ─── 5. Write a thin `berne` launcher that sets ALAN_TOOLS_BIN ───
# The compiled binary needs to know where alan-tools lives; the wrapper sets the
# env var, loads saved API keys, and execs the compiled CLI.
cat > "$INSTALL_DIR/berne" <<'WRAPPER'
#!/usr/bin/env bash
# Berne launcher: points the compiled CLI at alan-tools and loads saved keys.

# Stale working-directory self-heal: if this shell's cwd was deleted, moved
# (e.g. to Trash), or replaced while the tab sat in it, getcwd() fails and the
# Bun runtime dies at startup with a cryptic "Unexpected" / "low max file
# descriptors" error before Berne ever runs. Re-resolve $PWD by its path: if
# the folder exists (again), re-enter it fresh; if it is really gone, say
# exactly what happened and how to fix it.
if ! pwd -P >/dev/null 2>&1; then
  if [ -n "${PWD:-}" ] && [ -d "$PWD" ] && cd "$PWD" 2>/dev/null; then
    echo "  ! This terminal's working directory was stale (deleted or replaced) — re-entered $PWD" >&2
  else
    echo "" >&2
    echo "  ✗ Berne can't start: this terminal's working directory no longer exists." >&2
    echo "    It was deleted, moved to Trash, or replaced while this shell was inside it." >&2
    echo "    Fix: cd to an existing folder and retry — e.g.  cd ~  then cd back to your project." >&2
    echo "" >&2
    exit 1
  fi
fi

BERNE_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ALAN_TOOLS_BIN="$BERNE_BIN_DIR/alan-tools"

# Load API keys if present
ALAN_ENV="$HOME/.alan/.env"
if [ -f "$ALAN_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ALAN_ENV"
  set +a
fi

exec "$BERNE_BIN_DIR/berne-compiled" "$@"
WRAPPER
chmod +x "$INSTALL_DIR/berne"
echo "  $(green '✓') Launcher written: $(dim "$INSTALL_DIR/berne")"

# Back-compat: keep an `alan` alias pointing at the same launcher.
ln -sf "$INSTALL_DIR/berne" "$INSTALL_DIR/alan"
echo "  $(green '✓') Alias: $(dim "$INSTALL_DIR/alan → berne")"

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
echo "  $(dim '  After that, simply type:') $(bold 'berne')"
echo ""
