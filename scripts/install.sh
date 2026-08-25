#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Gear — Install Script
#  Builds a standalone compiled CLI and its native Rust tools,
#  then installs both into ~/.gear/bin/ and exposes them as `gear`.
#  An old ~/.alan data dir is moved to ~/.gear once (symlink left behind); the
#  pre-rename launchers (alan/berne/elio) are removed from ~/.gear/bin.
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
GEAR_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"

# ─── Colors ───
red()    { printf '\033[38;5;166m%s\033[0m' "$*"; }
green()  { printf '\033[38;5;65m%s\033[0m' "$*"; }
yellow() { printf '\033[38;5;179m%s\033[0m' "$*"; }
cyan()   { printf '\033[38;5;24m%s\033[0m' "$*"; }
dim()    { printf '\033[38;5;245m%s\033[0m' "$*"; }
bold()   { printf '\033[1m%s\033[0m' "$*"; }

echo ""
echo "  $(bold '  Gear Installer')  $(dim 'v0.3.0')"
echo "  $(dim '──────────────────────────────────────')"
echo "  $(dim "Repo root: $GEAR_ROOT")"
echo ""

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

INSTALL_DIR="$HOME/.gear/bin"
mkdir -p "$INSTALL_DIR"

# ─── 1. Find / verify Bun ───
if [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
elif command -v bun &>/dev/null; then
  BUN="$(command -v bun)"
else
  echo "  $(red '✗') Bun not found. Install it first: https://bun.sh"
  echo "     or run: $(bold 'gear setup')"
  exit 1
fi
echo "  $(green '✓') Bun: $(dim "$BUN")"

# ─── 2. Find / verify Cargo ───
if command -v cargo &>/dev/null; then
  CARGO="$(command -v cargo)"
else
  echo "  $(red '✗') Rust/cargo not found. Install it first: https://rustup.rs"
  echo "     or run: $(bold 'gear setup')"
  exit 1
fi
echo "  $(green '✓') Cargo: $(dim "$CARGO")"

# ─── 3. Build standalone TypeScript CLI ───
CLI_ENTRY="$GEAR_ROOT/packages/orchestrator/src/bin/gear-cli.ts"
CLI_OUT="$INSTALL_DIR/gear-compiled"

echo ""
echo "  $(dim '...') Compiling TypeScript CLI (bun build --compile)"
echo "  $(dim "    $BUN build --compile $CLI_ENTRY --outfile $CLI_OUT")"

# Install bun dependencies first so the build can resolve imports
(cd "$GEAR_ROOT" && "$BUN" install --frozen-lockfile 2>&1 | tail -2)

# Compile to a self-contained executable.
# The compiled binary reads GEAR_TOOLS_BIN from the environment at runtime
# (set by the wrapper script written in step 5).
(cd "$GEAR_ROOT" && "$BUN" build --compile "$CLI_ENTRY" --outfile "$CLI_OUT")
chmod +x "$CLI_OUT"
echo "  $(green '✓') Compiled CLI installed: $(dim "$CLI_OUT")"

# Record where this binary came from, so the launcher can detect the classic
# trap: a fix lands in the TypeScript but the installed binary predates it,
# and "nothing changed" until someone remembers to rebuild.
cat > "$INSTALL_DIR/gear-compiled.meta" <<META
GEAR_SOURCE_ROOT=$GEAR_ROOT
GEAR_BUILT_AT=$(date +%s)
META

# ─── 4. Build Rust gear-tools binary ───
echo ""
echo "  $(dim '...') Building Rust tools binary (cargo build --release)"
(cd "$GEAR_ROOT" && "$CARGO" build --release -p gear-tools 2>&1 | tail -3)

TOOLS_SRC="$GEAR_ROOT/target/release/gear-tools"
TOOLS_DST="$INSTALL_DIR/gear-tools"
cp "$TOOLS_SRC" "$TOOLS_DST"
chmod +x "$TOOLS_DST"
echo "  $(green '✓') gear-tools installed: $(dim "$TOOLS_DST")"

# ─── 5. Write a thin `gear` launcher that sets GEAR_TOOLS_BIN ───
# The compiled binary needs to know where gear-tools lives; the wrapper sets the
# env var, loads saved API keys, and execs the compiled CLI.
cat > "$INSTALL_DIR/gear" <<'WRAPPER'
#!/usr/bin/env bash
# Gear launcher: points the compiled CLI at gear-tools and loads saved keys.

# Stale working-directory self-heal: if this shell's cwd was deleted, moved
# (e.g. to Trash), or replaced while the tab sat in it, getcwd() fails and the
# Bun runtime dies at startup with a cryptic "Unexpected" / "low max file
# descriptors" error before Gear ever runs. Re-resolve $PWD by its path: if
# the folder exists (again), re-enter it fresh; if it is really gone, say
# exactly what happened and how to fix it.
if ! pwd -P >/dev/null 2>&1; then
  if [ -n "${PWD:-}" ] && [ -d "$PWD" ] && cd "$PWD" 2>/dev/null; then
    echo "  ! This terminal's working directory was stale (deleted or replaced) — re-entered $PWD" >&2
  else
    echo "" >&2
    echo "  ✗ Gear can't start: this terminal's working directory no longer exists." >&2
    echo "    It was deleted, moved to Trash, or replaced while this shell was inside it." >&2
    echo "    Fix: cd to an existing folder and retry — e.g.  cd ~  then cd back to your project." >&2
    echo "" >&2
    exit 1
  fi
fi

GEAR_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export GEAR_TOOLS_BIN="$GEAR_BIN_DIR/gear-tools"

# Build freshness: warn when this compiled binary is older than the source
# tree it was built from. `find -newer … -print -quit` stops at the FIRST
# newer file, so the check costs milliseconds.
META_FILE="$GEAR_BIN_DIR/gear-compiled.meta"
if [ -f "$META_FILE" ]; then
  # shellcheck disable=SC1090
  source "$META_FILE"
  if [ -n "${GEAR_SOURCE_ROOT:-}" ] && [ -d "$GEAR_SOURCE_ROOT/packages" ]; then
    NEWER="$(find "$GEAR_SOURCE_ROOT/packages" -name '*.ts' \
      -not -path '*/node_modules/*' -not -path '*/dist/*' \
      -newer "$GEAR_BIN_DIR/gear-compiled" -print -quit 2>/dev/null)"
    if [ -n "$NEWER" ]; then
      echo "  ! This gear build is older than its source tree — changes there are NOT live." >&2
      echo "    Rebuild:  cd $GEAR_SOURCE_ROOT && ./scripts/install.sh" >&2
    fi
  fi
fi

# Load API keys if present
GEAR_ENV="$HOME/.gear/.env"
if [ -f "$GEAR_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$GEAR_ENV"
  set +a
fi

exec "$GEAR_BIN_DIR/gear-compiled" "$@"
WRAPPER
chmod +x "$INSTALL_DIR/gear"
echo "  $(green '✓') Launcher written: $(dim "$INSTALL_DIR/gear")"

# Prune the pre-rename launchers (they pointed at the same binary).
for old in elio berne alan; do
  [ -L "$INSTALL_DIR/$old" ] && rm -f "$INSTALL_DIR/$old"
done

# ─── 6. Done — PATH instructions ───
echo ""
echo "  $(green '✓') $(bold 'Installation complete!')"
echo ""
# Skip the PATH lecture when ~/.gear/bin is already on PATH (re-installs).
case ":$PATH:" in
  *":$HOME/.gear/bin:"*)
    echo "  $(green '✓') ~/.gear/bin is already on your PATH — just type: $(bold 'gear')"
    echo "  $(dim '  (running terminals keep the old binary; start a fresh tab or rerun gear)')"
    echo ""
    ;;
  *)
    echo "  $(bold 'Add ~/.gear/bin to your PATH:')"
    echo ""
    echo "  $(yellow '  # bash — add to ~/.bashrc or ~/.bash_profile')"
    echo "  $(cyan '  export PATH="$HOME/.gear/bin:$PATH"')"
    echo ""
    echo "  $(yellow '  # zsh  — add to ~/.zshrc')"
    echo "  $(cyan '  export PATH="$HOME/.gear/bin:$PATH"')"
    echo ""
    echo "  $(dim '  Then reload your shell: source ~/.zshrc (or open a new terminal)')"
    echo ""
    echo "  $(dim '  After that, simply type:') $(bold 'gear')"
    echo ""
    ;;
esac
