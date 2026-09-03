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
# One version source, shared with build-release.sh and release.yml.
# shellcheck source=scripts/version.sh
. "$GEAR_ROOT/scripts/version.sh"
BUILD_VERSION="$(gear_version)"

echo "  $(bold '  Gear Installer')  $(dim "v$BUILD_VERSION")"
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

# ─── Install provenance guard ───
# Multiple Gear worktrees share one ~/.gear/bin. A later install from an older
# or divergent worktree used to silently replace a fixed binary (the exact
# regression that put the pre-context-economics build back on PATH). A clean
# fast-forward is safe; dirty cross-worktree and non-fast-forward installs need
# an explicit override.
meta_value() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -1
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
# `chflags nouchg ~/.gear/bin/{gear,gear-compiled,gear-tools,gear-compiled.meta}`.
if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v chflags >/dev/null 2>&1; then
  INSTALL_FILE_GUARD=macos-uchg
else
  INSTALL_FILE_GUARD=none
fi

if command -v git >/dev/null 2>&1 && git -C "$GEAR_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  CANDIDATE_COMMIT="$(git -C "$GEAR_ROOT" rev-parse HEAD)"
  CANDIDATE_BRANCH="$(git -C "$GEAR_ROOT" branch --show-current)"
  if [ -n "$(git -C "$GEAR_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
    CANDIDATE_DIRTY=1
  else
    CANDIDATE_DIRTY=0
  fi
else
  CANDIDATE_COMMIT=unknown
  CANDIDATE_BRANCH=unknown
  CANDIDATE_DIRTY=1
fi

INSTALLED_META="$INSTALL_DIR/gear-compiled.meta"
if [ -f "$INSTALLED_META" ] && [ "${GEAR_ALLOW_NON_FF_INSTALL:-0}" != "1" ]; then
  INSTALLED_ROOT="$(meta_value GEAR_SOURCE_ROOT "$INSTALLED_META")"
  INSTALLED_COMMIT="$(meta_value GEAR_SOURCE_COMMIT "$INSTALLED_META")"
  INSTALLED_DIRTY="$(meta_value GEAR_SOURCE_DIRTY "$INSTALLED_META")"

  if [ -n "$INSTALLED_ROOT" ] && [ "$INSTALLED_ROOT" != "$GEAR_ROOT" ] && \
     { [ "$INSTALLED_DIRTY" = "1" ] || [ "$CANDIDATE_DIRTY" = "1" ]; }; then
    echo ""
    echo "  $(red '✗') Refusing to replace a dirty build from another worktree."
    echo "    installed: $(dim "$INSTALLED_ROOT")"
    echo "    candidate: $(dim "$GEAR_ROOT")"
    echo "    Commit or reconcile the worktrees first. If this replacement is intentional:"
    echo "    $(bold 'GEAR_ALLOW_NON_FF_INSTALL=1 ./scripts/install.sh')"
    exit 1
  fi

  if [ -n "$INSTALLED_COMMIT" ] && [ "$INSTALLED_COMMIT" != "unknown" ] && \
     [ "$CANDIDATE_COMMIT" != "unknown" ] && \
     git -C "$GEAR_ROOT" cat-file -e "$INSTALLED_COMMIT^{commit}" 2>/dev/null && \
     ! git -C "$GEAR_ROOT" merge-base --is-ancestor "$INSTALLED_COMMIT" "$CANDIDATE_COMMIT"; then
    echo ""
    echo "  $(red '✗') Refusing a non-fast-forward Gear install."
    echo "    installed commit: $(dim "$INSTALLED_COMMIT")"
    echo "    candidate commit: $(dim "$CANDIDATE_COMMIT")"
    echo "    The candidate does not contain the currently installed build's commit."
    echo "    Merge/cherry-pick the missing work, or explicitly override with:"
    echo "    $(bold 'GEAR_ALLOW_NON_FF_INSTALL=1 ./scripts/install.sh')"
    exit 1
  fi
fi

# Build everything off to the side and promote only after BOTH the TypeScript
# CLI and Rust executor succeed. A failed cargo build must not leave a half-new
# installation on PATH.
STAGE_DIR="$(mktemp -d "$INSTALL_DIR/.gear-install.XXXXXX")"
cleanup_stage() { rm -rf -- "$STAGE_DIR"; }
trap cleanup_stage EXIT

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
CLI_OUT="$STAGE_DIR/gear-compiled"

echo ""
echo "  $(dim '...') Compiling TypeScript CLI (bun build --compile)"
echo "  $(dim "    $BUN build --compile --define GEAR_BUILD_VERSION=$BUILD_VERSION $CLI_ENTRY")"

# Install bun dependencies first so the build can resolve imports
(cd "$GEAR_ROOT" && "$BUN" install --frozen-lockfile 2>&1 | tail -2)

# ─── 3a. The web client, BEFORE the compile ───
# The product is a browser page, and the binary has to carry it: there is no
# `apps/web/dist` beside an installed executable, so a binary compiled without
# this step starts, serves nothing, and answers `401 unauthorized` to the first
# page request (P10.9a). It is a hard failure, not a warning.
echo ""
echo "  $(dim '...') Building the web client (apps/web)"
(cd "$GEAR_ROOT" && "$BUN" run --filter @gear/web build 2>&1 | tail -3)
if [ ! -f "$GEAR_ROOT/apps/web/dist/index.html" ]; then
  echo "  $(red '✗') apps/web/dist/index.html is missing after the build."
  echo "    A binary without the client cannot serve the product; refusing to compile one."
  exit 1
fi
# One `import … with { type: "file" }` per asset, which is what tells
# `bun build --compile` to copy the bytes into the executable.
(cd "$GEAR_ROOT" && "$BUN" scripts/gen-web-embed.ts)
echo "  $(green '✓') Web client built and staged for embedding"

# Compile to a self-contained executable.
# The compiled binary reads GEAR_TOOLS_BIN from the environment at runtime
# (set by the wrapper script written in step 5).
(cd "$GEAR_ROOT" && "$BUN" build --compile \
  --define=GEAR_BUILD_VERSION="\"$BUILD_VERSION\"" "$CLI_ENTRY" --outfile "$CLI_OUT")
chmod +x "$CLI_OUT"
echo "  $(green '✓') Compiled CLI staged"

# Record where this binary came from, so the launcher can detect the classic
# trap: a fix lands in the TypeScript but the installed binary predates it,
# and "nothing changed" until someone remembers to rebuild.
cat > "$STAGE_DIR/gear-compiled.meta" <<META
GEAR_SOURCE_ROOT=$GEAR_ROOT
GEAR_BUILT_AT=$(date +%s)
GEAR_SOURCE_COMMIT=$CANDIDATE_COMMIT
GEAR_SOURCE_BRANCH=$CANDIDATE_BRANCH
GEAR_SOURCE_DIRTY=$CANDIDATE_DIRTY
GEAR_INSTALL_FILE_GUARD=$INSTALL_FILE_GUARD
GEAR_BUILD_VERSION=$BUILD_VERSION
META

# ─── 4. Build Rust gear-tools binary ───
echo ""
echo "  $(dim '...') Building Rust tools binary (cargo build --release)"
(cd "$GEAR_ROOT" && "$CARGO" build --release -p gear-tools 2>&1 | tail -3)

TOOLS_SRC="$GEAR_ROOT/target/release/gear-tools"
TOOLS_DST="$STAGE_DIR/gear-tools"
cp "$TOOLS_SRC" "$TOOLS_DST"
chmod +x "$TOOLS_DST"
echo "  $(green '✓') gear-tools staged"

# Bind the provenance record to the exact staged bytes. Verification can now
# distinguish "built from this worktree" from "this is the same artifact the
# installer promoted" without relying on mtimes or filenames.
CLI_SHA256="$(sha256_file "$CLI_OUT")"
TOOLS_SHA256="$(sha256_file "$TOOLS_DST")"
cat >> "$STAGE_DIR/gear-compiled.meta" <<META
GEAR_CLI_SHA256=$CLI_SHA256
GEAR_TOOLS_SHA256=$TOOLS_SHA256
META

# ─── 4a. Prove the STAGED pair before promoting it ───
# The defect this closes was found by installing and then opening the product,
# because every gate before it ran Gear from source with `bun` — where the web
# bundle is a directory on disk and `engine-host.ts` is a file that exists.
# `gear serve --check` runs the whole product path against the artifact: the
# page with its token, one session over the websocket, and no host left behind.
# Build → verify → promote, so a binary that cannot serve never lands on PATH.
if [ "${GEAR_SKIP_SERVE_CHECK:-0}" != "1" ]; then
  echo ""
  echo "  $(dim '...') Proving the staged binary serves the product (gear serve --check)"
  if GEAR_TOOLS_BIN="$TOOLS_DST" "$CLI_OUT" serve --check; then
    echo "  $(green '✓') The staged binary serves the product"
  else
    echo "  $(red '✗') The staged binary cannot serve the product — refusing to install it."
    echo "    Re-run with $(bold 'GEAR_SKIP_SERVE_CHECK=1 ./scripts/install.sh') to install anyway."
    exit 1
  fi
fi

# ─── 5. Write a thin `gear` launcher that sets GEAR_TOOLS_BIN ───
# The compiled binary needs to know where gear-tools lives; the wrapper sets the
# env var, loads saved API keys, and execs the compiled CLI.
LAUNCHER_OUT="$STAGE_DIR/gear"
cat > "$LAUNCHER_OUT" <<'WRAPPER'
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
    CURRENT_COMMIT="$(git -C "$GEAR_SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
    if [ -n "${GEAR_SOURCE_COMMIT:-}" ] && [ -n "$CURRENT_COMMIT" ] && \
       [ "$CURRENT_COMMIT" != "$GEAR_SOURCE_COMMIT" ]; then
      echo "  ! This gear build came from commit ${GEAR_SOURCE_COMMIT:0:8}, but its source worktree is now ${CURRENT_COMMIT:0:8}." >&2
      echo "    Rebuild:  cd $GEAR_SOURCE_ROOT && ./scripts/install.sh" >&2
    fi
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
chmod +x "$LAUNCHER_OUT"

# ─── Atomic promotion + recoverable backup ───
# Existing artifacts from a guarded install are immutable. This point is
# intentionally late: provenance passed and every replacement byte is staged.
if [ "$INSTALL_FILE_GUARD" = "macos-uchg" ]; then
  for name in gear gear-compiled gear-tools gear-compiled.meta; do
    [ ! -e "$INSTALL_DIR/$name" ] || chflags nouchg "$INSTALL_DIR/$name"
  done
fi

BACKUP_STAMP="$(date +%s)"
for name in gear gear-compiled gear-tools gear-compiled.meta; do
  if [ -e "$INSTALL_DIR/$name" ]; then
    cp -p "$INSTALL_DIR/$name" "$INSTALL_DIR/$name.backup-$BACKUP_STAMP"
  fi
done
mv "$CLI_OUT" "$INSTALL_DIR/gear-compiled"
mv "$TOOLS_DST" "$INSTALL_DIR/gear-tools"
mv "$STAGE_DIR/gear-compiled.meta" "$INSTALL_DIR/gear-compiled.meta"
mv "$LAUNCHER_OUT" "$INSTALL_DIR/gear"

if [ "$INSTALL_FILE_GUARD" = "macos-uchg" ]; then
  chflags uchg \
    "$INSTALL_DIR/gear" \
    "$INSTALL_DIR/gear-compiled" \
    "$INSTALL_DIR/gear-tools" \
    "$INSTALL_DIR/gear-compiled.meta"
fi
trap - EXIT
cleanup_stage
echo "  $(green '✓') Installed atomically: $(dim "$INSTALL_DIR/gear-compiled")"
echo "  $(green '✓') CLI checksum: $(dim "$CLI_SHA256")"
if [ "$INSTALL_FILE_GUARD" = "macos-uchg" ]; then
  echo "  $(green '✓') Legacy-installer guard: $(dim 'macOS user-immutable artifacts')"
fi

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
    # Print the literal shell snippet for the user.
    # shellcheck disable=SC2016
    echo "  $(cyan '  export PATH="$HOME/.gear/bin:$PATH"')"
    echo ""
    echo "  $(yellow '  # zsh  — add to ~/.zshrc')"
    # Print the literal shell snippet for the user.
    # shellcheck disable=SC2016
    echo "  $(cyan '  export PATH="$HOME/.gear/bin:$PATH"')"
    echo ""
    echo "  $(dim '  Then reload your shell: source ~/.zshrc (or open a new terminal)')"
    echo ""
    echo "  $(dim '  After that, simply type:') $(bold 'gear')"
    echo ""
    ;;
esac
