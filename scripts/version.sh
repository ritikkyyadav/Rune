#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Rune — the one version source
#
#  The version used to live in four hand-maintained places: a literal in
#  brand.ts, six package.json files, a banner string in install.sh, and a
#  comment in web-install.sh. They drifted, and the only tag in the repo
#  (v0.2.0) disagreed with every one of them.
#
#  Now exactly one function answers "what version is this build", and every
#  build path — scripts/build-release.sh, scripts/install.sh, release.yml,
#  ci.yml — calls it and injects the answer with `bun build --define`. A binary
#  cannot disagree with the tag it was built from, because nothing else knows
#  the version.
#
#  Precedence:
#    1. $RUNE_VERSION            an explicit override. CI passes the tag here,
#                                because a shallow checkout may not have tags.
#    2. the exact git tag at HEAD (v1.2.3 → 1.2.3). A release build.
#    3. package.json + -dev+<sha>  everything else is honestly a dev build.
#
#  Usage:
#    source scripts/version.sh; v="$(rune_version)"
#    bash scripts/version.sh              # prints it
# ──────────────────────────────────────────────────────────

# The package whose semver is the fallback: the CLI's own.
RUNE_VERSION_PKG_REL="packages/orchestrator/package.json"

_rune_version_root() {
  local here
  here="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  (cd -P "$here/.." && pwd)
}

# The `version` field of a package.json, without needing node/jq on the box.
_rune_pkg_version() {
  local file="$1"
  [ -f "$file" ] || return 1
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -1
}

rune_version() {
  if [ -n "${RUNE_VERSION:-}" ]; then
    # Tolerate both `v1.2.3` and `1.2.3` so callers can pass a tag verbatim.
    printf '%s\n' "${RUNE_VERSION#v}"
    return 0
  fi

  local root tag pkg sha
  root="$(_rune_version_root)"

  tag="$(git -C "$root" describe --tags --exact-match 2>/dev/null || true)"
  case "$tag" in
    v[0-9]*) printf '%s\n' "${tag#v}"; return 0 ;;
  esac

  pkg="$(_rune_pkg_version "$root/$RUNE_VERSION_PKG_REL" || true)"
  [ -n "$pkg" ] || pkg="0.0.0"
  sha="$(git -C "$root" rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
  printf '%s-dev+%s\n' "$pkg" "$sha"
}

# The `--define` flag every `bun build --compile` call must carry. Keeping the
# flag itself here means a new build path cannot forget the identifier's name.
rune_version_define() {
  printf -- '--define=RUNE_BUILD_VERSION="%s"\n' "$(rune_version)"
}

# Executed rather than sourced: print the version.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  rune_version
fi
