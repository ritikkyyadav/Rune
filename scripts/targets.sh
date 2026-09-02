#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Gear — the one target list
#
#  Which platforms a release covers was written out three times: in
#  scripts/build-release.sh, in release.yml's CLI job, and implicitly in
#  web-install.sh's naming. Adding a platform meant remembering all of them,
#  and forgetting one produced a release that looked complete and was not.
#
#  One list, sourced by all of them.
#
#  Each entry is `<bun target>:<asset suffix>`. The asset suffix is what the
#  installers look for: `gear-<suffix>` and `gear-tools-<suffix>`.
#
#  Usage:
#    source scripts/targets.sh
#    for pair in "${GEAR_TARGETS[@]}"; do target="${pair%%:*}"; suffix="${pair##*:}"; done
# ──────────────────────────────────────────────────────────

GEAR_TARGETS=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-x64:linux-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-windows-x64:windows-x64.exe"
)

# The gear-tools assets a complete release carries, in the same suffix
# vocabulary. `gear-tools` is Rust and cannot be cross-compiled by bun, so it
# is built per-runner; this list is what the release is checked against.
# shellcheck disable=SC2034  # consumed by release.yml's completeness gate.
GEAR_TOOLS_ASSETS=(
  "darwin-arm64"
  "darwin-x64"
  "linux-x64"
  "linux-arm64"
  "windows-x64.exe"
)

# Print `<bun target> <suffix>` per line — for callers that would rather read
# lines than expand an array (release.yml's inline shell, for one).
gear_targets_lines() {
  local pair
  for pair in "${GEAR_TARGETS[@]}"; do
    printf '%s %s\n' "${pair%%:*}" "${pair##*:}"
  done
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  gear_targets_lines
fi
