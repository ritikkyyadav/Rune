"""Re-run the audit's scenarios against the fix branch and check the screen."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from mockrig import MockModel, Script, Step, setup, session, save, text, wait_text, rig  # noqa
import project as P

OUT, SCR, CASE = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
ESC, CR = b"\x1b", b"\r"
RIGHT = b"\x1b[C"
results = []

def check(name, ok, s=None):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name, flush=True)
    if s is not None and not ok:
        save(s, OUT, "%s-FAIL-%d" % (CASE, len(results)))

def boot(s):
    if not wait_text(s, "r u n e", 90):
        raise AssertionError("Rune did not reach its startup screen")
    s.pump(1.5)

def ask(s, prompt):
    s.send(prompt, settle=0.4); s.send(CR, settle=0.2)

def _rules(rows):
    return [i for i, r in enumerate(rows) if r.strip() and set(r.strip()) <= {"\u2500", "-"}]

def rest_row(s):
    rows = text(s).split("\n")
    rules = _rules(rows)
    return rows[rules[-2] - 1] if len(rules) >= 2 and rules[-2] > 0 else ""

def composer_line(s):
    rows = text(s).split("\n")
    rules = _rules(rows)
    return rows[rules[-2] + 1].strip() if len(rules) >= 2 else ""

if CASE == "keys":
    mock = MockModel(Script({}, Step("ok")))
    setup(SCR, mock.port)
    s = session(24, 80)
    try:
        boot(s)
        s.send("/help", settle=0.4); s.send(CR, settle=1.5)
        s.send("fix the flaky login test", settle=0.6)
        s.send(b"\x1bb", settle=0.8)
        check("Option+left (ESC b) keeps the draft", "fix the flaky login test" in text(s), s)
        s.send(b"\x1b\x7f", settle=0.8)
        check("Option+Backspace deletes one word, not the draft", "fix the flaky test" in text(s), s)
        s.send(b"\x17", settle=0.8)
        check("ctrl+w deletes the previous word", "fix the test" in text(s), s)
        s.send(b"\x1bx", settle=0.8)
        check("an unbound Option chord changes nothing", "fix the test" in text(s), s)
        s.send(b"\x0c", settle=1.0)
        check("ctrl+l keeps the transcript", "Commands" in text(s), s)
        save(s, OUT, "keys-final")
    finally:
        s.close(); mock.stop()

elif CASE == "midturn":
    sc = Script({0: Step("Reading the CLI first.", [("read_file", {"path": "src/cli.js"})], stall=12, stall_times=1)},
                Step("Done reading; the CLI parses two flags."))
    mock = MockModel(sc)
    setup(SCR, mock.port, project=P.PROJECT)
    s = session(30, 100)
    try:
        boot(s)
        ask(s, "read the cli")
        s.pump(3.0)
        s.send(b"\x1bf", settle=1.5)
        check("Option+right mid-run does not stop the run", "interrupting" not in text(s), s)
        check("and types nothing into the composer", not composer_line(s).startswith("› f"), s)
        ok = wait_text(s, "the CLI parses two flags", 60)
        s.pump(12)
        check("the run finishes", ok, s)
        check("its rest row says done", "done" in rest_row(s), s)
        save(s, OUT, "midturn-final")
    finally:
        s.close(); mock.stop()

elif CASE == "agents":
    def child(name, path):
        return Script({0: Step("Reading %s." % path, [("read_file", {"path": path})], stall=5),
                       1: Step("Searching.", [("grep", {"pattern": "save", "path": "src", "regex": False})], stall=5),
                       2: Step("Listing.", [("list_dir", {"path": "src"})], stall=5)},
                      Step("%s: the store is an in-memory Map." % name, stall=3))
    sc = Script({0: Step("I'll split this into two investigations.",
                         [("task", {"prompt": "[child:mapper] map the store", "name": "mapper", "label": "map the store"}),
                          ("task", {"prompt": "[child:scout] find the callers", "name": "scout", "label": "find the callers"})])},
                Step("Both agents agree: one file to change."),
                children={"mapper": child("mapper", "src/store.js"), "scout": child("scout", "src/cli.js")})
    mock = MockModel(sc)
    setup(SCR, mock.port, project=P.PROJECT)
    s = session(30, 100)
    try:
        boot(s)
        ask(s, "figure out how sessions are stored and who uses them")
        wait_text(s, "investigations", 60); s.pump(3.0)
        s.send(RIGHT, settle=0.8); s.send(CR, settle=1.5)
        check("an agent's transcript opens", "── " in text(s) and "esc back" in text(s), s)
        s.send(ESC, settle=0.8); s.send(ESC, settle=0.8)
        check("two Escs out of an agent's transcript do not stop the run", "interrupting" not in text(s), s)
        s.send(ESC, settle=0.5)
        check("the first Esc on the composer only arms the stop, and says so",
              "esc again to stop" in text(s) and "interrupting" not in text(s), s)
        save(s, OUT, "agents-armed")
        s.send(ESC, settle=2.0)
        check("the second Esc stops the run", "interrupting" in text(s), s)
        s.pump(6.0)
        save(s, OUT, "agents-stopped")
        check("the rest row says stopped by you", "stopped by you" in rest_row(s), s)
        s.send(b"\x06", settle=1.0)
        save(s, OUT, "agents-cards")
        cards = text(s)
        check("stopped agents are not ticked", "✓" not in cards and "~" in cards, s)
    finally:
        s.close(); mock.stop()

elif CASE in ("card", "deny"):
    sc = Script({0: Step("Checking the build first.", [("bash", {"command": "node src/cli.js build --json"})])},
                Step("The CLI prints the build result."))
    mock = MockModel(sc)
    setup(SCR, mock.port, gear=2, project=P.PROJECT)
    s = session(24, 80)
    try:
        boot(s)
        ask(s, "build it as json")
        wait_text(s, "run this command", 40); s.pump(1.0)
        if CASE == "card":
            s.send("build it as json again", settle=1.0)
            check("typing a sentence on the card approves nothing", "approved" not in text(s), s)
            check("what was typed is kept, and shown on the card",
                  "kept for after: build it as json again" in text(s), s)
            save(s, OUT, "card-typed")
            s.pump(2.0)
            s.send(b"1", settle=2.0)
            check("a deliberate 1 approves once", "approved once" in text(s), s)
            wait_text(s, "prints the build result", 40); s.pump(10)
            check("the typed message is still in the composer afterwards",
                  "build it as json again" in composer_line(s), s)
            save(s, OUT, "card-final")
        else:
            s.pump(1.0)
            s.send(b"3", settle=2.0)
            wait_text(s, "prints the build result", 40); s.pump(8)
            save(s, OUT, "deny-final")
            t = text(s)
            check("a No is drawn as your choice", "skipped, you said no" in t, s)
            check("not as a red failure", "User denied" not in t, s)
    finally:
        s.close(); mock.stop()

elif CASE == "outcomes":
    ANSWER = "`src/store.js` keeps sessions in an in-memory `Map`; nothing survives a restart."
    cases = {
        "e500": (Script({0: Step(error=(500, "internal server error"))}, Step(ANSWER)), "stopped on an error", 75),
        "e429": (Script({0: Step(error=(429, "rate limit exceeded"))}, Step(ANSWER)), "rate-limited", 40),
        "clean": (Script({0: Step("Reading the store.", [("read_file", {"path": "src/store.js"})])}, Step(ANSWER)), "done", 40),
    }
    for name, (sc, want, wait) in cases.items():
        mock = MockModel(sc)
        setup(SCR + "-" + name, mock.port, project=P.PROJECT)
        s = session(30, 100)
        try:
            boot(s)
            ask(s, "explain what src/store.js does")
            end = time.monotonic() + wait
            while time.monotonic() < end and "esc stop" in text(s) or time.monotonic() < end - wait + 4:
                s.pump(1.0)
            s.pump(6.0)
            save(s, OUT, "outcome-" + name)
            row = rest_row(s)
            check("%s: the rest row says %r (got %r)" % (name, want, row.strip()), want in row, s)
            if name == "clean":
                head = [r for r in text(s).split("\n") if "◇" in r and "Map" in r]
                check("clean: the answer's headline is rendered, no raw backticks",
                      head and "`" not in head[-1], s)
        finally:
            s.close(); mock.stop()

elif CASE == "glue":
    import importlib.util
    # the realistic run from the audit: a failing check, then repeated answers
    SCRIPT = Script(
        steps={0: Step("Reading the CLI.", [("read_file", {"path": "src/cli.js"})]),
               1: Step("Adding the flag.", [("multi_edit", {"path": "src/cli.js", "edits": P.EDITS_OK})]),
               2: Step("Now the tests.", [("write_file", {"path": "test/cli.test.js", "content": P.TEST_GOOD})])},
        final=Step(P.FINAL_MD, delay=0.01))
    mock = MockModel(SCRIPT)
    setup(SCR, mock.port, project=P.PROJECT)
    s = session(30, 100)
    try:
        boot(s)
        ask(s, "add a --version flag to the cli and a test for it")
        wait_text(s, "say if you want", 120)
        end = time.monotonic() + 90
        while time.monotonic() < end and "esc stop" in text(s):
            s.pump(1.0)
        s.pump(4.0)
        save(s, OUT, "glue-settled")
        check("the run with a failing check ends 'checks failing'", "checks failing" in rest_row(s), s)
        pages = [text(s)]
        for i in range(12):
            s.send(b"\x1b[5~", settle=0.4); pages.append(text(s))
        joined = "\n".join(pages)
        check("no two answers glued mid-sentence", "there.--version" not in joined and "there.`--version" not in joined, s)
        heads = [r for r in joined.split("\n") if "◇" in r and "now print the version" in r]
        check("every answer headline is rendered (no raw backticks)", heads and all("`" not in h for h in heads), s)
    finally:
        s.close(); mock.stop()

passed = sum(1 for _, ok in results if ok)
print("%s: %d/%d checks passed" % (CASE, passed, len(results)))

sys.exit(0 if results and passed == len(results) else 1)
