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
import re
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
CAPTURE = os.path.join(DIAR, "capture", "systemaudio")   # optional SCK helper (built separately)
PIPE = None                                              # pipeline Popen, or None
CAP = None                                               # capture-helper Popen, or None
PIPE_LOG = None
PIPE_INFO = {"running": False, "source": None}

def _end(p):
    if p and p.poll() is None:
        try:
            p.terminate()
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: p.kill()
        except Exception:
            pass

def stop_pipeline():
    global PIPE, CAP, PIPE_LOG
    _end(PIPE); _end(CAP)          # kill the capture helper too, if any
    PIPE = None; CAP = None
    if PIPE_LOG:
        try: PIPE_LOG.close()
        except Exception: pass
        PIPE_LOG = None
    PIPE_INFO.update(running=False, source=None)

def start_pipeline(source, device, names):
    """Spawn diarization/pipeline.py. source: 'sample' | 'device' | 'system' | 'call'.
    'system' pipes the Core Audio process-tap helper's PCM into --source stdin (no BlackHole).
    'call' adds your microphone as a second channel: you = mic, them = system audio, so the
    speakers come from the channel and no diarization model is loaded."""
    global PIPE, CAP, PIPE_LOG
    stop_pipeline()
    names = names or "Interviewer,Candidate"
    PIPE_LOG = open(os.path.join(DIAR, "pipeline.log"), "w")
    base = [sys.executable, PIPELINE, "--reset", "--names", names]
    if source in ("system", "call"):
        if not os.path.exists(CAPTURE):
            PIPE_LOG.write("[system] capture helper not built. Run: diarization/capture/build.sh\n")
            PIPE_LOG.flush()
            raise FileNotFoundError("capture helper not built (diarization/capture/build.sh)")
        cap_args = [CAPTURE] + (["--app", device] if device else [])   # device carries an optional app name
        if source == "call":
            cap_args.append("--with-mic")
        CAP = subprocess.Popen(cap_args, stdout=subprocess.PIPE, stderr=PIPE_LOG)
        chans = ["--channels", "2"] if source == "call" else []
        PIPE = subprocess.Popen(base + ["--source", "stdin"] + chans, cwd=DIAR,
                                stdin=CAP.stdout, stdout=PIPE_LOG, stderr=subprocess.STDOUT)
        CAP.stdout.close()          # let the helper get SIGPIPE if the pipeline dies
    elif source == "sample":
        # The sample's two synthetic voices are too alike for Nemotron (it hears one
        # speaker); Sortformer splits them cleanly. Live sources keep Nemotron.
        PIPE = subprocess.Popen(base + ["--diarizer", "sortformer", "--source", "file", "--path", SAMPLE],
                                cwd=DIAR, stdout=PIPE_LOG, stderr=subprocess.STDOUT)
    else:  # device (mic / BlackHole)
        PIPE = subprocess.Popen(base + ["--source", "device", "--device", device or "MacBook Pro Microphone"],
                                cwd=DIAR, stdout=PIPE_LOG, stderr=subprocess.STDOUT)
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


# ---- anonymization: people's names -> [PERSON] ------------------------------------
# The LLM only LISTS the names it sees; the replacement is done here. A free-form
# rewrite drifts (it invents tags like [COMPANY], drops words), whereas exact-string
# masking can change nothing but the names themselves.
NAME_SYS = (
    "List every PERSON'S NAME that appears in the user's text: first names, last names, "
    "full names, nicknames. People only - not companies, products, places, teams or job "
    "titles. Copy each name exactly as written. Output ONLY JSON: {\"names\": [\"...\"]}. "
    "If there are none, output {\"names\": []}."
)
NAMES_SEEN = {}                 # source text -> names the LLM found in it (None = LLM failed)
KNOWN_NAMES = set()             # every name found this server run; masked in ALL texts
ANON_LLM = threading.Lock()     # one LLM call at a time; don't pile onto the GPU
_NOT_NAMES = {"I", "The", "A", "An", "We", "You", "He", "She", "They", "It", "My", "Our",
              "Your", "So", "Yeah", "Yes", "No", "Okay", "OK", "And", "But", "Hi", "Hello",
              "Thanks", "Honestly", "Interviewer", "Candidate", "Dr", "Mr", "Mrs", "Ms"}
_NAME_PARTICLES = {"de", "van", "von", "da", "di", "la", "le", "del", "der", "bin", "al"}
# design / CAD software the small model likes to mistake for people ("in Rhino, ...")
_TOOLS = {"rhino", "rhinoceros", "fusion", "fusion 360", "solidworks", "onshape", "grasshopper",
          "creo", "catia", "nx", "inventor", "autocad", "blender", "keyshot", "figma", "sketch",
          "maya", "alias", "revit", "sketchup", "cinema", "houdini", "zbrush", "vred", "ansys",
          "abaqus", "comsol", "matlab", "excel", "jira", "slack", "teams", "notion", "miro"}
VERIFY_SYS = (
    "Answer whether the given word or phrase is used as a PERSON'S NAME in the sentence. "
    "Software, products, companies, places and teams are NOT people. "
    "Output ONLY JSON: {\"person\": true} or {\"person\": false}."
)


def _name_re(name):
    return re.compile(r"(?<!\w)" + re.escape(name) + r"(?!\w)")


def _plausible_name(name, text):
    """Guard against LLM noise ('latency', 'us'): a name must occur verbatim in the
    text and every word of it must be capitalized there."""
    name = name.strip()
    if not name or len(name) > 40 or name in _NOT_NAMES or not _name_re(name).search(text):
        return False
    words = re.findall(r"[^\W\d_][\w'.-]*", name)
    return bool(words) and all(w[0].isupper() for w in words if w.lower() not in _NAME_PARTICLES)


def _llm_names(model, text):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": NAME_SYS}, {"role": "user", "content": text}],
        "stream": False, "format": "json", "options": {"temperature": 0},
    }).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        names = json.loads(json.load(r)["message"]["content"]).get("names", [])
    with LOCK:
        plan = PLAN["text"]
    out = []
    for n in names:
        if not isinstance(n, str) or not _plausible_name(n, text):
            continue
        n = n.strip()
        if n.lower() in _TOOLS:
            continue
        if plan and all(_name_re(w).search(plan) for w in n.split()):
            continue                            # a term from your own question plan, not a person
        if _llm_is_person(model, n, text):
            out.append(n)
    return out


def _llm_is_person(model, name, text):
    """Second opinion on one candidate. Errs toward masking if the check itself fails."""
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": VERIFY_SYS},
                     {"role": "user", "content": f"Sentence: {text}\nWord or phrase: {name}"}],
        "stream": False, "format": "json", "options": {"temperature": 0},
    }).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(json.load(r)["message"]["content"]).get("person", True) is not False
    except Exception:
        return True


def mask_names(text):
    for name in sorted(KNOWN_NAMES, key=len, reverse=True):     # 'Sarah Chen' before 'Sarah'
        text = _name_re(name).sub("[PERSON]", text)
    # The model sometimes flags only a first name ('Jordan' of 'Jordan Lee'). A capitalized
    # word right after a masked name is almost always the surname - mask it too, so a
    # partial detection can't leak the last name. Errs toward over-masking, never leaking.
    def _surname(m):
        w = m.group(1)
        return m.group(0) if w.lower() in _TOOLS or w in _NOT_NAMES else "[PERSON]"
    prev = None
    while prev != text:
        prev = text
        text = re.sub(r"\[PERSON\]\s+([A-Z][\w'’-]*)(?!\w)", _surname, text)
    return re.sub(r"\[PERSON\](?:\s+\[PERSON\])+", "[PERSON]", text)   # 'Sarah Chen' -> one tag


def ollama_anonymize(model, text):
    """Text with every person's name replaced by [PERSON], or None if the LLM could not
    be reached — callers must then show NOTHING rather than the raw text."""
    text = (text or "").strip()
    if not text:
        return ""
    if text not in NAMES_SEEN:
        with ANON_LLM:
            if text not in NAMES_SEEN:          # another request may have done it meanwhile
                try:
                    found = _llm_names(model, text)
                    KNOWN_NAMES.update(found)
                    NAMES_SEEN[text] = found
                except Exception as e:
                    print(f"[anon] name detection failed: {e}")
                    return None                 # not cached: retried on the next request
    return mask_names(text)


# ---- per-category summary (mind map, left of the tree) ------------------------------
SUM_SYS = (
    "You summarize what an interview candidate said about one topic. Write 1-2 short "
    "sentences in plain language, third person ('They ...'), using ONLY the excerpts given. "
    "Do not add reasons, opinions or claims that are not literally in the excerpts. Keep who "
    "did what exactly as stated: 'They' is only the candidate; anything a [PERSON] did must be "
    "credited to 'a colleague', never to the candidate. Never include people's names. "
    "Output ONLY JSON: {\"summary\": \"...\"}."
)
SUM_CACHE = {}


def ollama_summary(model, topic, texts):
    """Summary of ALREADY-ANONYMIZED excerpts; masked again on the way out as a safety net."""
    key = topic + "\x1f" + "\x1e".join(texts)
    if key in SUM_CACHE:
        return SUM_CACHE[key]
    # the small model reads plain words better than tags: '[PERSON] moved…' kept turning
    # into 'they moved…'; 'a colleague moved…' keeps who-did-what straight
    plain = [t.replace("[PERSON]", "a colleague") for t in texts]
    user = f"TOPIC: {topic}\nEXCERPTS:\n" + "\n".join(f"- {t}" for t in plain)
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SUM_SYS}, {"role": "user", "content": user}],
        "stream": False, "format": "json", "options": {"temperature": 0},
    }).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    with ANON_LLM:                                   # share the one-at-a-time LLM slot
        with urllib.request.urlopen(req, timeout=90) as r:
            summary = json.loads(json.load(r)["message"]["content"]).get("summary", "")
    summary = mask_names(summary.strip()) if isinstance(summary, str) else ""
    SUM_CACHE[key] = summary
    return summary


# ---- export (Word / PDF) ---------------------------------------------------------------
class AnonymizeFailed(Exception):
    pass


def anonymize_payload(model, d):
    """Replace every free-text field with its anonymized form. Raises AnonymizeFailed if any
    text can't be anonymized - an export asked to be anonymous must never ship a raw name."""
    texts = [s.get("text", "") for s in d.get("steps", [])]
    texts += [n.get("text", "") for n in d.get("notes", [])]
    texts += list(d.get("page_notes", []))
    for c in d.get("clips", []):
        texts += c.get("notes", [])
    for t in dict.fromkeys(t for t in texts if t):           # detect names in every text first...
        if ollama_anonymize(model, t) is None:
            raise AnonymizeFailed("could not anonymize the text (is Ollama running?) - nothing was exported")
    # ...then mask everything with the FULL set of names found, so a name first spotted in a
    # later line is also removed from earlier ones
    for s in d.get("steps", []):
        s["text"] = mask_names(s.get("text", ""))
    for n in d.get("notes", []):
        n["text"] = mask_names(n.get("text", ""))
    d["page_notes"] = [mask_names(t) for t in d.get("page_notes", [])]
    for c in d.get("clips", []):
        c["notes"] = [mask_names(t) for t in c.get("notes", [])]
    return d


def build_export(model, d):
    import docexport
    anon = bool((d.get("options") or {}).get("anonymize"))
    for s in d.get("steps", []):          # speaker: role when anonymous, else the label as diarized
        s["who"] = s.get("role") if anon else (s.get("speaker") or s.get("role"))
    if anon:
        d = anonymize_payload(model, d)
    title, meta, blocks = docexport.build_outline(d)
    if d.get("format") == "pdf":
        return docexport.render_pdf(title, meta, blocks), "pdf", "application/pdf"
    return (docexport.render_docx(title, meta, blocks), "docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")


# ---- import (question tree from a file) -----------------------------------------------
def llm_json(model, system, user):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "stream": False, "format": "json", "options": {"temperature": 0, "num_ctx": 16384},
    }).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    with ANON_LLM:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(json.load(r)["message"]["content"])


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

    def _body(self):
        """Parse a JSON request body, tolerating empty/malformed input."""
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            n = 0
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, TypeError):
            return {}

    def _after(self, url):
        try:
            return int(parse_qs(url.query).get("after", ["0"])[0])
        except (ValueError, TypeError):
            return 0

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/api/plan":
            data = self._body()
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
            data = self._body()
            try:
                info = start_pipeline(data.get("source", "sample"), data.get("device"), data.get("names"))
                return self._json({"ok": True, **info})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        if url.path == "/api/stop":
            stop_pipeline()
            return self._json({"ok": True, "running": False})
        if url.path == "/api/cues":
            data = self._body()
            q = (data.get("question") or "").strip()
            if not q:
                return self._json({"ok": False, "cues": []})
            try:
                return self._json({"ok": True, "cues": ollama_cues(self.model, q, data.get("kind", "answered"))})
            except Exception as e:
                return self._json({"ok": False, "error": str(e), "cues": []})
        if url.path == "/api/anonymize":
            # {texts:[...]} -> {texts:[anonymized or null]}; null = could not anonymize
            # safely, and the UI must then show nothing rather than the raw text.
            texts = self._body().get("texts") or []
            if not isinstance(texts, list):
                texts = []
            out = [ollama_anonymize(self.model, t) if isinstance(t, str) else None
                   for t in texts[:12]]
            return self._json({"ok": True, "texts": out})
        if url.path == "/api/export":
            data = self._body()
            try:
                blob, ext, ctype = build_export(self.model, data)
            except AnonymizeFailed as e:
                return self._json({"ok": False, "error": str(e)}, 503)
            except Exception as e:
                print(f"[export] failed: {e!r}")
                return self._json({"ok": False, "error": f"export failed: {e}"}, 500)
            slug = re.sub(r"[^A-Za-z0-9]+", "-", str(data.get("title") or "interview")).strip("-")[:60] or "interview"
            name = f"{slug}-{time.strftime('%Y-%m-%d')}.{ext}"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(blob)))
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
            self.end_headers()
            self.wfile.write(blob)
            return
        if url.path == "/api/import":
            # {name, data: base64 file} -> {name, topics:[{title, questions:[{text, followups}]}], info}
            import docimport
            data = self._body()
            try:
                raw = docimport.decode_upload(data.get("data"))
                res = docimport.build_tree(str(data.get("name") or ""), raw,
                                           lambda s, u: llm_json(self.model, s, u))
                return self._json({"ok": True, **res})
            except docimport.ImportError_ as e:
                return self._json({"ok": False, "error": str(e)}, 400)
            except Exception as e:
                print(f"[import] failed: {e!r}")
                return self._json({"ok": False, "error": f"import failed: {e}"}, 500)
        if url.path == "/api/summarize":
            # {topic, texts:[anonymized excerpts]} -> {summary}; texts must already be anonymized
            data = self._body()
            texts = [t for t in (data.get("texts") or []) if isinstance(t, str) and t.strip()][:30]
            if not texts:
                return self._json({"ok": True, "summary": ""})
            try:
                return self._json({"ok": True, "summary": ollama_summary(self.model, str(data.get("topic", "")), texts)})
            except Exception as e:
                return self._json({"ok": False, "error": str(e), "summary": None})
        self._send(404, b"not found", "text/plain")

    def do_GET(self):
        url = urlparse(self.path)

        if url.path == "/":
            if self.ui_path and os.path.exists(self.ui_path):
                with open(self.ui_path, "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            return self._send(200, b"<h1>assistant running</h1><p>no --ui set</p>", "text/html")

        if url.path == "/api/segments":
            after = self._after(url)
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
            after = self._after(url)
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
