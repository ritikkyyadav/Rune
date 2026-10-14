#!/usr/bin/env bash
# Same-input probes of Rune's file tools against the contract Claude Code's
# Edit/Write tools showed on 2026-10-14 (see README.md beside this file).
#
#   bash edit-probes.sh [path/to/rune-tools]      (default: ~/.rune/bin/rune-tools)
#
# Every probe runs in a fresh temporary directory and touches nothing else.
# PASS means the tool refused or kept the file intact the way Claude Code did;
# FAIL means the file was silently changed in a way the caller did not ask for.
# Exit status is the number of failures, so this can gate CI once R1 lands.

set -u
RT="${1:-$HOME/.rune/bin/rune-tools}"
[ -x "$RT" ] || { echo "rune-tools not found or not executable: $RT" >&2; exit 64; }

W="$(mktemp -d "${TMPDIR:-/tmp}/rune-edit-probes.XXXXXX")"
trap 'rm -rf "$W"' EXIT
cd "$W" || exit 64

sha() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
mode() { if [ "$(uname)" = Darwin ]; then stat -f %Lp "$1"; else stat -c %a "$1"; fi; }
edit() { # edit <path> <old_text_json> <new_text_json>
  printf '{"path":"%s","old_text":"%s","new_text":"%s","expected_hash":"%s"}' "$1" "$2" "$3" "$(sha "$1")" |
    "$RT" --workspace "$W" edit-file 2>&1
}
write() { # write <path> <content_json>
  printf '{"path":"%s","content":"%s"}' "$1" "$2" | "$RT" --workspace "$W" write-file 2>&1
}

fails=0
report() { # report <id> <pass:0|1> <text>
  if [ "$2" = 1 ]; then echo "PASS  $1  $3"; else echo "FAIL  $1  $3"; fails=$((fails + 1)); fi
}

# P1 — editing an executable keeps its mode.
printf '#!/bin/sh\necho hi\n' > p1.sh && chmod 755 p1.sh
edit p1.sh 'echo hi' 'echo bye' >/dev/null
m="$(mode p1.sh)"; report P1 "$([ "$m" = 755 ] && echo 1 || echo 0)" "edit_file on a 755 script -> mode $m"

# P2 — overwriting an executable keeps its mode.
printf '#!/bin/sh\necho hi\n' > p2.sh && chmod 755 p2.sh
write p2.sh '#!/bin/sh\necho bye\n' >/dev/null
m="$(mode p2.sh)"; report P2 "$([ "$m" = 755 ] && echo 1 || echo 0)" "write_file over a 755 script -> mode $m"

# P3 — a new file gets the mode the user's umask gives (0666 & ~umask).
want="$(printf '%o' $(( 0666 & ~0$(umask) )))"
write p3.txt 'hello\n' >/dev/null
m="$(mode p3.txt)"; report P3 "$([ "$m" = "$want" ] && echo 1 || echo 0)" "write_file new file -> mode $m (umask $(umask) gives $want)"

# P4 — a file that is not valid UTF-8 is refused, byte-for-byte unchanged.
printf '# caf\xe9 latin-1 comment\nx = 1\n' > p4.py; before="$(sha p4.py)"
edit p4.py 'x = 1' 'x = 2' >/dev/null
after="$(sha p4.py)"
report P4 "$([ "$before" = "$after" ] && echo 1 || echo 0)" "edit_file on a Latin-1 file -> $([ "$before" = "$after" ] && echo 'unchanged' || echo 'rewritten (undecodable byte replaced by U+FFFD)')"

# P5 — a CRLF file stays CRLF on every line.
printf 'a = 1\r\nb = 2\r\nc = 3\r\n' > p5.txt
edit p5.txt 'a = 1\nb = 2' 'a = 10\nb = 20' >/dev/null
crlf="$(grep -c $'\r$' p5.txt)"; lines="$(wc -l < p5.txt | tr -d ' ')"
report P5 "$([ "$crlf" = "$lines" ] && echo 1 || echo 0)" "edit_file on a CRLF file -> $crlf of $lines lines still CRLF"

# P6 — old_text with the wrong indentation is refused, not re-anchored.
printf 'def f():\n    if x:\n        return 1\n    return 0\n' > p6.py; before="$(sha p6.py)"
out="$(edit p6.py 'if x:\n    return 1' 'if x:\n    log()\n    return 1')"
after="$(sha p6.py)"
strategy="$(printf '%s' "$out" | grep -o '"strategy":"[a-z]*"' | head -1)"
report P6 "$([ "$before" = "$after" ] && echo 1 || echo 0)" "edit_file with mis-indented old_text -> $([ "$before" = "$after" ] && echo 'refused' || echo "applied ${strategy:-?}; file now fails to parse")"

echo "---"
echo "$fails of 6 probes failed  (rune-tools: $RT)"
exit "$fails"
