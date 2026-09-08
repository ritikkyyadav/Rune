#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Rune — Install Script
#  Builds a standalone compiled CLI and its native Rust tools,
#  then installs both into ~/.rune/bin/ and exposes them as `rune`.
#  An old ~/.gear (or ~/.alan) data dir is moved to ~/.rune once (symlink left
#  behind); the pre-rename launchers and binaries (gear, alan, berne, elio) are
#  removed from ~/.rune/bin.
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
RUNE_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"

# ─── Colors ───
red()    { printf '\033[38;5;166m%s\033[0m' "$*"; }
green()  { printf '\033[38;5;65m%s\033[0m' "$*"; }
yellow() { printf '\033[38;5;179m%s\033[0m' "$*"; }
cyan()   { printf '\033[38;5;24m%s\033[0m' "$*"; }
dim()    { printf '\033[38;5;245m%s\033[0m' "$*"; }
bold()   { printf '\033[1m%s\033[0m' "$*"; }

echo ""
# One version source, shared with build-release.sh and release.yml.
# shellcheck source=scripts/version.sh
. "$RUNE_ROOT/scripts/version.sh"
BUILD_VERSION="$(rune_version)"

echo "  $(bold '  Rune Installer')  $(dim "v$BUILD_VERSION")"
echo "  $(dim '──────────────────────────────────────')"
echo "  $(dim "Repo root: $RUNE_ROOT")"
echo ""

# ─── Rename migration: ~/.gear (or an older ~/.alan) → ~/.rune (once; a symlink keeps old paths alive) ───
# A ~/.rune that exists but holds no data (no database, secrets or config —
# created by a test run, a --version, or a bare mkdir) must not block the move:
# it is set aside, the old home moves in, and its entries are folded back where
# nothing of the same name came across.
home_has_data() {
  local f
  for f in rune.db gear.db alan.db secrets.json config.toml model.json credentials.index.json; do
    [ ! -e "$1/$f" ] || return 0
  done
  return 1
}
migrate_home() {
  local old parked=""
  if [ -e "$HOME/.rune" ]; then
    { [ -d "$HOME/.rune" ] && [ ! -L "$HOME/.rune" ] && ! home_has_data "$HOME/.rune"; } || return 0
  fi
  for old in .gear .alan; do
    if [ -d "$HOME/$old" ] && [ ! -L "$HOME/$old" ]; then
      if [ -e "$HOME/.rune" ]; then
        parked="$HOME/.rune.fresh-$(date +%s)"
        mv "$HOME/.rune" "$parked" 2>/dev/null || return 0
      fi
      if mv "$HOME/$old" "$HOME/.rune" 2>/dev/null; then
        ln -s "$HOME/.rune" "$HOME/$old" 2>/dev/null || true
        echo "  · moved ~/$old → ~/.rune (a symlink ~/$old → ~/.rune keeps old paths working)" >&2
        if [ -n "$parked" ]; then
          local entry
          for entry in "$parked"/* "$parked"/.[!.]*; do
            [ -e "$entry" ] || continue
            [ -e "$HOME/.rune/$(basename "$entry")" ] || mv "$entry" "$HOME/.rune/" 2>/dev/null || true
          done
          rmdir "$parked" 2>/dev/null || echo "  · kept $parked (entries that collided with the moved home)" >&2
        fi
      elif [ -n "$parked" ]; then
        mv "$parked" "$HOME/.rune" 2>/dev/null || true
      fi
      return 0
    fi
  done
}
migrate_home

INSTALL_DIR="$HOME/.rune/bin"
mkdir -p "$INSTALL_DIR"

# ─── Install provenance guard ───
# Multiple Rune worktrees share one ~/.rune/bin. A later install from an older
# or divergent worktree used to silently replace a fixed binary (the exact
# regression that put the pre-context-economics build back on PATH). A clean
# fast-forward is safe; dirty cross-worktree and non-fast-forward installs need
# an explicit override.
meta_value() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -1
}

# macOS paths can differ only by case or symlinks and still name this checkout.
# Filesystem identity avoids falsely rejecting a same-checkout update while
# retaining the dirty cross-worktree and commit-ancestry guards below.
same_checkout() {
  [ "$1" = "$2" ] || { [ -d "$1" ] && [ -d "$2" ] && [ "$1" -ef "$2" ]; }
}

sha256_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    printf 'unavailable\n'
  fi
}

# Backward-compatible downgrade protection. A historical installer does not
# know the provenance rule above, but macOS's user-immutable flag still stops
# it from truncating or unlinking the live artifacts. This installer clears the
# flag only after its provenance check and both staged builds have succeeded,
# then restores it after promotion. Users can always reverse it with
# `chflags nouchg ~/.rune/bin/{rune,rune-compiled,rune-tools,rune-compiled.meta}`.
if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v chflags >/dev/null 2>&1; then
  INSTALL_FILE_GUARD=macos-uchg
else
  INSTALL_FILE_GUARD=none
fi

if command -v git >/dev/null 2>&1 && git -C "$RUNE_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  CANDIDATE_COMMIT="$(git -C "$RUNE_ROOT" rev-parse HEAD)"
  CANDIDATE_BRANCH="$(git -C "$RUNE_ROOT" branch --show-current)"
  if [ -n "$(git -C "$RUNE_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
    CANDIDATE_DIRTY=1
  else
    CANDIDATE_DIRTY=0
  fi
else
  CANDIDATE_COMMIT=unknown
  CANDIDATE_BRANCH=unknown
  CANDIDATE_DIRTY=1
fi

INSTALLED_META="$INSTALL_DIR/rune-compiled.meta"
if [ -f "$INSTALLED_META" ] && [ "${RUNE_ALLOW_NON_FF_INSTALL:-0}" != "1" ]; then
  INSTALLED_ROOT="$(meta_value RUNE_SOURCE_ROOT "$INSTALLED_META")"
  INSTALLED_COMMIT="$(meta_value RUNE_SOURCE_COMMIT "$INSTALLED_META")"
  INSTALLED_DIRTY="$(meta_value RUNE_SOURCE_DIRTY "$INSTALLED_META")"

  if [ -n "$INSTALLED_ROOT" ] && ! same_checkout "$INSTALLED_ROOT" "$RUNE_ROOT" && \
     { [ "$INSTALLED_DIRTY" = "1" ] || [ "$CANDIDATE_DIRTY" = "1" ]; }; then
    echo ""
    echo "  $(red '✗') Refusing to replace a dirty build from another worktree."
    echo "    installed: $(dim "$INSTALLED_ROOT")"
    echo "    candidate: $(dim "$RUNE_ROOT")"
    echo "    Commit or reconcile the worktrees first. If this replacement is intentional:"
    echo "    $(bold 'RUNE_ALLOW_NON_FF_INSTALL=1 ./scripts/install.sh')"
    exit 1
  fi

  if [ -n "$INSTALLED_COMMIT" ] && [ "$INSTALLED_COMMIT" != "unknown" ] && \
     [ "$CANDIDATE_COMMIT" != "unknown" ] && \
     git -C "$RUNE_ROOT" cat-file -e "$INSTALLED_COMMIT^{commit}" 2>/dev/null && \
     ! git -C "$RUNE_ROOT" merge-base --is-ancestor "$INSTALLED_COMMIT" "$CANDIDATE_COMMIT"; then
    echo ""
    echo "  $(red '✗') Refusing a non-fast-forward Rune install."
    echo "    installed commit: $(dim "$INSTALLED_COMMIT")"
    echo "    candidate commit: $(dim "$CANDIDATE_COMMIT")"
    echo "    The candidate does not contain the currently installed build's commit."
    echo "    Merge/cherry-pick the missing work, or explicitly override with:"
    echo "    $(bold 'RUNE_ALLOW_NON_FF_INSTALL=1 ./scripts/install.sh')"
    exit 1
  fi
fi

# Build everything off to the side and promote only after BOTH the TypeScript
# CLI and Rust executor succeed. A failed cargo build must not leave a half-new
# installation on PATH.
STAGE_DIR="$(mktemp -d "$INSTALL_DIR/.rune-install.XXXXXX")"
cleanup_stage() { rm -rf -- "$STAGE_DIR"; }
trap cleanup_stage EXIT

# ─── 1. Find / verify Bun ───
if [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
elif command -v bun &>/dev/null; then
  BUN="$(command -v bun)"
else
  echo "  $(red '✗') Bun not found. Install it first: https://bun.sh"
  echo "     or run: $(bold 'rune setup')"
  exit 1
fi
echo "  $(green '✓') Bun: $(dim "$BUN")"

# ─── 2. Find / verify Cargo ───
if command -v cargo &>/dev/null; then
  CARGO="$(command -v cargo)"
else
  echo "  $(red '✗') Rust/cargo not found. Install it first: https://rustup.rs"
  echo "     or run: $(bold 'rune setup')"
  exit 1
fi
echo "  $(green '✓') Cargo: $(dim "$CARGO")"

# ─── 3. Build standalone TypeScript CLI ───
CLI_ENTRY="$RUNE_ROOT/packages/orchestrator/src/bin/rune-cli.ts"
CLI_OUT="$STAGE_DIR/rune-compiled"

echo ""
echo "  $(dim '...') Compiling TypeScript CLI (bun build --compile)"
echo "  $(dim "    $BUN build --compile --define RUNE_BUILD_VERSION=$BUILD_VERSION $CLI_ENTRY")"

# Install bun dependencies first so the build can resolve imports
(cd "$RUNE_ROOT" && "$BUN" install --frozen-lockfile 2>&1 | tail -2)

# Compile to a self-contained executable.
# The compiled binary reads RUNE_TOOLS_BIN from the environment at runtime
# (set by the wrapper script written in step 5).
(cd "$RUNE_ROOT" && "$BUN" build --compile \
  --define=RUNE_BUILD_VERSION="\"$BUILD_VERSION\"" "$CLI_ENTRY" --outfile "$CLI_OUT")
chmod +x "$CLI_OUT"
echo "  $(green '✓') Compiled CLI staged"

# Record where this binary came from, so the launcher can detect the classic
# trap: a fix lands in the TypeScript but the installed binary predates it,
# and "nothing changed" until someone remembers to rebuild.
cat > "$STAGE_DIR/rune-compiled.meta" <<META
RUNE_SOURCE_ROOT=$RUNE_ROOT
RUNE_BUILT_AT=$(date +%s)
RUNE_SOURCE_COMMIT=$CANDIDATE_COMMIT
RUNE_SOURCE_BRANCH=$CANDIDATE_BRANCH
RUNE_SOURCE_DIRTY=$CANDIDATE_DIRTY
RUNE_INSTALL_FILE_GUARD=$INSTALL_FILE_GUARD
RUNE_BUILD_VERSION=$BUILD_VERSION
META

# ─── 4. Build Rust rune-tools binary ───
echo ""
echo "  $(dim '...') Building Rust tools binary (cargo build --release)"
(cd "$RUNE_ROOT" && "$CARGO" build --release -p rune-tools 2>&1 | tail -3)

TOOLS_SRC="$RUNE_ROOT/target/release/rune-tools"
TOOLS_DST="$STAGE_DIR/rune-tools"
cp "$TOOLS_SRC" "$TOOLS_DST"
chmod +x "$TOOLS_DST"
echo "  $(green '✓') rune-tools staged"

# Bind the provenance record to the exact staged bytes. Verification can now
# distinguish "built from this worktree" from "this is the same artifact the
# installer promoted" without relying on mtimes or filenames.
CLI_SHA256="$(sha256_file "$CLI_OUT")"
TOOLS_SHA256="$(sha256_file "$TOOLS_DST")"
cat >> "$STAGE_DIR/rune-compiled.meta" <<META
RUNE_CLI_SHA256=$CLI_SHA256
RUNE_TOOLS_SHA256=$TOOLS_SHA256
META

# ─── 4a. Prove the STAGED pair before promoting it ───
# The defect this closes was found by installing and then using the binary,
# because every gate before it ran Rune from source with `bun` — where
# `engine-host.ts` is a file that exists. `rune serve --check` runs the served
# path against the artifact: one session over the websocket, one completed
# turn, and no host left behind. Build → verify → promote, so a binary that
# cannot host a session never lands on PATH.
if [ "${RUNE_SKIP_SERVE_CHECK:-0}" != "1" ]; then
  echo ""
  echo "  $(dim '...') Proving the staged binary hosts a session (rune serve --check)"
  if RUNE_TOOLS_BIN="$TOOLS_DST" "$CLI_OUT" serve --check; then
    echo "  $(green '✓') The staged binary hosts a session"
  else
    echo "  $(red '✗') The staged binary cannot host a session — refusing to install it."
    echo "    Re-run with $(bold 'RUNE_SKIP_SERVE_CHECK=1 ./scripts/install.sh') to install anyway."
    exit 1
  fi
fi

# ─── 5. Write a thin `rune` launcher that sets RUNE_TOOLS_BIN ───
# The compiled binary needs to know where rune-tools lives; the wrapper sets the
# env var, loads saved API keys, and execs the compiled CLI.
LAUNCHER_OUT="$STAGE_DIR/rune"
cat > "$LAUNCHER_OUT" <<'WRAPPER'
#!/usr/bin/env bash
# Rune launcher: points the compiled CLI at rune-tools and loads saved keys.

# Stale working-directory self-heal: if this shell's cwd was deleted, moved
# (e.g. to Trash), or replaced while the tab sat in it, getcwd() fails and the
# Bun runtime dies at startup with a cryptic "Unexpected" / "low max file
# descriptors" error before Rune ever runs. Re-resolve $PWD by its path: if
# the folder exists (again), re-enter it fresh; if it is really gone, say
# exactly what happened and how to fix it.
if ! pwd -P >/dev/null 2>&1; then
  if [ -n "${PWD:-}" ] && [ -d "$PWD" ] && cd "$PWD" 2>/dev/null; then
    echo "  ! This terminal's working directory was stale (deleted or replaced) — re-entered $PWD" >&2
  else
    echo "" >&2
    echo "  ✗ Rune can't start: this terminal's working directory no longer exists." >&2
    echo "    It was deleted, moved to Trash, or replaced while this shell was inside it." >&2
    echo "    Fix: cd to an existing folder and retry — e.g.  cd ~  then cd back to your project." >&2
    echo "" >&2
    exit 1
  fi
fi

RUNE_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RUNE_TOOLS_BIN="$RUNE_BIN_DIR/rune-tools"

# Build freshness: warn when this compiled binary is older than the source
# tree it was built from. `find -newer … -print -quit` stops at the FIRST
# newer file, so the check costs milliseconds.
META_FILE="$RUNE_BIN_DIR/rune-compiled.meta"
if [ -f "$META_FILE" ]; then
  # shellcheck disable=SC1090
  source "$META_FILE"
  if [ -n "${RUNE_SOURCE_ROOT:-}" ] && [ -d "$RUNE_SOURCE_ROOT/packages" ]; then
    CURRENT_COMMIT="$(git -C "$RUNE_SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
    if [ -n "${RUNE_SOURCE_COMMIT:-}" ] && [ -n "$CURRENT_COMMIT" ] && \
       [ "$CURRENT_COMMIT" != "$RUNE_SOURCE_COMMIT" ]; then
      echo "  ! This rune build came from commit ${RUNE_SOURCE_COMMIT:0:8}, but its source worktree is now ${CURRENT_COMMIT:0:8}." >&2
      echo "    Rebuild:  cd $RUNE_SOURCE_ROOT && ./scripts/install.sh" >&2
    fi
    NEWER="$(find "$RUNE_SOURCE_ROOT/packages" -name '*.ts' \
      -not -path '*/node_modules/*' -not -path '*/dist/*' \
      -newer "$RUNE_BIN_DIR/rune-compiled" -print -quit 2>/dev/null)"
    if [ -n "$NEWER" ]; then
      echo "  ! This rune build is older than its source tree — changes there are NOT live." >&2
      echo "    Rebuild:  cd $RUNE_SOURCE_ROOT && ./scripts/install.sh" >&2
    fi
  fi
fi

# Load API keys if present
RUNE_ENV="$HOME/.rune/.env"
if [ -f "$RUNE_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$RUNE_ENV"
  set +a
fi

exec "$RUNE_BIN_DIR/rune-compiled" "$@"
WRAPPER
chmod +x "$LAUNCHER_OUT"

# ─── Atomic promotion + recoverable backup ───
# Existing artifacts from a guarded install are immutable. This point is
# intentionally late: provenance passed and every replacement byte is staged.
if [ "$INSTALL_FILE_GUARD" = "macos-uchg" ]; then
  for name in rune rune-compiled rune-tools rune-compiled.meta; do
    [ ! -e "$INSTALL_DIR/$name" ] || chflags nouchg "$INSTALL_DIR/$name"
  done
fi

BACKUP_STAMP="$(date +%s)"
for name in rune rune-compiled rune-tools rune-compiled.meta; do
  if [ -e "$INSTALL_DIR/$name" ]; then
    cp -p "$INSTALL_DIR/$name" "$INSTALL_DIR/$name.backup-$BACKUP_STAMP"
  fi
done
mv "$CLI_OUT" "$INSTALL_DIR/rune-compiled"
mv "$TOOLS_DST" "$INSTALL_DIR/rune-tools"
mv "$STAGE_DIR/rune-compiled.meta" "$INSTALL_DIR/rune-compiled.meta"
mv "$LAUNCHER_OUT" "$INSTALL_DIR/rune"

if [ "$INSTALL_FILE_GUARD" = "macos-uchg" ]; then
  chflags uchg \
    "$INSTALL_DIR/rune" \
    "$INSTALL_DIR/rune-compiled" \
    "$INSTALL_DIR/rune-tools" \
    "$INSTALL_DIR/rune-compiled.meta"
fi
trap - EXIT
cleanup_stage
echo "  $(green '✓') Installed atomically: $(dim "$INSTALL_DIR/rune-compiled")"
echo "  $(green '✓') CLI checksum: $(dim "$CLI_SHA256")"
if [ "$INSTALL_FILE_GUARD" = "macos-uchg" ]; then
  echo "  $(green '✓') Legacy-installer guard: $(dim 'macOS user-immutable artifacts')"
fi

# Prune the pre-rename launchers (they pointed at the same binary) and the
# previous name's installed artifacts, which the promotion above superseded.
for old in elio berne alan gear; do
  [ -L "$INSTALL_DIR/$old" ] && rm -f "$INSTALL_DIR/$old"
done
for old in gear gear-compiled gear-tools gear-compiled.meta; do
  if [ -f "$INSTALL_DIR/$old" ]; then
    [ "$INSTALL_FILE_GUARD" != "macos-uchg" ] || chflags nouchg "$INSTALL_DIR/$old" 2>/dev/null || true
    rm -f "$INSTALL_DIR/$old"
  fi
done

# ─── 6. Done — PATH instructions ───
echo ""
echo "  $(green '✓') $(bold 'Installation complete!')"
echo ""
# Skip the PATH lecture when ~/.rune/bin is already on PATH (re-installs).
case ":$PATH:" in
  *":$HOME/.rune/bin:"*)
    echo "  $(green '✓') ~/.rune/bin is already on your PATH — just type: $(bold 'rune')"
    echo "  $(dim '  (running terminals keep the old binary; start a fresh tab or rerun gear)')"
    echo ""
    ;;
  *)
    echo "  $(bold 'Add ~/.rune/bin to your PATH:')"
    echo ""
    echo "  $(yellow '  # bash — add to ~/.bashrc or ~/.bash_profile')"
    # Print the literal shell snippet for the user.
    # shellcheck disable=SC2016
    echo "  $(cyan '  export PATH="$HOME/.rune/bin:$PATH"')"
    echo ""
    echo "  $(yellow '  # zsh  — add to ~/.zshrc')"
    # Print the literal shell snippet for the user.
    # shellcheck disable=SC2016
    echo "  $(cyan '  export PATH="$HOME/.rune/bin:$PATH"')"
    echo ""
    echo "  $(dim '  Then reload your shell: source ~/.zshrc (or open a new terminal)')"
    echo ""
    echo "  $(dim '  After that, simply type:') $(bold 'rune')"
    echo ""
    ;;
esac
