"""Run the TUI trust scenarios with local scripted models and real PTYs."""
import concurrent.futures
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
CASES = ("keys", "midturn", "agents", "card", "deny", "outcomes", "glue", "first", "config", "small")
out = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else pathlib.Path(tempfile.mkdtemp(prefix="rune-trust-evidence-"))
out.mkdir(parents=True, exist_ok=True)
scratch = pathlib.Path(tempfile.mkdtemp(prefix="rune-trust-sessions-"))


def run(case):
    with (out / (case + ".log")).open("w") as log:
        result = subprocess.run(
            [sys.executable, str(HERE / "verify.py"), str(out), str(scratch / case), case],
            stdout=log, stderr=subprocess.STDOUT, timeout=180,
        )
    lines = (out / (case + ".log")).read_text().splitlines()
    for line in lines:
        if line.startswith(("PASS ", "FAIL ")) or "checks passed" in line:
            print(line, flush=True)
    if result.returncode:
        print("FAILED %s: see %s" % (case, out / (case + ".log")), flush=True)
    return result.returncode == 0


with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    results = list(pool.map(run, CASES))
print("%d/%d scenarios passed; evidence: %s" % (sum(results), len(CASES), out), flush=True)
sys.exit(0 if all(results) else 1)
