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
# V9 finding 12: `set -uo pipefail` has no `-e`, and the `mv` below was
# unchecked. When it failed, the `ln -s` returned 0 having built the WRONG
# link, the hazard fixture was never created, and all three asserts — which
# look for 'No such file or directory' — passed on the missing-fixture error.
# The script exited 0 and the job went green having tested nothing. This is
# the file whose sibling (run-suite.sh:57-62) was explicitly hardened against
# "a check that cannot fail mistaken for one that passed".
#
# So: build the hazard, then PROVE it is standing before grading anything
# inside it. The positive control is the escape working UNSANDBOXED — if
# `/root/.local/bin/.ssh/id_rsa` does not hand a credential back to a plain
# `cat` on the host, then the refusals below are the fixture's absence rather
# than the sandbox's work, and they must not be allowed to read as passes.
if ! mv /root/.local/bin /root/.local/bin.real; then
  fail "the hazard fixture could not be staged: mv /root/.local/bin failed"
elif ! ln -s /root /root/.local/bin; then
  fail "the hazard fixture could not be staged: ln -s /root /root/.local/bin failed"
fi
hazard_ready=0
if [ -L /root/.local/bin ] && [ "$(readlink /root/.local/bin)" = /root ]; then
  if cat /root/.local/bin/.ssh/id_rsa 2>/dev/null | grep -qF 'SYNTHETIC-CREDENTIAL'; then
    echo "--- positive control: the escape path resolves on the host and yields the marker"
    echo ok
    hazard_ready=1
  else
    fail "positive control: /root/.local/bin/.ssh/id_rsa does not yield SYNTHETIC-CREDENTIAL on the host — the refusals below would pass on a missing fixture"
  fi
else
  fail "positive control: /root/.local/bin is not a symlink to /root — the hazard was never built"
fi

if [ "$hazard_ready" -eq 1 ]; then
  assert_probe "bound root is a symlink to \$HOME: ~/.ssh via it stays refused" \
    'cat /root/.local/bin/.ssh/id_rsa' 'No such file or directory' 'SYNTHETIC-CREDENTIAL'
  assert_probe "...and ~/.aws via it stays refused" \
    'cat /root/.local/bin/.aws/credentials' 'No such file or directory' 'SYNTHETIC-AWS-CREDENTIAL'
  assert_probe "...and the direct path stays refused too" \
    'cat /root/.ssh/id_rsa' 'No such file or directory' 'SYNTHETIC-CREDENTIAL'
else
  echo "SKIPPED the three V1-4 asserts: the hazard was not standing (already failed above)"
fi
rm -f /root/.local/bin
mv /root/.local/bin.real /root/.local/bin || fail "the toolchain root was not restored after the hazard test"

step "Rune's own credential stores stay unreadable (V9 criticals 2 and 4)"
# The deny list named ~/.rune/secrets.json and stopped, so the provider keys in
# ~/.rune/.env and the memory signing key in ~/.rune/memory/.key were readable
# by any sandboxed bash. Same shape as above: each fixture is proved present on
# the host first, or a refusal proves nothing.
for f in /root/.rune/.env /root/.rune/memory/.key /root/.rune/memory/entries/a.json \
         /root/.rune/credentials.index.json /root/.rune/acceptance-pins/p.json; do
  if ! grep -qF 'SYNTHETIC' "$f" 2>/dev/null; then
    fail "positive control: $f is missing or unmarked on the host — the probe below would pass on nothing"
  fi
done
# bubblewrap masks by MOUNT, so the refusal has two shapes and the assert has
# to name the right one: a denied FILE is /dev/null (readable, zero bytes), a
# denied DIRECTORY is an empty tmpfs (ENOENT for everything under it). Either
# way the marker must be absent — that check is the one that matters.
assert_probe "~/.rune/.env (the provider keys) reads back empty" \
  'cat /root/.rune/.env | wc -c | tr -d " "' '"stdout":"0' 'SYNTHETIC-PROVIDER-KEY'
assert_probe "~/.rune/credentials.index.json reads back empty" \
  'cat /root/.rune/credentials.index.json | wc -c | tr -d " "' '"stdout":"0' 'SYNTHETIC-CRED-INDEX'
assert_probe "~/.rune/memory/.key (the memory signing key) is not there at all" \
  'cat /root/.rune/memory/.key' 'No such file or directory' 'SYNTHETIC-MEMORY-KEY'
assert_probe "...nor is the memory entry it signs" \
  'cat /root/.rune/memory/entries/a.json' 'No such file or directory' 'SYNTHETIC-MEMORY-ENTRY'
assert_probe "the acceptance vault is not there either" \
  'cat /root/.rune/acceptance-pins/p.json' 'No such file or directory' 'SYNTHETIC-VAULT'

echo
if [ "$failed" -eq 0 ]; then echo "ALL PROBES PASSED"; else echo "SOME PROBES FAILED"; fi
exit "$failed"
