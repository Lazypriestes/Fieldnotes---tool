  // 03-mindmap.js — Anonymization queue and the mind map (interview debrief). All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ---------- mind map cards: recordings + notes, names anonymized ----------
     The mind map never renders raw transcript text. Every string goes through anonText():
     undefined = still anonymizing, null = could not anonymize (shown as hidden). */
  var ANON = {}, ANON_FAILED = {}, anonQueue = [], anonBusy = false;
  function anonText(t) {
    t = (t || '').trim();
    if (!t) return '';
    if (Object.prototype.hasOwnProperty.call(ANON, t)) return ANON[t];
    if (ANON_FAILED[t] && Date.now() - ANON_FAILED[t] < 15000) return null;   // retry after 15 s
    if (anonQueue.indexOf(t) < 0) anonQueue.push(t);
    pumpAnon();
    return undefined;
  }
  function pumpAnon() {
    if (anonBusy || !anonQueue.length) return;
    anonBusy = true;
    var batch = anonQueue.splice(0, 6);
    fetch(API + '/api/anonymize', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: batch }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        batch.forEach(function (t, i) {
          var v = d && d.texts ? d.texts[i] : null;
          if (typeof v === 'string') { ANON[t] = v; delete ANON_FAILED[t]; } else ANON_FAILED[t] = Date.now();
        });
      })
      .catch(function () { batch.forEach(function (t) { ANON_FAILED[t] = Date.now(); }); })
      .then(function () {
        anonBusy = false;
        if (layerName === 'mindmap') { renderMindmapCards(); drawInspector(); }
        pumpAnon();
      });
  }
  function anonHTML(t) {
    var v = anonText(t);
    if (v === undefined) return '<span class="pending">anonymizing…</span>';
    if (v === null) return '<span class="empty">hidden — couldn’t anonymize (is Ollama running?)</span>';
    return esc(v);
  }

  // Stopping a session wipes the live state, so keep the last one for the mind map.
  var MM_LAST = null, mmSig = '';
  function mmSnapshot() {
    return { steps: STEPS.slice(0, liveIdx + 1), cum: cumEnd.slice(0, liveIdx + 1), lastIdx: liveIdx,
             clips: redSpans.slice(), marks: userMarks.slice(), tbase: TBASE, state: Object.assign({}, state) };
  }
  function mmSession() {
    if (live) return { steps: STEPS, cum: cumEnd, lastIdx: liveIdx, clips: redSpans, marks: userMarks, tbase: TBASE, state: state };
    return MM_LAST;
  }
  function mmStepWin(sess, i) {
    var e = sess.steps[i], end = sess.cum[i];
    var start = e.tStart != null ? e.tStart * 1000 : (i ? sess.cum[i - 1] : 0);
    return [start, end];
  }
  function mmIsInterviewer(e) { return !!e.a || e.w === I || isInterviewerName(e.w); }
  // "Interviewer", "Interviewer 2", "Interviewer 2 (Anna)" are all interviewers
  function isInterviewerName(w) { return typeof w === 'string' && w.indexOf(LIVE.interviewer) === 0; }
  // The server can re-decide who's who as the interview goes on (the remote voice that talks
  // most is the candidate) or when you rename someone; relabel lines already on screen.
  function applySpeakerNames(list) {
    var map = {}, changed = false;
    list.forEach(function (sp) { map[sp.raw] = sp.name; });
    LIVE.speakers = list;
    var sb = $('spkBtn'); if (sb) sb.hidden = list.length < 2;
    if (!$('spkPop').hidden) renderSpeakers();
    STEPS.forEach(function (e) {
      var nm = e.raw && map[e.raw];
      if (nm && nm !== e.w) { e.w = nm; e.a = isInterviewerName(nm); changed = true; }
    });
    if (changed && liveIdx >= 0) rebuildTo(reviewing ? viewIdx : liveIdx, false);
  }
  // readable question label: follow-ups are just '↳', so name them by their parent ('Q4.2 ↳')
  function mmQLabel(q) {
    if (!q) return '';
    if (q.label === '↳' && q.parent && q.parent.label) return q.parent.label + ' ↳';
    return q.kind === 'opener' ? 'OPENER' : (q.label || '');
  }
  function mmVisibleAnchor(id) {            // the question itself, or its nearest visible parent
    var n = INDEX[id];
    while (n && n !== ROOT && isHidden(n)) n = n.parent;
    return (n && n !== ROOT) ? n : topics()[0];
  }
  // the question a moment relates to: what was being asked at step i (or before)
  function mmCurAt(sess, i) {
    for (var k = Math.min(i, sess.lastIdx); k >= 0; k--) if (sess.steps[k] && sess.steps[k].cur) return sess.steps[k].cur;
    return null;
  }
  function mmSignature(sess) {
    var s = (dbOpen || '') + '|' + pageNotes.length;
    pageNotes.forEach(function (n) { s += '|' + (n.text || '').length + ':' + n.links.length; });
    if (!sess) return s + '|none';
    var annos = 0;
    for (var i = 0; i <= sess.lastIdx; i++) {
      var st = sess.steps[i]; if (st) annos += (st.anno || st.mark || []).length;
    }
    s += '|' + sess.lastIdx + '|' + annos + '|' + sess.clips.length + '|' + sess.marks.length;
    sess.clips.forEach(function (c) { s += '|' + (c.reaction || 0) + ':' + (c.notes ? c.notes.length : 0); });
    sess.marks.forEach(function (m) { s += '|' + m.text.length; });
    return s;
  }
  function mmMaybeRefresh() {               // cheap; called from updateTL on every live update
    if (layerName !== 'mindmap') return;
    var sig = mmSignature(mmSession());
    if (sig !== mmSig) renderMindmapCards();
  }

  /* ---------- mind map = the interview debrief ----------
     One job: what did we learn, per topic? A hub in the middle (overall coverage) and one card
     per topic around it: an AI summary of its answers and how many questions were answered.
     Click a topic to open it: its answers as short quotes under each question, the questions
     still open, its clips (with their script) and notes. One topic is open at a time. Every
     string from the interview is anonymized; clicking a question jumps to it on the tree. */
  var SUMS = {}, SUM_LAST = {}, sumQueue = [], sumBusy = false;
  function summaryFor(cat) {
    // undefined = working on it; null = unavailable; string = the summary
    var anon = cat.answers.map(function (a) { return anonText(a.text); });
    if (anon.some(function (v) { return v === undefined; })) return undefined;
    var texts = anon.filter(function (v) { return typeof v === 'string' && v; });
    if (!texts.length) return null;
    var key = cat.topic.id + '\x1f' + texts.join('\x1e');
    if (Object.prototype.hasOwnProperty.call(SUMS, key)) return SUMS[key];
    if (!sumQueue.some(function (q) { return q.key === key; }))
      sumQueue.push({ key: key, topicId: cat.topic.id, topic: cat.topic.text, texts: texts });
    pumpSum();
    return undefined;
  }
  function pumpSum() {
    if (sumBusy || !sumQueue.length) return;
    sumBusy = true;
    var job = sumQueue.shift();
    fetch(API + '/api/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: job.topic, texts: job.texts }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { SUMS[job.key] = (d && typeof d.summary === 'string') ? d.summary : null; })
      .catch(function () { SUMS[job.key] = null; })
      .then(function () {
        if (typeof SUMS[job.key] === 'string') SUM_LAST[job.topicId] = SUMS[job.key];
        sumBusy = false;
        if (layerName === 'mindmap') renderMindmapCards();
        pumpSum();
      });
  }

  var dbOpen = null, dbScript = {}, dbEl = null, dbFlip = null, dbNotesOpen = {};
  // free roam: drag empty space (or scroll) to pan, ⌥/⌘-scroll to zoom, F brings it back
  var DBV = { x: 0, y: 0, z: 1 }, dbPan = null, dbJustPanned = 0;
  function dbApplyView() {
    var w = dbEl && dbEl.querySelector('.db-wrap'); if (!w) return;
    w.style.transform = 'translate(' + DBV.x + 'px,' + DBV.y + 'px) scale(' + DBV.z + ')';
    moving(w, 160);
  }
  var dbViewAnim = null;
  function dbAnimateView(to) {
    if (dbViewAnim) { dbViewAnim.stop(); dbViewAnim = null; }      // a new glide replaces the old one
    if (!MO || REDUCED) { DBV = to; dbApplyView(); return; }
    var from = { x: DBV.x, y: DBV.y, z: DBV.z };
    dbViewAnim = MO.animate(0, 1, { type: 'spring', visualDuration: 0.4, bounce: 0.1, onUpdate: function (k) {
      DBV = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k };
      dbApplyView();
    } });
  }
  function dbRecenter() { dbAnimateView({ x: 0, y: 0, z: 1 }); }
  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || !e.target.closest || !e.target.closest('.debrief')) return;
    if (e.target.closest('.db-card,.db-hub,button')) return;          // cards keep their clicks
    if (dbViewAnim) { dbViewAnim.stop(); dbViewAnim = null; }
    dbPan = { sx: e.clientX, sy: e.clientY, x: DBV.x, y: DBV.y, moved: false };
    dbEl.classList.add('panning');
  });
  document.addEventListener('pointermove', function (e) {
    if (!dbPan) return;
    var dx = e.clientX - dbPan.sx, dy = e.clientY - dbPan.sy;
    if (!dbPan.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    dbPan.moved = true;
    DBV.x = dbPan.x + dx; DBV.y = dbPan.y + dy; dbApplyView();
  });
  document.addEventListener('pointerup', function () {
    if (!dbPan) return;
    if (dbPan.moved) dbJustPanned = Date.now();
    dbPan = null; dbEl.classList.remove('panning');
  });
  function dbWheel(e) {
    e.preventDefault();
    if (dbViewAnim) { dbViewAnim.stop(); dbViewAnim = null; }
    if (e.ctrlKey || e.metaKey || e.altKey) {          // zoom around the cursor
      var w = dbEl.querySelector('.db-wrap'), r = dbEl.getBoundingClientRect();
      var nz = clamp(DBV.z * Math.pow(0.995, e.deltaY), 0.35, 1.8);
      var ox = w.offsetLeft, oy = w.offsetTop, cx = e.clientX - r.left - dbEl.clientLeft, cy = e.clientY - r.top - dbEl.clientTop;
      DBV.x = cx - ox - (cx - ox - DBV.x) * (nz / DBV.z);
      DBV.y = cy - oy - (cy - oy - DBV.y) * (nz / DBV.z);
      DBV.z = nz;
    } else { DBV.x -= e.deltaX; DBV.y -= e.deltaY; }
    dbApplyView();
  }
  // a small "✎ 2" pill on a question: its notes stay folded away until you open them
  function dbNoteBtn(key, n, what) {
    var on = !!dbNotesOpen[key];
    return '<button class="db-nt" data-dbnotes="' + key + '" aria-expanded="' + on + '" title="' + (on ? 'Hide' : 'Show') + ' notes">✎ ' + n +
      (what ? ' ' + (n === 1 ? 'note' : 'notes') + ' ' + what : '') + '</button>';
  }
  function dbClipBtn(key, n) {
    var k = 'c:' + key, on = !!dbNotesOpen[k];
    return '<button class="db-nt clip" data-dbnotes="' + k + '" aria-expanded="' + on + '" title="' + (on ? 'Hide' : 'Show') + ' recorded ' + (n === 1 ? 'part' : 'parts') + '">● ' + n + '</button>';
  }
  function dbClipList(key, clips, sess) {
    return '<div class="db-clips" data-notesfor="c:' + key + '">' + clips.map(function (x) { return dbClipHTML(x, sess); }).join('') + '</div>';
  }
  function dbRecEnd(x, sess) {                    // one line: the time, its reaction, Script
    var c = x.c, key = 'c' + Math.round(c.startMs) + '-' + Math.round(c.endMs);
    var rx = c.reaction ? reactMeta(c.reaction) : null;
    var h = '<div class="db-recend"><span>● Recorded ' + fmtTime(sess.tbase + c.startMs / 1000) + '–' + fmtTime(sess.tbase + c.endMs / 1000) +
      (rx ? ' <span style="color:' + reactColor(c.reaction) + '" title="' + rx.l + '">' + rx.g + '</span>' : '') + '</span>' +
      (x.inWin.length ? '<button class="sc" data-dbscript="' + key + '" aria-expanded="' + !!dbScript[key] + '">' + (dbScript[key] ? 'Hide script' : 'Script') + '</button>' : '') + '</div>' +
      (c.notes || []).map(function (nt) { return '<div class="db-recnote">✎ ' + anonHTML(nt) + '</div>'; }).join('');
    if (dbScript[key]) h += '<div class="db-script db-recscript">' + x.inWin.map(function (i) {
      var e = sess.steps[i], isInt = mmIsInterviewer(e);
      return '<div class="sl' + (isInt ? ' int' : '') + '"><span class="sw">' + (isInt ? 'Interviewer' : 'Candidate') + '</span>' + anonHTML(e.t) + '</div>';
    }).join('') + '</div>';
    return h;
  }
  function dbClipHTML(x, sess) {
    var c = x.c, key = 'c' + Math.round(c.startMs) + '-' + Math.round(c.endMs);
    var when = fmtTime(sess.tbase + c.startMs / 1000) + '–' + fmtTime(sess.tbase + c.endMs / 1000);
    var rx = c.reaction ? reactMeta(c.reaction) : null;
    var h = '<div class="db-clip"><div class="ch"><span class="rc">●</span> Recorded ' + when +
      (rx ? ' <span style="color:' + reactColor(c.reaction) + '" title="' + rx.l + '">' + rx.g + ' ' + rx.l + '</span>' : '') +
      (x.inWin.length ? '<button class="sc" data-dbscript="' + key + '">' + (dbScript[key] ? 'Hide script' : 'Script') + '</button>' : '') + '</div>' +
      (c.notes || []).map(function (nt) { return '<div class="cn">✎ ' + anonHTML(nt) + '</div>'; }).join('');
    if (dbScript[key]) h += '<div class="db-script">' + x.inWin.map(function (i) {
      var e = sess.steps[i], isInt = mmIsInterviewer(e);
      return '<div class="sl' + (isInt ? ' int' : '') + '"><span class="sw">' + (isInt ? 'Interviewer' : 'Candidate') + '</span>' + anonHTML(e.t) + '</div>';
    }).join('') + '</div>';
    return h + '</div>';
  }
  function dbNoteList(key, list) {
    return '<div class="db-notes" data-notesfor="' + key + '">' + list.map(function (nt) {
      return '<div class="db-note">' + anonHTML(nt.text) + (nt.when ? '<span class="when">' + nt.when + '</span>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function dbData(sess) {
    // notes hang on the question they were taken at (or linked to): d.qnotes[questionId] = [...]
    var list = topics().map(function (t) { return { t: t, answers: [], clips: [], qclips: {}, qnotes: {}, nNotes: 0 }; });
    var byId = {}, loose = [];
    list.forEach(function (d) { byId[d.t.id] = d; });
    function dOf(qid) { var q = INDEX[qid], t = q && topicOf(q); return t ? byId[t.id] : null; }
    if (sess) {
      for (var i = 0; i <= sess.lastIdx; i++) {
        var st = sess.steps[i]; if (!st) continue;
        // live lines carry .anno; the ▶ demo script carries .mark ([id, status]) instead
        var al = st.anno || (st.mark || []).filter(function (m) { return m[1] !== 'ask'; })
          .map(function (m) { return { id: m[0], kind: 'answer' }; });
        al.forEach(function (a) {
          var d = dOf(a.id); if (!d) return;
          if (d.answers.some(function (x) { return x.qid === a.id && x.i === i; })) return;
          d.answers.push({ qid: a.id, i: i, text: st.t, ahead: a.kind === 'ahead' });
        });
      }
      sess.clips.forEach(function (c) {
        var inWin = [], first = null;
        for (var i = 0; i <= sess.lastIdx; i++) {
          var w = mmStepWin(sess, i);
          if (w[0] < c.endMs && w[1] > c.startMs) {
            inWin.push(i);
            var e = sess.steps[i], al = e.anno || (e.mark || []).map(function (m) { return { id: m[0] }; });
            if (!first && al.length) first = al[0].id;
          }
        }
        var qid = first || mmCurAt(sess, inWin.length ? inWin[inWin.length - 1] : 0), d = dOf(qid);
        if (d) { var x = { c: c, inWin: inWin }; d.clips.push(x); (d.qclips[qid] = d.qclips[qid] || []).push(x); }
      });
      sess.marks.forEach(function (m) {
        if (m.q) return;                    // added questions are real questions in the tree already
        var qid = m.host || mmCurAt(sess, m.idx), d = dOf(qid);
        var nt = { text: m.text, when: fmtTime(sess.tbase + (sess.cum[m.idx] || 0) / 1000) };
        if (d) { (d.qnotes[qid] = d.qnotes[qid] || []).push(nt); d.nNotes++; } else loose.push(nt);
      });
    }
    pageNotes.forEach(function (n) {
      if (!(n.text || '').trim() || (n.live && sess)) return;   // live dots are the timeline notes again
      var d = null, qid = null;
      n.links.some(function (l) { d = dOf(l); qid = l; return !!d; });
      if (d) { (d.qnotes[qid] = d.qnotes[qid] || []).push({ text: n.text }); d.nNotes++; } else loose.push({ text: n.text });
    });
    return { topics: list, loose: loose };
  }
  function dbState(sess) { return (sess && sess.state) || state; }   // coverage survives stopping
  // count chips in the colours the rest of the app uses: clips red, notes purple, added questions green dashed
  function dbChips(nAns, nClips, nNotes, nAdded) {
    var c = [];
    if (nAns) c.push('<span class="db-chip">' + nAns + (nAns === 1 ? ' answer' : ' answers') + '</span>');
    if (nClips) c.push('<span class="db-chip clip">● ' + nClips + ' recorded</span>');
    if (nNotes) c.push('<span class="db-chip note">✎ ' + nNotes + (nNotes === 1 ? ' note' : ' notes') + '</span>');
    if (nAdded) c.push('<span class="db-chip add">+ ' + nAdded + ' added</span>');
    return c.join('');
  }
  function dbStatus(t, sess) {
    var g = 0, a = 0, st = dbState(sess);
    t.qs.forEach(function (q) { if (st[q.id] === 'green') g++; else if (st[q.id] === 'amber') a++; });
    return { g: g, a: a, n: t.qs.length };
  }
  function dbCard(d, sess) {
    var t = d.t, s = dbStatus(t, sess), open = dbOpen === t.id;
    var steps = [], seen = {};
    d.answers.forEach(function (a) { if (!seen[a.i]) { seen[a.i] = 1; steps.push(a); } });
    var sum;
    if (!steps.length) sum = '<span class="empty">' + (sess ? 'Not reached yet' : 'No interview yet') + '</span>';
    else {
      var v = summaryFor({ topic: t, answers: steps });
      sum = typeof v === 'string' ? esc(v)
        : v === null ? '<span class="empty">Summary unavailable. Open the topic to read the answers.</span>'
        : (SUM_LAST[t.id] ? esc(SUM_LAST[t.id]) + ' <span class="pending">updating…</span>' : '<span class="pending">Summarizing…</span>');
    }
    var nNotes = d.nNotes, nAdded = subtree(t).filter(function (n) { return n.added; }).length;
    var meta = dbChips(steps.length, d.clips.length, nNotes, nAdded);
    var h = '<div class="db-card' + (open ? ' open' : '') + (steps.length ? '' : ' quiet') + '" data-topic="' + t.id + '">' +
      '<button class="db-hd" data-dbtoggle="' + t.id + '" aria-expanded="' + open + '">' +
      '<span class="num">T' + t.n + '</span><span class="tt">' + esc(t.text) + '</span>' +
      '<span class="cnt">' + (s.n ? s.g + '/' + s.n : '') + '</span><span class="chev">' + (open ? '−' : '+') + '</span></button>' +
      '<div class="db-bar"><i style="width:' + (s.n ? s.g / s.n * 100 : 0) + '%;background:var(--green)"></i>' +
      '<i style="width:' + (s.n ? s.a / s.n * 100 : 0) + '%;background:var(--amber)"></i></div>' +
      '<div class="db-sum">' + sum + '</div>' +
      (meta ? '<div class="db-meta">' + meta + '</div>' : '');
    if (open) h += '<div class="db-body">' + dbBody(d, sess) + '</div>';
    return h + '</div>';
  }
  function dbBody(d, sess) {
    var t = d.t, h = '', byQ = {};
    d.answers.forEach(function (a) { (byQ[a.qid] = byQ[a.qid] || []).push(a); });
    var qsAll = subtree(t).filter(function (n) { return n !== t; }), open = [];
    // one reply can answer several questions: show it once, under the first of them, and
    // name the others on it, instead of repeating the same sentence under each question
    var shown = {}, qsOf = {};
    d.answers.forEach(function (a) { (qsOf[a.i] = qsOf[a.i] || []).push(a.qid); });
    var inTopic = {};
    qsAll.forEach(function (q) { inTopic[q.id] = 1; });
    // Recorded parts: a red line runs beside the green line of every quote spoken during the
    // recording, and the recording's time sits under the last of those quotes. Work out first
    // which quotes will be shown (same rule as below), so each recording knows where it ends.
    var willShow = [], seen0 = {};
    qsAll.forEach(function (q) {
      var fr = (byQ[q.id] || []).filter(function (a) { return !seen0[a.i]; }).slice(0, 2);
      fr.forEach(function (a) { seen0[a.i] = 1; willShow.push(a.i); });
    });
    var recOf = {}, recEnd = {}, covered = [];            // step -> clip; clip index -> last shown step
    d.clips.forEach(function (x, ci) {
      var last = -1;
      willShow.forEach(function (i, pos) { if (x.inWin.indexOf(i) >= 0) { recOf[i] = x; last = pos; } });
      if (last >= 0) { recEnd[willShow[last]] = (recEnd[willShow[last]] || []).concat([x]); covered.push(x); }
    });
    var uncovered = function (list) { return list && list.filter(function (x) { return covered.indexOf(x) < 0; }); };
    qsAll.forEach(function (q) {
      var as = byQ[q.id], ns = d.qnotes[q.id], cs = uncovered(d.qclips[q.id]);
      if (cs && !cs.length) cs = null;
      if (!as && !ns && !cs && !q.added) { if (q.kind !== 'opener' && q.depth === 1 && dbState(sess)[q.id] !== 'green') open.push(q); return; }
      h += '<div class="db-q' + (q.added ? ' added' : '') + '"><div class="db-qh"><button class="ql" data-goto="' + q.id + '" title="Show on the tree"><b>' +
        esc(mmQLabel(q)) + '</b> ' + (q.added ? '<span class="addtag">Added</span> ' : '') + esc(q.text) + '</button>' +
        (cs ? dbClipBtn(q.id, cs.length) : '') + (ns ? dbNoteBtn(q.id, ns.length) : '') + '</div>';
      var tail = (cs && dbNotesOpen['c:' + q.id] ? dbClipList(q.id, cs, sess) : '') + (ns && dbNotesOpen[q.id] ? dbNoteList(q.id, ns) : '');
      if (!as) { h += '<div class="seen">Not answered yet</div>' + tail + '</div>'; return; }
      var fresh = as.filter(function (a) { return !shown[a.i]; });
      if (!fresh.length) { h += '<div class="seen">Answered in a reply above</div>' + tail + '</div>'; return; }
      h += fresh.slice(0, 2).map(function (a) {
        shown[a.i] = 1;
        var also = qsOf[a.i].filter(function (id) { return id !== q.id && INDEX[id]; })
          .map(function (id) { return mmQLabel(INDEX[id]); });
        return '<div class="db-quote' + (a.ahead ? ' ahead' : '') + (recOf[a.i] ? ' rec' : '') + '">' + anonHTML(a.text) +
          (a.ahead ? '<span class="tag">answered ahead</span>' : '') +
          (also.length ? '<span class="also">Also answers ' + esc(also.join(', ')) + '</span>' : '') + '</div>' +
          (recEnd[a.i] || []).map(function (x) { return dbRecEnd(x, sess); }).join('');
      }).join('') +
        (fresh.length > 2 ? '<div class="more">+' + (fresh.length - 2) + ' more on the tree</div>' : '') + tail + '</div>';
    });
    // notes taken on the topic itself rather than one of its questions
    var other = [], otherC = [];
    Object.keys(d.qnotes).forEach(function (id) { if (!inTopic[id]) other = other.concat(d.qnotes[id]); });
    Object.keys(d.qclips).forEach(function (id) { if (!inTopic[id]) otherC = otherC.concat(uncovered(d.qclips[id])); });
    if (other.length || otherC.length) {
      var k = 'T' + t.id;
      h += '<div class="db-q"><div class="db-qh"><span class="ql">On the topic as a whole</span>' +
        (otherC.length ? dbClipBtn(k, otherC.length) : '') + (other.length ? dbNoteBtn(k, other.length) : '') + '</div>' +
        (otherC.length && dbNotesOpen['c:' + k] ? dbClipList(k, otherC, sess) : '') +
        (other.length && dbNotesOpen[k] ? dbNoteList(k, other) : '') + '</div>';
    }
    if (!h) h = '<div class="empty">No answers in this topic yet.</div>';
    if (open.length) h += '<div class="db-open"><span>Still open</span>' + open.map(function (q) {
      return '<button data-goto="' + q.id + '" title="' + esc(q.text) + '">' + esc(q.label) + '</button>';
    }).join('') + '</div>';
    return h;
  }
  function renderMindmapCards() {
    if (!dbEl) {
      dbEl = document.createElement('div'); dbEl.className = 'debrief'; dbEl.id = 'debrief';
      viewport.appendChild(dbEl);
      if (window.ResizeObserver) new ResizeObserver(function () { if (layerName === 'mindmap') dbLayout(); }).observe(dbEl);
      dbEl.addEventListener('wheel', dbWheel, { passive: false });
    }
    if (layerName !== 'mindmap') return;
    var sess = mmSession(); mmSig = mmSignature(sess);
    var data = dbData(sess), all = 0, sc = 0, nClips = 0, nNotes = data.loose.length;
    topics().forEach(function (t) { var s = dbStatus(t, sess); all += s.n; sc += s.g + s.a * .4; });
    data.topics.forEach(function (d) { nClips += d.clips.length; nNotes += d.nNotes; });
    var mins = sess && sess.lastIdx >= 0 ? Math.round((sess.cum[sess.lastIdx] || 0) / 60000) : 0;
    var hubMeta = [];
    if (sess && sess.lastIdx >= 0) hubMeta.push(mins + ' min');
    var nAddedAll = NODES.filter(function (n) { return n.added; }).length;
    var hubChips = dbChips(0, nClips, nNotes, nAddedAll);
    var hub = '<div class="db-hub" data-hub="1"><div class="hl">Interview</div><div class="hn">' + esc($('fileName').textContent || '') + '</div>' +
      '<div class="pct">' + (all ? Math.round(sc / all * 100) : 0) + '%</div><div class="hs">covered</div>' +
      (hubMeta.length ? '<div class="hm">' + hubMeta.join(' · ') + '</div>' : '') +
      (hubChips ? '<div class="db-meta hubc">' + hubChips + '</div>' : '') +
      (!sess ? '<div class="hm">Start an interview or open a saved session to fill this in.</div>' : '') +
      (data.loose.length ? '<div class="db-hubnotes">' + dbNoteBtn('loose', data.loose.length, 'not tied to a question') + '</div>' +
        (dbNotesOpen.loose ? dbNoteList('loose', data.loose) : '') : '') +
      '<div class="hx">Names anonymized</div></div>';
    var cards = data.topics.map(function (d) { return dbCard(d, sess); });
    var half = Math.ceil(cards.length / 2);
    var scroll = dbEl.scrollTop;
    var openAt = -1;
    data.topics.forEach(function (d, i) { if (d.t.id === dbOpen) openAt = i; });
    var side = openAt < 0 ? '' : openAt < half ? ' wl' : ' wr';
    dbEl.innerHTML = '<div class="db-wrap' + side + '"><svg class="db-lines"></svg>' +
      '<div class="db-col l">' + cards.slice(0, half).join('') + '</div>' +
      '<div class="db-mid">' + hub + '</div>' +
      '<div class="db-col r">' + cards.slice(half).join('') + '</div></div>';
    dbEl.scrollTop = scroll;
    dbApplyView();
    dbLayout();
    if (dbFlip) { var f = dbFlip; dbFlip = null; dbPlayFlip(f); }
  }
  // narrow screens: one column, hub first; otherwise topics left and right of the hub
  function dbLayout() {
    var wrap = dbEl && dbEl.querySelector('.db-wrap'); if (!wrap) return;
    wrap.classList.toggle('narrow', dbEl.clientWidth < 860);
    dbLines();
  }
  // a curve from the hub to each topic card (follows cards while they move)
  function dbLines() {
    var wrap = dbEl && dbEl.querySelector('.db-wrap'), svgL = wrap && wrap.querySelector('.db-lines');
    if (!svgL) return;
    if (wrap.classList.contains('narrow')) { svgL.innerHTML = ''; return; }
    var W0 = wrap.getBoundingClientRect(), hubR = wrap.querySelector('.db-hub').getBoundingClientRect(), z = DBV.z;
    var hy = (hubR.top + hubR.height / 2 - W0.top) / z, parts = [];
    wrap.querySelectorAll('.db-card').forEach(function (c) {
      var r = c.getBoundingClientRect(), left = c.closest('.db-col.l');
      var x1 = ((left ? hubR.left : hubR.right) - W0.left) / z, y2 = (r.top - W0.top) / z + 22;
      var x2 = ((left ? r.right : r.left) - W0.left) / z, dx = (x2 - x1) / 2;
      parts.push('<path class="' + (c.classList.contains('open') ? 'on' : c.classList.contains('quiet') ? 'quiet' : '') + '" d="M' + x1 + ' ' + hy +
        ' C' + (x1 + dx) + ' ' + hy + ',' + (x2 - dx) + ' ' + y2 + ',' + x2 + ' ' + y2 + '"/>');
    });
    svgL.setAttribute('width', W0.width / z); svgL.setAttribute('height', W0.height / z);
    svgL.innerHTML = parts.join('');
  }
  // opening or closing a topic: cards glide to their new places (FLIP), the opened body unfolds
  function dbRects() {
    var m = {};
    dbEl.querySelectorAll('.db-card,.db-hub').forEach(function (el) { m[el.dataset.topic || 'hub'] = el.getBoundingClientRect(); });
    return m;
  }
  function dbPlayFlip(before) {
    if (!MO || REDUCED) return;
    dbEl.querySelectorAll('.db-card,.db-hub').forEach(function (el) {
      var b = before[el.dataset.topic || 'hub'], a = el.getBoundingClientRect();
      if (!b) return;
      var dx = (b.left - a.left) / DBV.z, dy = (b.top - a.top) / DBV.z;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1)
        MO.animate(el, { x: [dx, 0], y: [dy, 0] }, SPRING).then(function () { el.style.transform = ''; });
    });
    var body = dbEl.querySelector('.db-card.open .db-body');
    if (body) MO.animate(body, { opacity: [0, 1], y: [-6, 0] }, { duration: 0.25, delay: 0.06 });
    var t0 = performance.now();
    (function follow() { dbLines(); if (performance.now() - t0 < 700) requestAnimationFrame(follow); })();
  }
  function dbToggle(id) {
    dbFlip = dbRects();
    dbOpen = dbOpen === id ? null : id;
    renderMindmapCards();
    var card = dbOpen && dbEl.querySelector('.db-card[data-topic="' + dbOpen + '"]');
    if (card) setTimeout(function () {
      var r = card.getBoundingClientRect(), v = dbEl.getBoundingClientRect(), bottom = v.bottom - 120, dy = 0;
      if (r.top < v.top + 8) dy = v.top + 8 - r.top;
      else if (r.bottom > bottom) dy = Math.max(bottom - r.bottom, v.top + 8 - r.top);   // tall card: its top stays in view
      if (dy) dbAnimateView({ x: DBV.x, y: DBV.y + dy, z: DBV.z });
    }, 380);
  }
  function mmGoto(id) { jumpTo(id); }
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.debrief')) return;
    if (Date.now() - dbJustPanned < 250) return;      // the end of a pan isn't a click
    var g = e.target.closest('[data-goto]');
    if (g) { mmGoto(g.getAttribute('data-goto')); return; }
    var nb = e.target.closest('[data-dbnotes]');
    if (nb) {
      var k = nb.dataset.dbnotes;
      dbFlip = dbRects(); dbNotesOpen[k] = !dbNotesOpen[k]; renderMindmapCards();
      if (dbNotesOpen[k]) pop(dbEl.querySelector('[data-notesfor="' + k + '"]'), { y: [-5, 0] }, { duration: 0.22 });
      return;
    }
    var sc = e.target.closest('[data-dbscript]');
    if (sc) { dbScript[sc.dataset.dbscript] = !dbScript[sc.dataset.dbscript]; renderMindmapCards(); return; }
    var tg = e.target.closest('[data-dbtoggle]');
    if (tg) { dbToggle(tg.dataset.dbtoggle); return; }
    var card = e.target.closest('.db-card:not(.open)');
    if (card) dbToggle(card.dataset.topic);
  });

  function drawEdges(extra, k) {           // extra: nodes folding away right now; k: animation 0..1
    extra = extra || {};
    var parts = [];
    var shown = function (n) { return !isHidden(n) || extra[n.id]; };
    NODES.forEach(function (n) {
      if (!shown(n)) return;
      var px = n.x + W[n.depth], py = n.y + n.h / 2;
      n.children.forEach(function (c) {
        if (!(extra[c.id] || (!n.collapsed && !isHidden(c)))) return;
        var cx = c.x != null ? c.x : X[c.depth], cy = c.y + c.h / 2;
        var dx = Math.max(24, (cx - px) / 2);
        var op = extra[c.id] && k != null ? ' style="opacity:' + (1 - k).toFixed(3) + '"' : '';
        parts.push('<path class="edge' + (c.depth === 2 ? ' fu' : '') + '"' + op + ' d="M' + px + ' ' + py +
          ' C' + (px + dx) + ' ' + py + ',' + (cx - dx) + ' ' + cy + ',' + cx + ' ' + cy + '"/>');
      });
    });
    svg.innerHTML = parts.join('');
  }

