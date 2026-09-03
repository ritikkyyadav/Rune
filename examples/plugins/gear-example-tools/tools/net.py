#!/usr/bin/env python3
"""A Gear plugin tool server whose declared capability is ``network``.

The manifest lists the hosts this tool may reach. Gear resolves them and emits
an OS-sandbox rule per endpoint; every other destination is denied at the
kernel, before this program's socket call returns. As in ``files.py`` there is
**no allowlist in this file** — it connects to whatever it is asked to connect
to and reports what the operating system said, so a refusal is provably the
sandbox's and not the tool's politeness.
"""

import json
import sys
import urllib.error
import urllib.request

TOOLS = [
    {
        "name": "http_get",
        "description": (
            "GET a URL and return the status and the first bytes of the body. "
            "Hosts outside the plugin's declared list are refused by the OS sandbox."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Absolute http(s) URL."},
                "max_bytes": {"type": "integer", "description": "Default 2048."},
                "timeout_ms": {"type": "integer", "description": "Default 5000."},
            },
            "required": ["url"],
        },
    }
]


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def http_get(args):
    url = args["url"]
    limit = int(args.get("max_bytes", 2048))
    timeout = float(args.get("timeout_ms", 5000)) / 1000.0
    with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 — arbitrary URL is the tool
        body = response.read(limit)
        return {
            "url": url,
            "status": response.status,
            "body": body.decode("utf-8", "replace"),
        }


def main():
    emit({"type": "schema", "protocol": 1, "tools": TOOLS})
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except ValueError:
            continue
        kind = frame.get("type")
        if kind == "shutdown":
            return
        if kind != "call":
            continue
        call_id = frame.get("id")
        if frame.get("tool") != "http_get":
            emit({"type": "result", "id": call_id, "ok": False, "error": "unknown tool"})
            continue
        try:
            emit({"type": "result", "id": call_id, "ok": True, "result": http_get(frame.get("args") or {})})
        except urllib.error.URLError as err:
            # `URLError` wraps the OSError; unwrap it so the errno survives —
            # EPERM (1) is a sandbox denial, ECONNREFUSED (61) is a server that
            # is not listening, and reporting "failed" for both would make the
            # refusal unprovable.
            reason = getattr(err, "reason", err)
            emit(
                {
                    "type": "result",
                    "id": call_id,
                    "ok": False,
                    "error": "%s: %s" % (type(reason).__name__, reason),
                }
            )
        except Exception as err:  # noqa: BLE001
            emit(
                {
                    "type": "result",
                    "id": call_id,
                    "ok": False,
                    "error": "%s: %s" % (type(err).__name__, err),
                }
            )


if __name__ == "__main__":
    main()
