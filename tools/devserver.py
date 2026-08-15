#!/usr/bin/env python3
"""
devserver — static file server for development, with Apple Vision text
recognition on the same origin.

DEVELOPMENT TOOL. The shipped web app cannot reach Vision from a browser, and the
offline Tesseract engine is not accurate enough on these rotas. This lets the real
pipeline be exercised with the engine that works, and previews what an iOS
Shortcut would return.

Two deliberate choices, both learned the hard way:

  * Same origin. Vision recognition lives at POST /ocr here rather than on a
    separate port. A second port meant a cross-origin request to loopback, which
    Safari blocks under local-network privacy — silently, so the page fell back to
    the offline reader and the result looked like a mysterious accuracy collapse.

  * No caching. Every response is no-store. The default http.server lets browsers
    cache aggressively, which during development means editing a file, reloading,
    and testing the old code without realising.

    swiftc -O tools/visionocr.swift -o tools/visionocr   # once
    python3 tools/devserver.py

Then open http://localhost:8765 — the page detects /ocr and uses Vision by itself.
"""

import http.server
import json
import os
import subprocess
import sys
import tempfile

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BINARY = os.path.join(ROOT, "tools", "visionocr")
MAX_BYTES = 40 * 1024 * 1024
KEEP_LAST = "/tmp/bridge-last.jpg"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # ---------------------------------------------------------------- routes

    def do_GET(self):
        if self.path.rstrip("/") == "/ocr-status":
            self._json({"ok": True, "binary": os.path.exists(BINARY)})
            return
        super().do_GET()

    def do_POST(self):
        if self.path.rstrip("/") != "/ocr":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BYTES:
            self._json({"error": "bad image size"}, 413)
            return
        data = self.rfile.read(length)

        # Keep the last image so the exact bytes a browser produced can be seen.
        try:
            with open(KEEP_LAST, "wb") as keep:
                keep.write(data)
        except OSError:
            pass

        tmp = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
                f.write(data)
                tmp = f.name

            proc = subprocess.run([BINARY, tmp], capture_output=True, timeout=180)
            if proc.returncode != 0:
                msg = proc.stderr.decode("utf-8", "replace")[:400]
                self._json({"error": msg or "visionocr failed"}, 500)
                return

            obs = json.loads(proc.stdout.decode("utf-8"))
            sys.stderr.write("ocr: %d KB in -> %d observations\n" % (len(data) // 1024, len(obs)))
            self._json(obs)

        except FileNotFoundError:
            self._json({"error": "visionocr not built. Run: "
                                 "swiftc -O tools/visionocr.swift -o tools/visionocr"}, 500)
        except subprocess.TimeoutExpired:
            self._json({"error": "recognition timed out"}, 504)
        except Exception as exc:                              # noqa: BLE001
            self._json({"error": repr(exc)}, 500)
        finally:
            if tmp and os.path.exists(tmp):
                os.unlink(tmp)

    # ----------------------------------------------------------------- utils

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *a):
        msg = fmt % a
        if " 200 " not in msg and " 304 " not in msg:
            sys.stderr.write("dev: " + msg + "\n")


if __name__ == "__main__":
    if not os.path.exists(BINARY):
        sys.stderr.write("visionocr is not built yet:\n"
                         "  swiftc -O tools/visionocr.swift -o tools/visionocr\n")
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    sys.stderr.write("Dev server on http://localhost:%d  (no-store, Vision at POST /ocr)\n" % PORT)
    srv.serve_forever()
