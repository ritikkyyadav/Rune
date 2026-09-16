#!/usr/bin/env bash
# The Linux containment audit, as it runs inside the image built by
# scripts/containment/Dockerfile — now driven by
# .github/workflows/containment.yml instead of by hand against the founder's
# broken Docker Desktop. This is
# .codex/audit-20260910/linux/run-suite.sh (the version phase-2c and the F1
# fix lane last ran green on Linux) byte-for-byte, except the two hardenings
# marked below — both are the "smallest fix" already named in
# .codex/audit-20260910/handoff/verify/v1-report.md (finding 8) and repeated
# as a to-do in .codex/audit-20260910/handoff/fix/f1-report.md ("worth fixing
# before the next Linux run is cited").
#
# Everything here is evidence about ONE build: the rune-tools binary compiled
# from the snapshot in this image, named by RUNE_TOOLS_BIN/RUNE_TOOLS_BINARY so
# the suites cannot silently grade a different artifact.
set -uo pipefail

# `bash -l` re-sources /etc/profile, which drops the image's cargo PATH.
# /root/.local/bin is the HOME toolchain fixture (see the Dockerfile).
export PATH=/usr/local/cargo/bin:/root/.local/bin:$PATH
BIN=/workspace/target/debug/rune-tools
failed=0

step() { echo; echo "=== $* ==="; }
fail() {
  echo "FAIL: $*"
  failed=1
}

step "bubblewrap is usable in this container at all"
if bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all -- /bin/true; then
  echo ok
else
  fail "bwrap cannot run — every containment result below would be a skip"
  exit 1
fi

step "clippy (linux.rs is the one file a macOS run cannot lint)"
cargo clippy --locked -p rune-sandbox -p rune-tools --all-targets --all-features -- -D warnings ||
  fail "clippy"

step "rune-sandbox crate tests"
cargo test --locked -p rune-sandbox || fail "cargo test -p rune-sandbox"

step "a home-installed toolchain is visible inside the sandbox"
# /root/.local/bin is a HOME toolchain root, not a system one. Before the
# read-only toolchain binds, PATH named it and the namespace did not have it,
# so this command was "not found" — the CI toolchain-visibility report.
out=$(printf '{"command":"rune-probe-tool"}' | "$BIN" --sandbox --workspace /workspace bash)
echo "$out"
case "$out" in
*home-toolchain-ok*) echo ok ;;
*) fail "a home toolchain directory is not reachable inside the sandbox" ;;
esac

step "...and the rest of the home directory still is not"
# HARDENED past V1 finding 8: the original case-statement was fail-OPEN —
# `*) echo ok` fired whenever the leak marker was absent, including when the
# command failed for a reason that had nothing to do with containment (wrong
# binary, a crashed sandbox, empty output). This now also requires the
# POSITIVE refusal text, so a check that cannot fail is not mistaken for one
# that passed.
out=$(printf '{"command":"cat /root/.ssh/id_rsa; cat /root/.rune-secret; ls /root"}' |
  "$BIN" --sandbox --workspace /workspace bash)
echo "$out"
case "$out" in
*SYNTHETIC-CREDENTIAL*)
  fail "a home credential store is readable inside the sandbox" ;;
*"names a credential store the sandbox may not reach"*)
  # Fix lane G: a credential store named by the command is refused by Rune
  # before anything spawns, on every executor, and the refusal is audited.
  echo ok ;;
*"No such file or directory"*)
  echo ok ;;
*)
  fail "neither the leak marker nor the expected refusal showed up — the command may not have run at all" ;;
esac

step "...even when the command names the store in a way the name check cannot see"
# The by-name refusal above short-circuits the namespace proof, so this shape
# hides the store behind a variable the matcher does not expand. It must reach
# the namespace and find nothing there — the original evidence, kept.
out=$(printf '{"command":"d=/root; cat $d/.ssh/id_rsa; cat $d/.rune-secret; ls $d"}' |
  "$BIN" --sandbox --workspace /workspace bash)
echo "$out"
case "$out" in
*SYNTHETIC-CREDENTIAL*)
  fail "a home credential store is readable inside the sandbox through an indirected path" ;;
*"No such file or directory"* | *"Permission denied"*)
  echo ok ;;
*)
  fail "neither the leak marker nor the expected refusal showed up — the command may not have run at all" ;;
esac

step "integration suites"
# HARDENED past V1 finding 8b: `bun test` exits 0 on an all-skipped run, so
# the historical `|| fail` alone could not tell "passed" from "silently ran
# nothing". Output is captured rather than streamed so it can be graded
# before the step decides pass/fail; it is still echoed in full below.
if bun_out=$(bun test \
  tests/integration/background-sandbox.test.ts \
  tests/integration/plugin-tools-sandbox.test.ts \
  tests/integration/engine-command-evidence.test.ts </dev/null 2>&1); then
  :
else
  fail "bun integration suites (non-zero exit)"
fi
echo "$bun_out"
case "$bun_out" in
*" 0 fail"*) : ;;
*) fail "bun integration suites: no '0 fail' summary line — not the proof a green exit would suggest" ;;
esac
case "$bun_out" in
*" 0 pass"*) fail "bun integration suites: 0 pass — nothing actually ran" ;;
esac

echo
if [ "$failed" -eq 0 ]; then echo "ALL STEPS PASSED"; else echo "SOME STEPS FAILED"; fi
exit "$failed"
