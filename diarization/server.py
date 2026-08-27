"""Serves the live caption view at http://localhost:8000

Reads the same SQLite file the pipeline writes, opened read-only so the viewer
can never touch the transcript. Stdlib only, no dependencies.

    python server.py            # then open http://localhost:8000
"""

import argparse
import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))


def read_only(db_path):
    """A fresh read-only connection per request: thread-safe, and the viewer
    physically cannot write to the transcript."""
    return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)


class Handler(BaseHTTPRequestHandler):
    db_path = "transcript.db"

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)

        if url.path == "/":
            with open(os.path.join(HERE, "viewer.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")

        if url.path == "/api/segments":
            q = parse_qs(url.query)
            after = int(q.get("after", ["0"])[0])
            try:
                conn = read_only(self.db_path)
            except sqlite3.OperationalError:
                # pipeline hasn't created the database yet
                return self._send(200, json.dumps(
                    {"session": None, "waiting": True, "segments": []}
                ).encode(), "application/json")

            try:
                row = conn.execute(
                    "SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1"
                ).fetchone()
                if not row:
                    return self._send(200, json.dumps(
                        {"session": None, "waiting": True, "segments": []}
                    ).encode(), "application/json")
                session = row[0]
                rows = conn.execute(
                    "SELECT id, t_start, t_end, speaker, text FROM segments"
                    " WHERE session_id = ? AND id > ? ORDER BY id",
                    (session, after),
                ).fetchall()
            finally:
                conn.close()

            payload = {
                "session": session,
                "waiting": False,
                "segments": [
                    {"id": r[0], "t_start": r[1], "t_end": r[2],
                     "speaker": r[3], "text": r[4]}
                    for r in rows
                ],
            }
            return self._send(200, json.dumps(payload).encode(), "application/json")

        self._send(404, b"not found", "text/plain")

    def log_message(self, *args):
        pass  # don't spam the terminal with one line per poll


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=os.path.join(HERE, "transcript.db"))
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args()

    Handler.db_path = args.db
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"live captions:  http://localhost:{args.port}")
    print(f"reading:        {args.db}  (read-only)")
    print("ctrl-c to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
