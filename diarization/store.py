"""SQLite transcript store.

WAL mode so a reader (watch.py, or later an LLM consumer) can poll the
transcript while the pipeline is still writing to it.
"""

import sqlite3
import time
import uuid

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    started_at  REAL NOT NULL,
    source      TEXT
);

CREATE TABLE IF NOT EXISTS segments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    t_start     REAL NOT NULL,   -- seconds from session start
    t_end       REAL NOT NULL,
    speaker     TEXT NOT NULL,   -- "S1", "S2", ... or a mapped name
    text        TEXT NOT NULL,
    created_at  REAL NOT NULL,   -- wall clock when the row landed
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id, id);
"""


class Store:
    def __init__(self, path="transcript.db"):
        self.path = path
        self._pending = None
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def start_session(self, source: str) -> str:
        # Deliberately not written yet. A run that dies during startup -- bad
        # --device name, missing model -- would otherwise leave an empty session
        # that outranks the real transcript, and readers take the newest session,
        # so the viewer would sit on "waiting" forever with good data right there.
        self._pending = (uuid.uuid4().hex[:12], time.time(), source)
        return self._pending[0]

    def _flush_session(self):
        if self._pending:
            self.conn.execute(
                "INSERT INTO sessions (id, started_at, source) VALUES (?, ?, ?)",
                self._pending,
            )
            self._pending = None

    def add_segment(self, session_id, t_start, t_end, speaker, text) -> int:
        self._flush_session()
        cur = self.conn.execute(
            "INSERT INTO segments (session_id, t_start, t_end, speaker, text, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, t_start, t_end, speaker, text, time.time()),
        )
        self.conn.commit()
        return cur.lastrowid

    def since(self, session_id, after_id=0):
        """Rows newer than after_id. This is the hook an LLM consumer polls."""
        rows = self.conn.execute(
            "SELECT id, t_start, t_end, speaker, text FROM segments"
            " WHERE session_id = ? AND id > ? ORDER BY id",
            (session_id, after_id),
        ).fetchall()
        return [
            {"id": r[0], "t_start": r[1], "t_end": r[2], "speaker": r[3], "text": r[4]}
            for r in rows
        ]

    def latest_session(self):
        row = self.conn.execute(
            "SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        return row[0] if row else None

    def close(self):
        self.conn.close()
