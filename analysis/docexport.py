"""Export an interview session as a Word (.docx) or PDF document.

The canvas posts what it has (plan tree, transcript lines, recordings, notes) plus the
export settings; build_outline() turns that into one neutral outline, and render_docx()
/ render_pdf() write it out. Anonymization happens BEFORE the outline is built (see
assistant.py), so neither renderer ever sees a raw name when it is switched on.

Outline blocks (tuples):
    ("h1", text)                     section heading
    ("h2", text)                     sub-heading (a topic, a question, a recording)
    ("p", text, style)               paragraph; style: "" | "meta" | "empty" | "summary"
    ("q", depth, label, text, status, added)
                                     a planned question with its coverage status
    ("line", time, who, text, rec, tags)
                                     a transcript line; rec = inside a recorded clip
    ("quote", time, text, tags, rec) an answer quoted under its question
"""

import io
import os
from datetime import datetime

STATUS = {"green": ("answered", "4E9A6B"), "amber": ("touched", "B08A3C"), None: ("not covered", "9A9280")}
RANK = {None: 0, "red": 0, "amber": 1, "green": 2}
REC_FILL = "FBE9E6"     # light red behind recorded lines
REC_INK = "C4695A"


# --------------------------------------------------------------------------- outline
def build_outline(d):
    """d = the request payload (already anonymized if requested). Returns (title, meta, blocks)."""
    o = d.get("options", {})
    steps, clips = d.get("steps", []), d.get("clips", [])
    qlabel, qtext = d.get("qlabel", {}), d.get("qtext", {})
    mark_rec = bool(o.get("recordings"))

    def in_clip(s):
        return any(s["start"] < c["end"] and s["end"] > c["start"] for c in clips)

    def tags_for(s):
        out = []
        for qid, st in s.get("marks", []):
            if qid in qlabel and qlabel[qid] not in out:
                out.append(qlabel[qid])
        return out

    # best coverage status per question, across the whole session
    status = {}
    for s in steps:
        for qid, st in s.get("marks", []):
            if RANK.get(st, 0) > RANK.get(status.get(qid), 0):
                status[qid] = st

    title = d.get("title") or "Interview"
    meta = [f"Exported {datetime.now():%d %b %Y, %H:%M}"]
    if steps:
        meta.append(f"{len(steps)} transcript lines · {d.get('duration') or steps[-1]['time']} long · "
                    f"{len(clips)} recorded clip{'' if len(clips) == 1 else 's'}")
    else:
        meta.append("No recorded session — question plan only")
    flags = []
    if o.get("anonymize"):
        flags.append("people's names replaced with [PERSON]")
    if mark_rec and clips:
        flags.append("recorded parts marked ●")
    if flags:
        s = "; ".join(flags)
        meta.append(s[0].upper() + s[1:])       # not .capitalize(): that lower-cases [PERSON]

    blocks = []

    # 1. the question plan, with what was covered
    if o.get("questions"):
        blocks.append(("h1", "Questions"))
        for t in d.get("plan", []):
            blocks.append(("h2", f"{t['label']} · {t['text']}"))
            for q in t.get("children", []):
                blocks.append(("q", 1, q["label"], q["text"], status.get(q["id"]), q.get("added")))
                for f in q.get("children", []):
                    blocks.append(("q", 2, f["label"], f["text"], status.get(f["id"]), f.get("added")))

    # 2a. answers grouped under the question they answer
    mode = o.get("transcript", "annotated")
    if mode == "annotated" and steps:
        blocks.append(("h1", "Answers by question"))
        any_ans = False
        for t in d.get("plan", []):
            ids = []
            for q in t.get("children", []):
                ids.append(q["id"]); ids += [f["id"] for f in q.get("children", [])]
            topic_head_done = False
            for qid in ids:
                hits = [s for s in steps if any(m[0] == qid and m[1] in ("green", "amber") for m in s.get("marks", []))]
                if not hits:
                    continue
                if not topic_head_done:
                    blocks.append(("p", f"{t['label']} · {t['text']}", "topic"))
                    topic_head_done = True
                blocks.append(("h2", f"{qlabel.get(qid, '')} · {qtext.get(qid, '')}"))
                for s in hits:
                    st = next(m[1] for m in s["marks"] if m[0] == qid)
                    tg = []
                    if st == "amber":
                        tg.append("touched")
                    if qid in s.get("ahead", []):
                        tg.append("answered ahead")
                    others = [x for x in tags_for(s) if x != qlabel.get(qid)]
                    if others:
                        tg.append("also " + ", ".join(others))
                    blocks.append(("quote", s["time"], s["text"], tg, mark_rec and in_clip(s)))
                    any_ans = True
        if not any_ans:
            blocks.append(("p", "No answers were matched to the plan.", "empty"))

    # 2b. the whole script
    if mode == "full" and steps:
        blocks.append(("h1", "Transcript"))
        for s in steps:
            blocks.append(("line", s["time"], s["who"], s["text"], mark_rec and in_clip(s), tags_for(s)))

    # 3. recordings
    if mark_rec and clips:
        blocks.append(("h1", "Recorded parts"))
        for c in clips:
            head = f"● {c['time']}" + (f" · {c['reaction']}" if c.get("reaction") else "")
            blocks.append(("h2", head))
            for n in c.get("notes", []):
                blocks.append(("p", "Note: " + n, "note"))
            if mode != "full":            # the full transcript already shows these lines in place
                inside = [s for s in steps if s["start"] < c["end"] and s["end"] > c["start"]]
                for s in inside:
                    blocks.append(("line", s["time"], s["who"], s["text"], False, tags_for(s)))
                if not inside:
                    blocks.append(("p", "No transcript inside this clip.", "empty"))

    # 4. notes
    if o.get("notes"):
        tl, pn = d.get("notes", []), d.get("page_notes", [])
        clip_notes = [] if mark_rec else [(c["time"], n) for c in clips for n in c.get("notes", [])]
        if tl or pn or clip_notes:
            blocks.append(("h1", "Notes"))
            for n in tl:
                where = f" · {qlabel.get(n['qid'], '')}" if n.get("qid") in qlabel else ""
                blocks.append(("p", f"{n['time']}{where} — {n['text']}", "note"))
            for when, n in clip_notes:
                blocks.append(("p", f"Clip {when} — {n}", "note"))
            for n in pn:
                blocks.append(("p", n, "note"))

    if len(blocks) == 0:
        blocks.append(("p", "Nothing selected to export.", "empty"))
    return title, meta, blocks


# --------------------------------------------------------------------------- .docx
def render_docx(title, meta, blocks):
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH  # noqa: F401  (kept for future alignment tweaks)
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor, Cm

    doc = Document()
    for s in doc.sections:
        s.left_margin = s.right_margin = Cm(2.2)
    base = doc.styles["Normal"]
    base.font.name = "Arial"
    base.font.size = Pt(10.5)

    def color(run, hexc):
        run.font.color.rgb = RGBColor.from_string(hexc)

    def shade(par, fill):
        pPr = par._p.get_or_add_pPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), fill)
        pPr.append(shd)

    doc.add_heading(title, level=0)
    for m in meta:
        r = doc.add_paragraph().add_run(m); r.font.size = Pt(9); color(r, "6B6552")

    for b in blocks:
        kind = b[0]
        if kind == "h1":
            doc.add_heading(b[1], level=1)
        elif kind == "h2":
            doc.add_heading(b[1], level=2)
        elif kind == "p":
            p = doc.add_paragraph(); r = p.add_run(b[1])
            if b[2] in ("empty",):
                r.italic = True; color(r, "9A9280")
            elif b[2] == "topic":
                r.bold = True; r.font.size = Pt(11.5); color(r, "2E2A22")
            elif b[2] == "note":
                color(r, "6B5BB0")
        elif kind == "q":
            _, depth, label, text, st, added = b
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.6 * depth)
            p.paragraph_format.space_after = Pt(2)
            r = p.add_run(f"{label}  "); r.bold = True; r.font.size = Pt(9); color(r, "6B6552")
            p.add_run(text)
            name, hexc = STATUS.get(st, STATUS[None])
            r = p.add_run(f"   {name}"); r.font.size = Pt(8.5); color(r, hexc)
            if added:
                r = p.add_run("  · added in interview"); r.font.size = Pt(8.5); color(r, "8B5CF6")
        elif kind in ("line", "quote"):
            if kind == "line":
                _, time, who, text, rec, tags = b
            else:
                _, time, text, tags, rec = b
                who = None
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(3)
            if kind == "quote":
                p.paragraph_format.left_indent = Cm(0.6)
            if rec:
                shade(p, REC_FILL)
                r = p.add_run("● REC  "); r.bold = True; r.font.size = Pt(8); color(r, REC_INK)
            r = p.add_run(time + "  "); r.font.size = Pt(8.5); color(r, "9A9280")
            if who:
                r = p.add_run(who + ": "); r.bold = True
                color(r, "2B5FD9" if who.lower().startswith("interviewer") else "2E2A22")
            p.add_run(text)
            if tags:
                r = p.add_run("   [" + ", ".join(tags) + "]"); r.font.size = Pt(8.5); color(r, "4E9A6B")

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# --------------------------------------------------------------------------- .pdf
_FONTS = "/System/Library/Fonts/Supplemental"
_FACES = {"": "Arial.ttf", "B": "Arial Bold.ttf", "I": "Arial Italic.ttf", "BI": "Arial Bold Italic.ttf"}


def render_pdf(title, meta, blocks):
    from fpdf import FPDF

    pdf = FPDF(format="A4")
    pdf.set_margins(20, 18, 20)
    pdf.set_auto_page_break(True, 18)
    if all(os.path.exists(os.path.join(_FONTS, f)) for f in _FACES.values()):
        for style, f in _FACES.items():
            pdf.add_font("Body", style, os.path.join(_FONTS, f))
        uni = os.path.join(_FONTS, "Arial Unicode.ttf")
        if os.path.exists(uni):                  # symbols Arial lacks, e.g. the follow-up arrow ↳
            for style in _FACES:                 # one face serves every style, so bold text falls back too
                pdf.add_font("Uni", style, uni)
            pdf.set_fallback_fonts(["Uni"])
        face, clean = "Body", (lambda s: s)
    else:   # no Unicode TTF available: core font + Latin-1 only
        face = "Helvetica"
        clean = (lambda s: s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
                 .replace("–", "-").replace("—", "-").replace("●", "*").replace("·", "-").replace("…", "...")
                 .encode("latin-1", "replace").decode("latin-1"))
    pdf.add_page()
    W = pdf.w - pdf.l_margin - pdf.r_margin

    def rgb(hexc):
        return tuple(int(hexc[i:i + 2], 16) for i in (0, 2, 4))

    def text(s, size=10.5, style="", hexc="2E2A22", h=5.4, indent=0):
        pdf.set_font(face, style, size); pdf.set_text_color(*rgb(hexc))
        pdf.set_x(pdf.l_margin + indent)
        pdf.multi_cell(W - indent, h, clean(s), new_x="LMARGIN", new_y="NEXT")

    def spans(parts, indent=0, h=5.4, bar=None):
        """parts = [(text, size, style, hex)] written inline and wrapped; bar = colour of a
        left marker spanning the paragraph (recorded lines)."""
        y0, page0 = pdf.get_y(), pdf.page
        pdf.set_x(pdf.l_margin + indent)
        for s, size, style, hexc in parts:
            pdf.set_font(face, style, size); pdf.set_text_color(*rgb(hexc))
            pdf.write(h, clean(s))
        pdf.ln(h)
        if bar and pdf.page == page0:
            pdf.set_fill_color(*rgb(bar))
            pdf.rect(pdf.l_margin + indent - 3.2, y0 + 0.6, 1.2, pdf.get_y() - y0 - 1.2, style="F")
        pdf.ln(1.2)

    text(title, 20, "B", h=9)
    for m in meta:
        text(m, 9, "", "6B6552", h=4.6)
    pdf.ln(3)

    for b in blocks:
        kind = b[0]
        if kind == "h1":
            pdf.ln(4); text(b[1], 15, "B", h=8)
            pdf.set_draw_color(*rgb("CFC6AE")); pdf.line(pdf.l_margin, pdf.get_y(), pdf.l_margin + W, pdf.get_y()); pdf.ln(2)
        elif kind == "h2":
            pdf.ln(1.5); text(b[1], 11.5, "B", "2E2A22", h=6)
        elif kind == "p":
            style = {"empty": ("I", "9A9280"), "topic": ("B", "2E2A22"), "note": ("", "6B5BB0")}.get(b[2], ("", "2E2A22"))
            text(b[1], 11 if b[2] == "topic" else 10.5, style[0], style[1])
            pdf.ln(0.8)
        elif kind == "q":
            _, depth, label, qt, st, added = b
            name, hexc = STATUS.get(st, STATUS[None])
            parts = [(label + "  ", 8.5, "B", "6B6552"), (qt, 10.5, "", "2E2A22"), ("   " + name, 8.5, "", hexc)]
            if added:
                parts.append(("  · added in interview", 8.5, "", "8B5CF6"))
            spans(parts, indent=6 * depth, h=5.2)
        elif kind in ("line", "quote"):
            if kind == "line":
                _, time, who, lt, rec, tags = b
            else:
                _, time, lt, tags, rec = b
                who = None
            parts = []
            if rec:
                parts.append(("● REC  ", 8, "B", REC_INK))
            parts.append((time + "  ", 8.5, "", "9A9280"))
            if who:
                parts.append((who + ": ", 10.5, "B", "2B5FD9" if who.lower().startswith("interviewer") else "2E2A22"))
            parts.append((lt, 10.5, "", "2E2A22"))
            if tags:
                parts.append(("   [" + ", ".join(tags) + "]", 8.5, "", "4E9A6B"))
            spans(parts, indent=6 if kind == "quote" else 0, bar=REC_INK if rec else None)

    return bytes(pdf.output())
