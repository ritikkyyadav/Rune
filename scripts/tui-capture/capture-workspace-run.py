"""Exercise work, folds, review and resize in the real TUI with a loopback mock.

Reuses the existing README capture's scripted provider and scratch project.
No remote provider, real profile or user workspace is used.
Usage: CAPTURE_ROOT=/tmp/rune-workspace-check python3 this-file.py OUTDIR
"""
import importlib.util
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import capture as rig
from vtcolor import ColorScreen, ColorStream, html

spec = importlib.util.spec_from_file_location("hero", HERE / "capture-readme-hero.py")
hero = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hero)


def main(out):
    out.mkdir(parents=True, exist_ok=True)
    mock = hero.MockOllama()
    session = None
    try:
        hero.scratch_project(mock.port)
        session = rig.Session(rows=40, cols=120, COLORTERM="truecolor",
            RUNE_TERMINAL_BACKGROUND="#0e1016", RUNE_TERMINAL_FOREGROUND="#d6dae3")
        session.screen = ColorScreen(40, 120)
        session.stream = ColorStream(session.screen)
        session.wait_for(["r u n e"], timeout=30)
        session.send(hero.PROMPT)
        session.send(rig.CR)
        deadline = time.monotonic() + 60
        completed = False
        while time.monotonic() < deadline:
            session.pump(0.3)
            if "Both tests pass" in session.screen.text() and "esc stop" not in session.screen.text():
                completed = True
                break
        session.pump(1)

        def save(name):
            session.snapshot(str(out), name)
            (out / (name + ".html")).write_text(html(session.screen,
                ground=(14, 16, 22), foreground=(214, 218, 227), title="Rune - local mock run"))

        save("work-settled-120")
        exit_code = None
        if completed:
            session.send(b"\x0f")  # ctrl+o expands the most recent fold
            save("work-expanded-120")
            session.send(b"\x0f")
            save("work-collapsed-120")
            session.resize(24, 80)
            save("work-resized-80")
            session.resize(40, 120)
            save("work-restored-120")
            session.send(b"\x12")  # ctrl+r opens the work review
            save("work-review-120")
            session.send(rig.ESC)
            # Exercise the user's shutdown path before the rig's signal-based
            # fallback. Compiled binaries should close their own terminal.
            session.send(b"\x15")
            session.send("/quit")
            session.send(rig.CR)
            exit_code = session.wait_exit()
        evidence = {
            "provider": "loopback mock", "remote_provider_calls": 0,
            "completed_scripted_response": completed,
            "mock_requests": len(mock.requests),
            "version_edit_written": "--version" in Path(rig.WORK, "src/cli.js").read_text(),
            "test_file_written": Path(rig.WORK, "test/cli.test.js").exists(),
            "clean_exit": exit_code == 0,
        }
        (out / "result.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence), flush=True)
        if not completed:
            raise SystemExit("The scripted run did not reach its expected final response; inspect the captured frame.")
        if exit_code != 0:
            raise SystemExit("The scripted run completed, but /quit did not exit cleanly.")
    finally:
        if session:
            session.close()
        mock.stop()


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
