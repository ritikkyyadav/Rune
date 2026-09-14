#!/usr/bin/env bash
# The toolchain-root symlink probe (V1 finding 4 / "V1-4"), CI-adapted from
# .codex/audit-20260910/handoff/verify/v1/probe.sh.
#
# The original only printed what came back, for a person to read — exactly
# the gap V4 flagged ("the escape is covered only by the unit test... V4:
# build Dockerfile.probe and run it", never done because V4's Docker was as
# broken as the founder's). This version runs the same commands, through the
# same sandboxed bash tool, but grades them, because a job that only prints
# cannot fail a PR on a real escape.
#
# Narrowed from the original: the informational-only "/etc is bound whole"
# print is dropped (it never had a documented pass/fail expectation). Every
# assertion below is backed by a recorded expected result in
# .codex/audit-20260910/handoff/verify/v1/linux-probe.log or
# fix/f1-report.md.
#
# shellcheck disable=SC2088  # the `~` below is label text for the log, matching the original probe.sh; nothing expands it
set -uo pipefail
export PATH=/usr/local/cargo/bin:/root/.local/bin:/root/.cargo/bin:$PATH
BIN=/workspace/target/debug/rune-tools
failed=0

step() { echo; echo "=== $* ==="; }
fail() { echo "FAIL: $*"; failed=1; }

# Runs $1 through the sandboxed bash tool and prints its JSON result.
run() {
  printf '{"command":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    | "$BIN" --sandbox --workspace /workspace bash
}

# assert_probe NAME COMMAND WANT [FORBID]
# Runs COMMAND, fails if FORBID (a credential marker) appears anywhere in the
# result, then fails unless WANT (the expected refusal or success text) also
# appears. Both checks matter: FORBID alone would be fail-open exactly like
# V1 finding 8 (a crashed or empty result also lacks the marker).
assert_probe() {
  local name="$1" cmd="$2" want="$3" forbid="${4:-}"
  local out
  out="$(run "$cmd")"
  echo; echo "--- $name"; echo "$out"
  if [ -n "$forbid" ] && printf '%s' "$out" | grep -qF "$forbid"; then
    fail "$name: leaked '$forbid'"
    return
  fi
  if ! printf '%s' "$out" | grep -qF "$want"; then
    fail "$name: expected '$want' not found"
    return
  fi
  echo "ok"
}

step "toolchain root + credential-escape fixtures"
assert_probe "the cargo/bin toolchain root works" \
  'rune-cargo-probe' 'cargo-bin-ok'
assert_probe "~/.cargo/credentials.toml beside it stays refused" \
  'cat /root/.cargo/credentials.toml' 'No such file or directory' 'SYNTHETIC-CARGO-TOKEN'
assert_probe "~/.aws is not bound" \
  'cat /root/.aws/credentials' 'No such file or directory' 'SYNTHETIC-AWS-CREDENTIAL'
assert_probe "absolute symlink inside a bound root -> ~/.ssh stays refused" \
  'cat /root/.local/bin/escape-abs-ssh' 'No such file or directory' 'SYNTHETIC-CREDENTIAL'
assert_probe "absolute symlink inside a bound root -> cargo creds stays refused" \
  'cat /root/.local/bin/escape-abs-cargo' 'No such file or directory' 'SYNTHETIC-CARGO-TOKEN'
assert_probe "relative symlink inside a bound root -> ~/.aws stays refused" \
  'cat /root/.local/bin/escape-rel-aws' 'No such file or directory' 'SYNTHETIC-AWS-CREDENTIAL'

step "the sealed root and the writable scratch areas (unchanged controls)"
out="$(run 'echo x > /outside.txt; echo "rc=$?"; echo y > ../outside.txt; echo "rc2=$?"')"
echo "$out"
case "$out" in
*'Read-only file system'*) echo ok ;;
*) fail "the sealed root accepted a write outside it" ;;
esac
out="$(run 'echo ok1 > /workspace/.probe-write && cat /workspace/.probe-write && echo ok2 > /tmp/.probe-write && cat /tmp/.probe-write')"
echo "$out"
case "$out" in
*ok1*ok2*) echo ok ;;
*) fail "workspace or /tmp is not writable — the sandbox may be too tight to be useful" ;;
esac

step "THE finding: a toolchain root that is itself a symlink to \$HOME (V1-4)"
mv /root/.local/bin /root/.local/bin.real
ln -s /root /root/.local/bin
assert_probe "bound root is a symlink to \$HOME: ~/.ssh via it stays refused" \
  'cat /root/.local/bin/.ssh/id_rsa' 'No such file or directory' 'SYNTHETIC-CREDENTIAL'
assert_probe "...and ~/.aws via it stays refused" \
  'cat /root/.local/bin/.aws/credentials' 'No such file or directory' 'SYNTHETIC-AWS-CREDENTIAL'
assert_probe "...and the direct path stays refused too" \
  'cat /root/.ssh/id_rsa' 'No such file or directory' 'SYNTHETIC-CREDENTIAL'
rm -f /root/.local/bin && mv /root/.local/bin.real /root/.local/bin

echo
if [ "$failed" -eq 0 ]; then echo "ALL PROBES PASSED"; else echo "SOME PROBES FAILED"; fi
exit "$failed"
