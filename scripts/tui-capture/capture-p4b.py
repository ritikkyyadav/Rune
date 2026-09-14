"""P4-§2.8's remainder: /config, /sandbox, /model, /keys, /help, /status.

Reuses the Phase 4 pty rig (`capture.py`) unchanged -- same emulator, same
scratch profile under $TMPDIR, same zero-model-call construction, and now the
same by-shape credential scrub (every `*_API_KEY`/`*_TOKEN` in the parent
environment is dropped from the child).

Nothing here reaches a network at all. Every surface walked is local: two
pickers over the config file, the provider registry read from disk, the key
store under the scratch `RUNE_HOME`, and two commands that print. No key is
validated, because `/keys` stores rather than probes -- which is also why the
key this types is a made-up string that no provider would accept.

  * `<size>-idle`           the frame at rest, for the edge.
  * `<size>-help`           §2.8: a document committed to the WORKSPACE.
  * `<size>-status`         §2.8: committed, and the SESSION column beside it.
  * `<size>-config`         §2.8: the settings list as a picker, in the
                            workspace, with the panel and divider still drawn.
  * `<size>-sandbox`        the same door, three tabs.
  * `<size>-model`          the existing tree picker, level 1.
  * `<size>-keys-list`      §2.8: the provider roster in the workspace.
  * `<size>-keys-manager`   one provider's pool.
  * `<size>-keys-typing`    the key being pasted: the field is in the COMPOSER
                            and it is masked WHOLE -- not even its last four.
  * `<size>-keys-saved`     after enter: the list row carries the last four.

    python3 scripts/tui-capture/capture-p4b.py OUTDIR
"""

import os

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

os.environ.setdefault(
    "CAPTURE_ROOT",
    os.path.join(os.environ.get("TMPDIR", "/tmp"), "rune-p4b-capture"),
)

import capture as rig  # noqa: E402

ESC, CR = rig.ESC, rig.CR

# A key no provider would accept, so that even a surface that decided to probe
# one could only be refused. Its last four are `9d3f`, which is the one part of
# it §2.8 allows on screen -- and only after it is saved.
FAKE_KEY = "sk-p4b-capture-0000-0000-9d3f"
TAIL = FAKE_KEY[-4:]


def forget(provider_id):
    """Remove a keychain entry only when the value there is this rig's own.

    `RUNE_HOME` scopes the profile, not the machine's keychain. `/keys` writes
    to `secrets.json` under the profile and touches no keychain at all -- this
    runs anyway, because "it does not today" is a claim with a shelf life and a
    capture that leaves a credential behind has changed the machine it was
    measuring.
    """
    if sys.platform != "darwin":
        return
    account = "provider:%s" % provider_id
    found = subprocess.run(
        ["security", "find-generic-password", "-s", "rune", "-a", account, "-w"],
        capture_output=True,
        text=True,
    )
    if found.returncode != 0 or found.stdout.strip() != FAKE_KEY:
        return
    subprocess.run(
        ["security", "delete-generic-password", "-s", "rune", "-a", account],
        capture_output=True,
    )
    print("  removed this rig's key from the login keychain (%s)" % account)


def walk(outdir, rows, cols):
    tag = "%dx%d" % (cols, rows)
    rig.fresh_profile()
    s = rig.start(rows, cols)
    provider_id = None
    try:
        s.snapshot(outdir, "%s-idle" % tag)

        # -- /help and /status: committed documents in the workspace --
        s.send("/help", settle=0.4)
        s.send(CR, settle=1.4)
        s.wait_for(["commands"], timeout=30)
        s.snapshot(outdir, "%s-help" % tag)

        s.send("/status", settle=0.4)
        s.send(CR, settle=1.8)
        s.snapshot(outdir, "%s-status" % tag)

        # -- the three pickers --
        for name, needle in (("config", "settings"), ("sandbox", "sandbox"), ("model", "model")):
            s.send("/%s" % name, settle=0.4)
            s.send(CR, settle=1.6)
            s.wait_for([needle], timeout=30)
            s.snapshot(outdir, "%s-%s" % (tag, name))
            s.send(ESC, settle=0.8)

        # -- /keys: the list is the workspace, the field is the composer --
        s.send("/keys", settle=0.4)
        s.send(CR, settle=1.6)
        # The panel's own hint row, which is present in both layouts. Its title
        # row is not: at 80x24 the roster is taller than the footer block, so
        # `footerBlock` clips the top behind its `N more lines above` marker --
        # which is exactly the behaviour §2.2 says a collapsed window keeps.
        s.wait_for(["enter manage keys"], timeout=30)
        s.snapshot(outdir, "%s-keys-list" % tag)

        # Row 0 of the roster. `enter` opens the per-provider pool for a cloud
        # provider and the single-field editor for a local one; both land in a
        # field, and the branch is read off the screen rather than assumed.
        s.send(CR, settle=1.2)
        screen = s.screen.text().lower()
        if "| keys" in screen or "keys configured" in screen or "none configured" in screen:
            s.snapshot(outdir, "%s-keys-manager" % tag)
            s.send("a", settle=1.0)

        # The secret, typed and NOT yet committed: this is the frame acceptance
        # 3 is about.
        s.send(FAKE_KEY, settle=0.8)
        s.snapshot(outdir, "%s-keys-typing" % tag)
        assert FAKE_KEY not in s.screen.text(), "the raw key was painted"
        if cols >= 100:
            # The band's field is `maskLive`: masked whole, not even the tail.
            assert TAIL not in s.screen.text(), "the live field showed the key's tail"
        else:
            # Collapsed, the field is still `renderKeyEditor`'s box, which shows
            # the last four AS YOU TYPE -- Lane E's behaviour, frozen by
            # `ui-composer.test.ts` and by §2.2's "nothing below PANEL_MIN_COLS
            # changes". Asserted in the positive so that a future change to it
            # is a failure here rather than a silent divergence between widths.
            assert TAIL in s.screen.text(), "the collapsed editor stopped showing the tail"

        # enter saves. A pooled add asks for an optional label next; an empty
        # enter skips it and commits.
        s.send(CR, settle=1.2)
        if "label this key" in s.screen.text().lower():
            s.send(CR, settle=1.4)
        s.snapshot(outdir, "%s-keys-saved" % tag)
        assert TAIL in s.screen.text(), "the saved row does not carry the last four"

        s.send(ESC, settle=0.6)
        s.send(ESC, settle=0.8)
        s.snapshot(outdir, "%s-keys-closed" % tag)
    finally:
        s.close()

    # -- the properties, checked rather than claimed --
    leaked = []
    for path in sorted(Path(outdir).glob("%s-*.txt" % tag)):
        if FAKE_KEY in path.read_text():
            leaked.append(str(path))
    store = os.path.join(rig.PROFILE, "secrets.json")
    for root, _dirs, files in os.walk(rig.PROFILE):
        for name in files:
            p = os.path.join(root, name)
            try:
                blob = open(p, "rb").read()
            except OSError:
                continue
            if FAKE_KEY.encode() not in blob:
                continue
            # secrets.json IS the store `/keys` saves to; that is the command.
            # Anywhere else -- a log, a db, a session file -- is a leak.
            if os.path.realpath(p) != os.path.realpath(store):
                leaked.append(p)
    assert not leaked, "the key reached: %s" % leaked
    console = os.path.join(rig.PROFILE, "logs", "tui-console.log")
    if os.path.exists(console):
        assert FAKE_KEY not in open(console, encoding="utf-8", errors="replace").read()
    print("  %s: no key in any frame, and none outside secrets.json" % tag)
    print("     tui-console.log: %s" % ("checked" if os.path.exists(console) else "not written"))

    # Which provider actually received it, read from the store rather than from
    # the screen -- `forget()` below deletes by account name and must be exact.
    if os.path.exists(store):
        import json

        try:
            saved = json.load(open(store))
        except ValueError:
            saved = {}
        for pid, val in (saved.get("keys") or {}).items():
            if val == FAKE_KEY:
                provider_id = pid
        print("     key saved under provider %r in secrets.json" % provider_id)

    # Zero model calls, from the ledger rather than from the absence of a bill.
    db = os.path.join(rig.PROFILE, "rune.db")
    if os.path.exists(db):
        out = subprocess.run(
            ["sqlite3", db, "select (select count(*) from sessions), (select count(*) from events)"],
            capture_output=True,
            text=True,
        )
        print("     rune.db sessions,events: %s" % out.stdout.strip())
    else:
        print("     rune.db: never created")
    return provider_id


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else str(rig.REPO / "captures-p4b")
    os.makedirs(out, exist_ok=True)
    touched = set()
    try:
        for rows, cols in ((40, 120), (24, 80)):
            got = walk(out, rows, cols)
            if got:
                touched.add(got)
    finally:
        for pid in touched or {"anthropic", "openai"}:
            forget(pid)
    print("done ->", out)
