"""Live interview assistant: diarized transcript + LLM question-coverage, one origin.

Serves the fieldnotes UI and three JSON endpoints so the browser can run the real
interview instead of the canned demo:

    GET  /                         -> the fieldnotes UI (--ui path)
    GET  /api/segments?after=<id>  -> diarized transcript rows from the pipeline's SQLite
    POST /api/plan                 -> {questions:[{id,topic,label,text}], interviewer:"Interviewer"}
    GET  /api/coverage?after=<id>  -> LLM coverage events derived from the transcript

A background worker tails the transcript, and for each new utterance asks a LOCAL
Ollama model (llama3.1:8b) which planned questions it covers — so no audio or text
leaves the machine, matching the pipeline's local-only guarantee.

    python assistant.py --ui /Users/dagartyi/intermeow/fieldnotes-tree2.html
"""

import argparse
import atexit
import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                              # intermeow/
DIAR = os.path.join(ROOT, "diarization")
DB_DEFAULT = os.path.join(DIAR, "transcript.db")
UI_DEFAULT = os.path.join(ROOT, "canvas", "fieldnotes.html")
PIPELINE = os.path.join(DIAR, "pipeline.py")
SAMPLE = os.path.join(DIAR, "sample_interview.wav")
OLLAMA_URL = "http://localhost:11434/api/chat"

# ---- diarization pipeline as a managed subprocess -----------------------
PIPE = None                                              # Popen handle, or None
PIPE_INFO = {"running": False, "source": None}

def stop_pipeline():
    global PIPE
    if PIPE and PIPE.poll() is None:
        try:
            PIPE.terminate()
            try: PIPE.wait(timeout=5)
            except subprocess.TimeoutExpired: PIPE.kill()
        except Exception:
            pass
    PIPE = None
    PIPE_INFO.update(running=False, source=None)

def start_pipeline(source, device, names):
    """Spawn diarization/pipeline.py. source: 'sample' | 'device'."""
    global PIPE
    stop_pipeline()
    names = names or "Interviewer,Candidate"
    args = [sys.executable, PIPELINE, "--reset", "--names", names]
    if source == "sample":
        args += ["--source", "file", "--path", SAMPLE]      # realtime pacing (no --fast) = feels live
    else:
        args += ["--source", "device", "--device", device or "MacBook Pro Microphone"]
    log = open(os.path.join(DIAR, "pipeline.log"), "w")
    PIPE = subprocess.Popen(args, cwd=DIAR, stdout=log, stderr=subprocess.STDOUT)
    PIPE_INFO.update(running=True, source=source)
    return PIPE_INFO.copy()

atexit.register(stop_pipeline)

# ---- shared state (guarded by LOCK) -------------------------------------
LOCK = threading.Lock()
PLAN = {"by_id": {}, "order": [], "interviewer": "Interviewer", "text": ""}
COVERAGE = []            # [{id, seg_id, speaker, matches:[{id,status}]}]
STATE = {"session": None, "last_seg": 0}

SYS = (
    "You tag interview dialogue against a fixed list of planned questions.\n"
    "Input: the PLAN (id: question) and ONE utterance with its SPEAKER.\n"
    "Output ONLY JSON: {\"matches\":[{\"id\":\"<plan id>\",\"status\":\"<status>\"}]}.\n\n"
    "Rules:\n"
    "- CANDIDATE utterance: list every plan question whose SUBJECT the answer addresses. "
    "status is exactly \"green\" (clearly answered) or \"amber\" (touched in passing). "
    "Match on subject overlap: describing their job/products answers a 'what have you worked on' "
    "question; naming their toughest problem answers a 'hardest thing' question.\n"
    "- INTERVIEWER utterance: the ONE plan question they are asking, status exactly \"ask\". "
    "Empty if it is small talk or a generic follow-up.\n"
    "- Use only ids from the PLAN. Never invent ids. status is never empty. "
    "Be conservative: omit weak matches. If nothing fits: {\"matches\":[]}."
)


def ollama_matches(model, plan_text, speaker, text):
    user = f"PLAN:\n{plan_text}\n\nSPEAKER: {speaker}\nUTTERANCE: {text}"
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": user}],
        "stream": False, "format": "json", "options": {"temperature": 0},
    }).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        out = json.load(r)
    try:
        raw = json.loads(out["message"]["content"]).get("matches", [])
    except Exception:
        return []
    valid = {"green", "amber", "ask"}
    clean = []
    with LOCK:
        ids = set(PLAN["by_id"].keys())
        interviewer = PLAN["interviewer"]
    is_interviewer = speaker == interviewer
    for m in raw:
        if not isinstance(m, dict):
            continue
        qid, st = m.get("id"), (m.get("status") or "").lower()
        if qid not in ids:
            continue
        if st not in valid:
            st = "ask" if is_interviewer else "amber"
        # interviewers only "ask"; candidates never "ask"
        if is_interviewer and st != "ask":
            st = "ask"
        if not is_interviewer and st == "ask":
            st = "amber"
        clean.append({"id": qid, "status": st})
    return clean


def ollama_cues(model, question, kind="answered"):
    """Short cue phrases for a question. kind='answered' = signals the answer was given;
    kind='asking' = paraphrases the interviewer might use to ASK it."""
    if kind == "asking":
        prompt = ("For an interview question, list 4-6 SHORT phrases the INTERVIEWER might say "
                  "when asking it (paraphrases or lead-ins). Return ONLY JSON: {\"cues\":[\"...\"]}. "
                  "Each 1-4 words, lowercase, no duplicates.\n\nQUESTION: " + question)
    else:
        prompt = ("For an interview question, list 4-6 SHORT cue phrases or keywords that, if the "
                  "interviewee says them, signal they've answered it. Prefer concrete nouns/verbs "
                  "over generic words. Return ONLY JSON: {\"cues\":[\"...\"]}. Each 1-3 words, "
                  "lowercase, no duplicates.\n\nQUESTION: " + question)
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}],
                       "stream": False, "format": "json", "options": {"temperature": 0.3}}).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    try:
        raw = json.loads(out["message"]["content"]).get("cues", [])
    except Exception:
        return []
    seen, cues = set(), []
    for c in raw:
        c = str(c).strip().lower()
        if c and c not in seen:
            seen.add(c); cues.append(c)
    return cues[:8]


def read_only(db):
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def latest_session(conn):
    row = conn.execute("SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1").fetchone()
    return row[0] if row else None


def worker(db, model):
    """Tail the transcript; classify each new utterance against the current plan."""
    while True:
        time.sleep(1.0)
        with LOCK:
            have_plan = bool(PLAN["by_id"])
            plan_text = PLAN["text"]
        if not have_plan:
            continue
        try:
            conn = read_only(db)
        except sqlite3.OperationalError:
            continue
        try:
            session = latest_session(conn)
            if not session:
                continue
            with LOCK:
                if session != STATE["session"]:      # new run -> start fresh
                    STATE["session"] = session
                    STATE["last_seg"] = 0
                    COVERAGE.clear()
                after = STATE["last_seg"]
            rows = conn.execute(
                "SELECT id, speaker, text FROM segments WHERE session_id=? AND id>? ORDER BY id",
                (session, after),
            ).fetchall()
        finally:
            conn.close()
        for seg_id, speaker, text in rows:
            try:
                matches = ollama_matches(model, plan_text, speaker, text)
            except Exception as e:
                matches = []
                print(f"[worker] classify failed on seg {seg_id}: {e}")
            with LOCK:
                COVERAGE.append({
                    "id": len(COVERAGE) + 1, "seg_id": seg_id,
                    "speaker": speaker, "matches": matches,
                })
                STATE["last_seg"] = seg_id
            if matches:
                print(f"[cover] {speaker}: {text[:40]!r} -> {matches}")


class Handler(BaseHTTPRequestHandler):
    db_path = "transcript.db"
    model = "llama3.2:3b"
    ui_path = ""

    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj), "application/json")

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/api/plan":
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
            qs = data.get("questions", [])
            with LOCK:
                PLAN["by_id"] = {q["id"]: q for q in qs}
                PLAN["order"] = [q["id"] for q in qs]
                PLAN["interviewer"] = data.get("interviewer", "Interviewer")
                PLAN["text"] = "\n".join(f'{q["id"]}: {q["text"]}' for q in qs)
                STATE["session"] = None      # force re-scan against the new plan
                STATE["last_seg"] = 0
                COVERAGE.clear()
            return self._json({"ok": True, "questions": len(qs)})
        if url.path == "/api/start":
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
            try:
                info = start_pipeline(data.get("source", "sample"), data.get("device"), data.get("names"))
                return self._json({"ok": True, **info})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        if url.path == "/api/stop":
            stop_pipeline()
            return self._json({"ok": True, "running": False})
        if url.path == "/api/cues":
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
            q = (data.get("question") or "").strip()
            if not q:
                return self._json({"ok": False, "cues": []})
            try:
                return self._json({"ok": True, "cues": ollama_cues(self.model, q, data.get("kind", "answered"))})
            except Exception as e:
                return self._json({"ok": False, "error": str(e), "cues": []})
        self._send(404, b"not found", "text/plain")

    def do_GET(self):
        url = urlparse(self.path)

        if url.path == "/":
            if self.ui_path and os.path.exists(self.ui_path):
                with open(self.ui_path, "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            return self._send(200, b"<h1>assistant running</h1><p>no --ui set</p>", "text/html")

        if url.path == "/api/segments":
            after = int(parse_qs(url.query).get("after", ["0"])[0])
            try:
                conn = read_only(self.db_path)
            except sqlite3.OperationalError:
                return self._json({"session": None, "waiting": True, "segments": []})
            try:
                session = latest_session(conn)
                if not session:
                    return self._json({"session": None, "waiting": True, "segments": []})
                rows = conn.execute(
                    "SELECT id, t_start, t_end, speaker, text FROM segments"
                    " WHERE session_id=? AND id>? ORDER BY id", (session, after)).fetchall()
            finally:
                conn.close()
            return self._json({"session": session, "waiting": False, "segments": [
                {"id": r[0], "t_start": r[1], "t_end": r[2], "speaker": r[3], "text": r[4]}
                for r in rows]})

        if url.path == "/api/coverage":
            after = int(parse_qs(url.query).get("after", ["0"])[0])
            with LOCK:
                events = [e for e in COVERAGE if e["id"] > after]
                has_plan = bool(PLAN["by_id"])
            return self._json({"has_plan": has_plan, "events": events})

        if url.path == "/api/status":
            running = bool(PIPE and PIPE.poll() is None)
            if not running and PIPE_INFO["running"]:
                PIPE_INFO.update(running=False, source=None)
            return self._json({"running": running, "source": PIPE_INFO["source"]})

        self._send(404, b"not found", "text/plain")

    def log_message(self, *a):
        pass


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=DB_DEFAULT)
    p.add_argument("--ui", default=UI_DEFAULT)
    p.add_argument("--model", default="llama3.2:3b")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args()

    Handler.db_path = args.db
    Handler.ui_path = args.ui
    Handler.model = args.model
    threading.Thread(target=worker, args=(args.db, args.model), daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"assistant:   http://localhost:{args.port}")
    print(f"ui:          {args.ui}")
    print(f"transcript:  {args.db}  (read-only)")
    print(f"llm:         {args.model} via {OLLAMA_URL}")
    print("ctrl-c to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
