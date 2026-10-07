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
import hmac
import ipaddress
import secrets
import socket
import atexit
import json
import os
import re
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
# Share mode (opt-in, ./start.sh --share): a second interviewer's computer may join with a code.
# Roles: "host" = this Mac without a code (full control), "viewer" = anyone presenting the code
# (watch + notes; can't start/stop/pause the recording or see other saved interviews).
SHARE = {"code": None}
HOST_ONLY_POST = {"/api/start", "/api/stop", "/api/pause", "/api/plan", "/api/session/save", "/api/shared/tree"}
SHARED_TREE = {"version": 0, "name": None, "data": None, "notes": []}   # the host's tree, for viewers
# notes and R clips both interviewers make during the current interview (upserted by uid)
SHARED_EVENTS = {"session": None, "items": []}
HOST_ONLY_GET = {"/api/sessions", "/api/session"}
SESS_DIR = os.path.join(ROOT, "sessions")                # autosaved interview sessions (gitignored)
CAPTURE = os.path.join(DIAR, "capture", "systemaudio")   # optional SCK helper (built separately)
PIPE = None                                              # pipeline Popen, or None
CAP = None                                               # capture-helper Popen, or None
PIPE_LOG = None
PIPE_INFO = {"running": False, "source": None, "off_record": False}

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

def start_pipeline(source, device, names, split=None):
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
        if source == "call" and split in ("mic", "system", "both"):
            chans += ["--split", split]       # a second interviewer: in the room / on the call
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
    PIPE_INFO.update(running=True, source=source, off_record=False)
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
    is_interviewer = speaker.startswith(interviewer)       # "Interviewer 2" asks questions too
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


_GENERIC = set("""a an the and or of to in on for with at by from as is are was were be been it its this that
these those i you we they he she my your our their me us them do does did done have has had get got make made
thing things stuff something anything work working job really just very much many some any lot lots kind sort
way ways time times about like also well good great important yes no maybe""".split())


def _cue_words(c):
    return re.findall(r"[a-z0-9']+", c.lower())


def ollama_cues(model, question, kind="answered", ctx=None):
    """Cue phrases for one planned question, using its context so the cues mean what the
    question means here and don't overlap the questions around it.
    kind='answered': what a real ANSWER would contain (not the question's own words - the
    interviewer says those when asking). kind='asking': how an interviewer would phrase it.
    ctx: {interview, topic, parent, siblings: [...]}."""
    ctx = ctx or {}
    lines = []
    if ctx.get("interview"):
        lines.append(f"INTERVIEW: {ctx['interview']}")
    if ctx.get("topic"):
        lines.append(f"TOPIC: {ctx['topic']}")
    if ctx.get("parent"):
        lines.append(f"THIS IS A FOLLOW-UP TO: {ctx['parent']}")
    lines.append(f"QUESTION: {question}")
    sibs = [x for x in (ctx.get("siblings") or []) if isinstance(x, str) and x.strip()][:10]
    if sibs:
        lines.append("OTHER QUESTIONS NEARBY (your cues must NOT fit these):\n" + "\n".join(f"- {x}" for x in sibs))
    context = "\n".join(lines)
    if kind == "asking":
        task = ("List 5 ways the INTERVIEWER might actually phrase or lead into THIS question in a "
                "real conversation: natural paraphrases and its key phrases. Rules: 2-6 words each, "
                "lowercase; specific to this question (a phrase that would also fit the nearby "
                "questions is useless); no generic filler like 'tell me more' or 'at work'.")
    else:
        task = ("List 6 cues that the CANDIDATE's reply would contain if it truly answers THIS "
                "question, read in its context above: concrete things, examples, numbers or "
                "domain terms they would mention, or short answer-shaped phrases (e.g. 'about "
                "five people', 'hand it to engineering'). Rules: 1-4 words each, lowercase; do "
                "NOT just repeat words of the question (the interviewer says those when asking); "
                "no generic words (team, work, process, thing); each cue should point to THIS "
                "question rather than the nearby ones.")
    prompt = (context + "\n\n" + task + "\nReturn ONLY JSON: {\"cues\": [\"...\"]}")
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}],
                       "stream": False, "format": "json", "options": {"temperature": 0.2}}).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    try:
        raw = json.loads(out["message"]["content"]).get("cues", [])
    except Exception:
        return []
    q_words = set(_cue_words(question))
    sib_text = " " + " ".join(sibs).lower() + " "
    seen, cues = set(), []
    for c in raw if isinstance(raw, list) else []:
        c = re.sub(r"\s+", " ", str(c).strip().lower().strip(".,;:!?\"'"))
        words = _cue_words(c)
        if not c or c in seen or not words or len(words) > 6:
            continue
        content = [w for w in words if w not in _GENERIC]
        if not content:                                          # nothing but filler
            continue
        if kind == "answered" and all(w in q_words for w in content):
            continue                                             # just the question's own words
        if sibs and f" {c} " in sib_text:                        # literally a nearby question's phrase
            continue
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


# ---- interview sessions: autosave log + reopen ---------------------------------------
def _sess_id(raw):
    sid = re.sub(r"[^A-Za-z0-9_-]", "", str(raw or ""))[:64]
    if not sid:
        raise ValueError("bad session id")
    return sid


def save_session(db, sid, data):
    """Write sessions/<sid>.json atomically. The transcript as the server holds it (the
    SQLite segments of the pipeline session) is stored alongside the canvas's own state."""
    os.makedirs(SESS_DIR, exist_ok=True)
    data["saved_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    try:
        conn = read_only(db)
        try:
            if data.get("session_id") and data["session_id"] == latest_session(conn):
                rows = conn.execute("SELECT id, t_start, t_end, speaker, text FROM segments "
                                    "WHERE session_id=? ORDER BY id", (data["session_id"],)).fetchall()
                data["server_segments"] = [dict(zip(("id", "t_start", "t_end", "speaker", "text"), r)) for r in rows]
        finally:
            conn.close()
    except sqlite3.Error:
        pass
    path = os.path.join(SESS_DIR, sid + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)
    return data["saved_at"]


def list_sessions():
    out = []
    if not os.path.isdir(SESS_DIR):
        return out
    for fn in os.listdir(SESS_DIR):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(SESS_DIR, fn)) as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        out.append({"id": fn[:-5], "name": (d.get("tree") or {}).get("name") or "Interview",
                    "saved_at": d.get("saved_at"), "src": d.get("src"),
                    "session_id": d.get("session_id"), "lines": len(d.get("steps") or []),
                    "duration": d.get("duration"), "clips": len(d.get("clips") or [])})
    out.sort(key=lambda x: x.get("saved_at") or "", reverse=True)
    return out


# ---- who's who: display names for the speakers of the current interview -------------------
# The pipeline labels people by where they were heard: Interviewer (mic), Interviewer 2 (a
# second voice on the mic), Candidate (the call), or Remote 1 / Remote 2 when the call side is
# split. Remote voices get roles here: the one who talks the MOST is the candidate, the others
# are interviewers. Anything the user sets in the app (/api/speakers) wins.
SPEAKER_OVERRIDES = {"session": None, "map": {}}


def speaker_map(conn, session):
    rows = conn.execute("SELECT speaker, SUM(t_end - t_start), MIN(id) FROM segments "
                        "WHERE session_id=? GROUP BY speaker", (session,)).fetchall()
    talk = {r[0]: r[1] or 0.0 for r in rows}
    first = {r[0]: r[2] for r in rows}
    m = {sp: sp for sp in talk}
    remotes = [sp for sp in talk if sp.startswith("Remote ")]
    if remotes:
        cand = max(remotes, key=lambda sp: talk[sp])
        m[cand] = "Candidate"
        # continue after the highest-numbered interviewer on the mic ("Interviewer" = 1). At least
        # 1: whoever runs this Mac is Interviewer 1 even before they've said anything
        nums = [int(m.group(1)) if m.group(1) else 1
                for m in (re.match(r"Interviewer(?: (\d+))?$", sp) for sp in talk) if m]
        n = max([1] + nums)
        for sp in sorted((r for r in remotes if r != cand), key=lambda sp: first[sp]):
            n += 1
            m[sp] = f"Interviewer {n}"
    with LOCK:
        if SPEAKER_OVERRIDES["session"] == session:
            m.update(SPEAKER_OVERRIDES["map"])
    return m, talk


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
            names, _ = speaker_map(conn, session) if rows else ({}, {})
        finally:
            conn.close()
        for seg_id, raw, text in rows:
            speaker = names.get(raw, raw)
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

    def _send(self, code, body, ctype, headers=None):
        # No Access-Control-Allow-Origin: the app is served from this same server, and a
        # wildcard would let ANY website open in your browser read the transcripts here.
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _current_session(self):
        try:
            conn = read_only(self.db_path)
            try:
                return latest_session(conn)
            finally:
                conn.close()
        except sqlite3.Error:
            return None

    def _cookie(self, name):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return None

    def _host_ok(self):
        """Refuse requests addressed to some other hostname (DNS-rebinding defence): only
        localhost, a raw IP address, or this Mac's own .local name."""
        host = (self.headers.get("Host") or "").strip().lower()
        host = host[1:host.index("]")] if host.startswith("[") and "]" in host else host.rsplit(":", 1)[0]
        if host in ("localhost", "127.0.0.1", "::1", MY_LOCAL_NAME):
            return True
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            return False

    def _role(self, url):
        code = SHARE["code"]
        given = parse_qs(url.query).get("join", [None])[0] or self._cookie("fn_join")
        if code and given and hmac.compare_digest(str(given), code):
            return "viewer"
        if self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            return "host"
        return None

    def _gate(self, url, method):
        """-> role, or None after sending a refusal."""
        if not self._host_ok():
            self._send(403, b"forbidden host", "text/plain")
            return None
        role = self._role(url)
        if role is None:
            if url.path == "/":
                self._send(403, "<h1>Fieldnotes</h1><p>Ask the interviewer for the join link.</p>",
                           "text/html; charset=utf-8")
            else:
                self._json({"ok": False, "error": "join code required"}, 403)
            return None
        if role == "viewer" and url.path in (HOST_ONLY_POST if method == "POST" else HOST_ONLY_GET):
            self._json({"ok": False, "error": "only the recording computer can do that"}, 403)
            return None
        return role

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
        role = self._gate(url, "POST")
        if not role:
            return
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
                info = start_pipeline(data.get("source", "sample"), data.get("device"), data.get("names"),
                                      data.get("split"))
                return self._json({"ok": True, **info})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        if url.path == "/api/pause":
            # {on: true} = off the record (the pipeline turns incoming audio into silence)
            on = bool(self._body().get("on"))
            if PIPE is None or PIPE.poll() is not None:
                return self._json({"ok": False, "error": "no interview running"}, 409)
            os.kill(PIPE.pid, signal.SIGUSR1 if on else signal.SIGUSR2)
            PIPE_INFO["off_record"] = on
            return self._json({"ok": True, "off_record": on})
        if url.path == "/api/stop":
            stop_pipeline()
            return self._json({"ok": True, "running": False})
        if url.path == "/api/cues":
            data = self._body()
            q = (data.get("question") or "").strip()
            if not q:
                return self._json({"ok": False, "cues": []})
            try:
                ctx = data.get("context") if isinstance(data.get("context"), dict) else None
                return self._json({"ok": True, "cues": ollama_cues(self.model, q, data.get("kind", "answered"), ctx)})
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
        if url.path == "/api/speakers":
            # {raw: "Remote 2", name: "Candidate"} -> override for the current interview
            data = self._body()
            raw, name = str(data.get("raw") or ""), str(data.get("name") or "").strip()[:40]
            try:
                conn = read_only(self.db_path)
                try:
                    session = latest_session(conn)
                finally:
                    conn.close()
            except sqlite3.Error:
                session = None
            if not raw or not session:
                return self._json({"ok": False, "error": "no interview / speaker"}, 400)
            with LOCK:
                if SPEAKER_OVERRIDES["session"] != session:
                    SPEAKER_OVERRIDES.update(session=session, map={})
                if name:
                    SPEAKER_OVERRIDES["map"][raw] = name
                else:
                    SPEAKER_OVERRIDES["map"].pop(raw, None)
            return self._json({"ok": True})
        if url.path == "/api/shared/event":
            # {kind: "clip"|"note", uid, data} from either interviewer, for the other to pick up
            data = self._body()
            kind, uid = data.get("kind"), str(data.get("uid") or "")[:40]
            if kind not in ("clip", "note", "question") or not uid or not isinstance(data.get("data"), dict):
                return self._json({"ok": False, "error": "bad event"}, 400)
            session = self._current_session()
            with LOCK:
                if SHARED_EVENTS["session"] != session:
                    SHARED_EVENTS.update(session=session, items=[])
                items = SHARED_EVENTS["items"]
                nid = items[-1]["id"] + 1 if items else 1        # monotonic, even after trimming
                items.append({"id": nid, "kind": kind, "uid": uid, "from": role, "data": data["data"]})
                if len(items) > 2000:
                    del items[: len(items) - 2000]
            return self._json({"ok": True})
        if url.path == "/api/shared/tree":
            # the recording computer publishes the tree it is interviewing from
            data = self._body()
            if not isinstance(data.get("data"), str):
                return self._json({"ok": False, "error": "no tree"}, 400)
            with LOCK:
                if data["data"] != SHARED_TREE["data"] or data.get("name") != SHARED_TREE["name"]:
                    SHARED_TREE.update(version=SHARED_TREE["version"] + 1, name=str(data.get("name") or "Interview"),
                                       data=data["data"], notes=data.get("notes") or [])
                v = SHARED_TREE["version"]
            return self._json({"ok": True, "version": v})
        if url.path == "/api/session/save":
            data = self._body()
            try:
                sid = _sess_id(data.get("id"))
                saved = save_session(self.db_path, sid, data.get("data") or {})
                return self._json({"ok": True, "id": sid, "saved_at": saved})
            except ValueError as e:
                return self._json({"ok": False, "error": str(e)}, 400)
            except OSError as e:
                return self._json({"ok": False, "error": f"could not save: {e}"}, 500)
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
        role = self._gate(url, "GET")
        if not role:
            return

        if url.path == "/":
            if self.ui_path and os.path.exists(self.ui_path):
                with open(self.ui_path, "rb") as f:
                    headers = {}
                    if role == "viewer" and parse_qs(url.query).get("join"):   # remember the code
                        headers["Set-Cookie"] = f"fn_join={SHARE['code']}; Path=/; SameSite=Strict; Max-Age=43200"
                    return self._send(200, f.read(), "text/html; charset=utf-8", headers)
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
                names, talk = speaker_map(conn, session)
            finally:
                conn.close()
            return self._json({"session": session, "waiting": False,
                "speakers": [{"raw": raw, "name": names[raw], "seconds": round(talk[raw], 1)} for raw in talk],
                "segments": [{"id": r[0], "t_start": r[1], "t_end": r[2], "speaker": names.get(r[3], r[3]),
                              "raw": r[3], "text": r[4]} for r in rows]})

        if url.path == "/api/coverage":
            after = self._after(url)
            with LOCK:
                events = [e for e in COVERAGE if e["id"] > after]
                has_plan = bool(PLAN["by_id"])
                session = STATE["session"]          # which interview these events belong to
            return self._json({"has_plan": has_plan, "session": session, "events": events})

        if url.path == "/api/sessions":
            return self._json({"ok": True, "sessions": list_sessions()})
        if url.path == "/api/session":
            try:
                sid = _sess_id(parse_qs(url.query).get("id", [""])[0])
                with open(os.path.join(SESS_DIR, sid + ".json")) as f:
                    return self._json({"ok": True, "data": json.load(f)})
            except (ValueError, OSError) as e:
                return self._json({"ok": False, "error": f"no such session ({e})"}, 404)
        if url.path == "/api/shared/events":
            after, session = self._after(url), self._current_session()
            with LOCK:
                if SHARED_EVENTS["session"] != session:
                    SHARED_EVENTS.update(session=session, items=[])
                evs = [e for e in SHARED_EVENTS["items"] if e["id"] > after]
            return self._json({"session": session, "events": evs})
        if url.path == "/api/shared/tree":
            with LOCK:
                t = dict(SHARED_TREE)
            return self._json({"ok": t["data"] is not None, **t})
        if url.path == "/api/whoami":
            return self._json({"role": role, "share": bool(SHARE["code"])})
        if url.path == "/api/status":
            running = bool(PIPE and PIPE.poll() is None)
            if not running and PIPE_INFO["running"]:
                PIPE_INFO.update(running=False, source=None, off_record=False)
            return self._json({"running": running, "source": PIPE_INFO["source"],
                               "off_record": running and PIPE_INFO["off_record"]})

        self._send(404, b"not found", "text/plain")

    def log_message(self, *a):
        pass


def lan_ip():
    """This Mac's address on the local network (no packet is sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


MY_LOCAL_NAME = (socket.gethostname() or "").lower()
if MY_LOCAL_NAME and not MY_LOCAL_NAME.endswith(".local"):
    MY_LOCAL_NAME += ".local"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=DB_DEFAULT)
    p.add_argument("--ui", default=UI_DEFAULT)
    p.add_argument("--model", default="llama3.2:3b")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--share", action="store_true",
                   help="let a second interviewer's computer join with a code (listens on the network)")
    p.add_argument("--bind", default=None,
                   help="address to listen on (default 127.0.0.1; 0.0.0.0 with --share)")
    args = p.parse_args()
    bind = args.bind or ("0.0.0.0" if args.share else "127.0.0.1")
    if args.share:
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"          # no 0/O, 1/I lookalikes
        SHARE["code"] = "".join(secrets.choice(alphabet) for _ in range(6))

    Handler.db_path = args.db
    Handler.ui_path = args.ui
    Handler.model = args.model
    threading.Thread(target=worker, args=(args.db, args.model), daemon=True).start()
    srv = ThreadingHTTPServer((bind, args.port), Handler)
    print(f"assistant:   http://localhost:{args.port}")
    if SHARE["code"]:
        print(f"SHARING:     second interviewer opens  http://{lan_ip()}:{args.port}/?join={SHARE['code']}")
        print(f"             (same Wi-Fi / Tailscale; join code {SHARE['code']}; ctrl-c ends sharing)")
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
