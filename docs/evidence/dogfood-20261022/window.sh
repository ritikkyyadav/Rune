#!/bin/bash
# The Codex subscription windows, read with one tiny request (probe.sh, the
# R8 probe: Rune 1.4.10 in a scratch profile, credentials through their paths)
# and the meter in that probe's database. Prints one line.
set -u
R8=$HOME/rune-evidence/r8-20261021
bash "$R8/probe.sh" > /dev/null 2>&1
P=$(ls -dt "$R8"/probe-* | head -1)
python3 - "$P/profile/rune.db" <<'EOF'
import sqlite3, json, sys, datetime
con = sqlite3.connect(f"file:{sys.argv[1]}?immutable=1", uri=True)
last = None
for (s,) in con.execute("select payload_json from events where payload_json like '%\"capacity\":{\"primary\"%' order by created_at"):
    i = s.find('"capacity":{"primary"'); frag = s[i+11:]; depth = 0
    for j, ch in enumerate(frag):
        if ch == '{': depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0: last = json.loads(frag[:j+1]); break
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
if last:
    print(f"window {now} five-hour {last['primary'].get('usedPercent')}% weekly {last['secondary'].get('usedPercent')}%")
else:
    print(f"window {now} no reading")
EOF
