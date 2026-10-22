  // 08-timeline.js — Timeline, notes on it, R clips, the reaction rater, off the record. All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ---------- timeline / scrubber ---------- */
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }
  function timeAtIdx(i) { return TBASE + (i < 0 ? 0 : cumEnd[i] / 1000); }
  var LIVE_X = 0.93, tlDots = [], userMarks = [], tlTip = null, tlCursorX = null;
  var recSpan = null, recTimer = null, redSpans = [], rateTarget = null;
  // elapsed-so-far defines the whole scale; the present sits at LIVE_X, the past scrolls left off it
  function spanNow() { return liveIdx < 0 ? 1 : (cumEnd[liveIdx] || 1); }

  function initTL() {
    computeTimeline();
    tlDots = [];
    STEPS.forEach(function (e, i) { addTlDot(i); });
    var track = $('tlTrack');
    var dragging = false;
    function fracAt(ev) {
      var r = track.getBoundingClientRect();
      return clamp((ev.clientX - r.left) / r.width, 0, 1);
    }
    function idxAtFrac(f) {
      var tt = clamp(f / LIVE_X, 0, 1) * spanNow();
      for (var i = 0; i <= liveIdx; i++) { if (tt <= cumEnd[i]) return i; }
      return liveIdx;
    }
    track.addEventListener('pointerdown', function (ev) {
      if (liveIdx < 0 || ev.target.classList.contains('tl-mark') || ev.target.classList.contains('tl-rec')) return;
      dragging = true; tlDrag = true;
      try { track.setPointerCapture(ev.pointerId); } catch (_e) {};
      seekIdx(idxAtFrac(fracAt(ev)), false);
    });
    track.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      seekIdx(idxAtFrac(fracAt(ev)), false);
    });
    function up() {
      if (!dragging) return;
      dragging = false; tlDrag = false;
      if (viewIdx >= liveIdx) goLive(); else rebuildTo(viewIdx, true);
    }
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
    track.addEventListener('pointerenter', function (ev) { tlCursorX = ev.clientX; tlMagnify(); });
    track.addEventListener('pointermove', function (ev) { tlCursorX = ev.clientX; tlMagnify(); });
    track.addEventListener('pointerleave', function () { tlCursorX = null; tlMagnify(); });
    $('tlLive').addEventListener('click', function () { if (reviewing) goLive(); });
    updateTL();
  }

  // Dock-style magnification: dots near the cursor grow, so they are catchable while the track scrolls
  function tlMagnify() {
    var range = 64, dots = $('tlTrack') ? $('tlTrack').querySelectorAll('.tl-mark') : [];
    dots.forEach(function (el) {
      if (el.style.display === 'none' || tlCursorX == null) { el.style.width = ''; el.style.zIndex = ''; return; }
      var r = el.getBoundingClientRect(), cx = r.left + r.width / 2;
      var k = Math.max(0, 1 - Math.abs(tlCursorX - cx) / range);
      el.style.width = (8 + 18 * k * k).toFixed(1) + 'px';   // blocky expansion toward the cursor
      el.style.zIndex = k > 0 ? String(2 + Math.round(k * 10)) : '';
    });
  }

  function updateTL() {
    drawVTL();
    var el = $('tl'); if (!el) return;
    var span = spanNow();
    var viewF = reviewing ? (cumEnd[viewIdx] / span) * LIVE_X : LIVE_X;
    if (viewIdx < 0) viewF = 0;
    $('tlElapsed').style.width = (LIVE_X * 100) + '%';
    $('tlPlayed').style.width = (viewF * 100) + '%';
    $('tlHead').style.left = (viewF * 100) + '%';
    $('tlTime').textContent = fmtTime(timeAtIdx(viewIdx));
    el.classList.toggle('reviewing', reviewing);
    $('tlLive').textContent = reviewing ? 'GO LIVE' : 'LIVE';
    var track = $('tlTrack');
    var cyRel = track.offsetHeight / 2, MH = 20, GAPB = 7;         // solid block sits above the line, with a gap
    var mTop = (cyRel - GAPB - MH) + 'px', mH = MH + 'px';
    function placeMark(el, frac) { el.style.left = (frac * 100) + '%'; el.style.top = mTop; el.style.height = mH; }
    tlDots.forEach(function (d) {
      if (d.i > liveIdx) { d.el.style.display = 'none'; return; }
      d.el.style.display = '';
      placeMark(d.el, (cumEnd[d.i] / span) * LIVE_X);
    });
    userMarks.forEach(function (m) { placeMark(m.el, (cumEnd[m.idx] / span) * LIVE_X); });
    // red record clips: skinny band underneath the timeline line
    var sTop = (cyRel + 5) + 'px', sH = '7px';
    // while held, the clip runs from the press point forward in real time (the transcript
    // lags the audio, so wall-clock time, not the latest segment, decides where it ends)
    if (recSpan) recSpan.endMs = Math.max(recNow(), recSpan.pressMs + (Date.now() - recSpan.pressedAt));
    redSpans.concat(recSpan ? [recSpan] : []).forEach(function (s) {
      // the end may run past the transcript head while R is held (the transcript lags the
      // audio) — let it grow into the "future" strip so the hold is visible, capped at the track
      var a = (clamp(s.startMs, 0, recNow()) / span) * LIVE_X, b = Math.min(1, (Math.max(0, s.endMs) / span) * LIVE_X);
      s.el.style.left = (a * 100) + '%'; s.el.style.width = (Math.max(0, b - a) * 100) + '%';
      s.el.style.top = sTop; s.el.style.height = sH;
    });
    (LIVE.offSpans || []).forEach(function (o) {
      var end = o.endMs != null ? o.endMs : o.pressMs + (Date.now() - o.pressedAt);
      var a = (clamp(o.startMs, 0, recNow()) / span) * LIVE_X, b = Math.min(1, (Math.max(0, end) / span) * LIVE_X);
      o.el.style.left = (a * 100) + '%'; o.el.style.width = (Math.max(0.004, b - a) * 100) + '%';
      o.el.style.top = (cyRel - 6) + 'px'; o.el.style.height = '12px';
    });
    if (recSpan) { el.classList.add('recording'); $('tlLive').textContent = '● REC'; }
    else el.classList.remove('recording');
    if (rateTarget) positionRater();
    if (tlCursorX != null) tlMagnify();   // keep bars widened as they slide under a still cursor
    mmMaybeRefresh();                     // new clip / note / segment while the mind map is open
  }

  /* ---------- timeline tooltips ---------- */
  function tipEl() {
    if (tlTip) return tlTip;
    tlTip = document.createElement('div'); tlTip.className = 'tl-tip'; tlTip.hidden = true;
    viewport.appendChild(tlTip); return tlTip;
  }
  function showTip(el, header, body) {
    var t = tipEl();
    t.innerHTML = '<span class="tt-h">' + esc(header) + '</span>' + esc(body);
    t.hidden = false;
    var r = el.getBoundingClientRect(), vp = viewport.getBoundingClientRect();
    var tk = $('tlTrack'), tr = tk ? tk.getBoundingClientRect() : r;
    t.style.left = (r.left - vp.left + r.width / 2) + 'px';
    t.style.bottom = (vp.height - (tr.top - vp.top) + 10) + 'px';
  }
  function hideTip() { if (tlTip) tlTip.hidden = true; }
  function attachTip(el, hf, bf) {
    el.addEventListener('mouseenter', function () { showTip(el, hf(), bf()); });
    el.addEventListener('mouseleave', hideTip);
  }

  /* ---------- user notes → purple timeline marks ---------- */
  function editUserMark(m) {
    composer('EDIT NOTE', '', 'Edit this note', function (t) {
      m.text = t;
      if (m.wnode) m.wnode.querySelector('.wn-tx').textContent = t;
      shareItem('note', m);
    }, m.text);
  }
  function addUserMark(idx, text, opt) {
    opt = opt || {};
    var m = { idx: clamp(idx, 0, Math.max(0, liveIdx)), text: text, host: opt.host !== undefined ? opt.host : current,   // host: the question it belongs to
              uid: opt.uid || newUid(), from: opt.from || null };
    var dot = document.createElement('button');
    dot.className = 'tl-mark user' + (m.from ? ' shared' : '');
    attachTip(dot, function () { return (m.from ? 'NOTE FROM THE OTHER INTERVIEWER · ' : 'YOUR NOTE · ') + fmtTime(timeAtIdx(m.idx)) + ' · click to edit'; }, function () { return m.text; });
    dot.addEventListener('click', function (ev) { ev.stopPropagation(); editUserMark(m); });
    $('tlTrack').appendChild(dot); m.el = dot; userMarks.push(m);
    // drop a note card into the sequence where we are — visible only on the mind-map page
    var host = INDEX[current];
    if (host && host.x != null) {
      var wn = document.createElement('div');
      wn.className = 'worldnote';
      wn.style.left = (host.x + W[host.depth] + 44) + 'px';
      wn.style.top = (host.y - 4) + 'px';
      wn.innerHTML = '<div class="wn-h">NOTE · ' + fmtTime(timeAtIdx(m.idx)) + '</div><div class="wn-tx">' + esc(text) + '</div>';
      wn.addEventListener('click', function (ev) { ev.stopPropagation(); editUserMark(m); });
      world.appendChild(wn); m.wnode = wn;
    }
    updateTL();
    if (!opt.quiet) shareItem('note', m);
    return m;
  }
  function composer(label, cls, ph, onDone, initial) {
    if (!live) return;
    var idxAt = reviewing ? viewIdx : liveIdx;
    if (idxAt < 0) idxAt = 0;
    var card = document.createElement('div');
    card.className = 'livenote' + (cls ? ' ' + cls : '');
    card.innerHTML = '<div class="ln-top">' + label + ' · ' + fmtTime(timeAtIdx(idxAt)) + '</div>' +
      '<div class="ln-tx" contenteditable="true" spellcheck="false" data-ph="' + ph + '"></div>';
    viewport.appendChild(card);
    var tx = card.querySelector('.ln-tx');
    if (initial) tx.textContent = initial;
    function done() {
      tx.removeEventListener('blur', done);
      var text = tx.textContent.trim();
      if (text) onDone(text, idxAt);
      card.classList.add('out');
      setTimeout(function () { card.remove(); }, 260);
    }
    tx.addEventListener('blur', done);
    tx.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); tx.blur(); }
      else if (e.key === 'Escape') { tx.textContent = ''; tx.blur(); }
      e.stopPropagation();
    });
    setTimeout(function () { tx.focus(); }, 30);
  }
  function addLiveNote() {
    composer('NOTE', '', 'Type a note — it saves to the timeline', function (t, idx) {
      addUserMark(idx, t);
      dropLiveNoteDot(t);
    });
  }
  // a folded purple dot on the side timeline (left of the tree), level with the question being
  // asked; not linked to it. Click it to read the note. The timeline mark stays the record.
  function dropLiveNoteDot(text) {
    var q = INDEX[current]; if (!q || q.y == null) return;
    var x = VTL_X - 50, y = q.y + q.h / 2 - 9;
    pageNotes.forEach(function (p) {                     // several notes on one question: line up to the left
      if (p.live && Math.abs(p.y - y) < 20 && p.x <= x + 4) x = Math.min(x, p.x - 26);
    });
    var note = addPageNote(x, y, { text: text, folded: true, live: true });
    scheduleFileSave();
    pop(note.el, { scale: [0.3, 1] }, { type: 'spring', visualDuration: 0.3, bounce: 0.3 });
  }

  /* ---------- side timeline: the interview so far, top-down beside the tree ----------
     A line from the top of the tree down to the question being asked now (never further), with
     each event level with the question it happened at: a tick per question asked, red bars for
     recorded parts, amber for answered ahead, green for added questions. Live note dots sit to
     its left. Click an event to scrub the bottom timeline to that moment. */
  var VTL_X = -70, vtl = null;
  function drawVTL() {
    vtl = vtl || world.querySelector('svg.vtl');          // the tree can draw before this file has run
    if (!vtl) {
      vtl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      vtl.setAttribute('class', 'vtl'); vtl.setAttribute('width', '1'); vtl.setAttribute('height', '1');
      world.insertBefore(vtl, world.firstChild);
      vtl.addEventListener('click', function (e) {
        var j = e.target.closest('[data-jump]');
        if (j) { jumpTo(j.getAttribute('data-jump')); return; }
        var g = e.target.closest('[data-idx]'); if (!g || !live) return;
        seekIdx(+g.getAttribute('data-idx'), false);
      });
    }
    var sess = mmSession();
    if (VTL_X === undefined || !sess || sess.lastIdx < 0 || !topics().length || topics()[0].y == null) { vtl.innerHTML = ''; return; }
    function yOf(id) { var n = mmVisibleAnchor(id); return n && n.y != null ? n.y + n.h / 2 : null; }
    function at(i) { return fmtTime(sess.tbase + (i > 0 ? sess.cum[i - 1] : 0) / 1000); }
    function tip(t) { return '<title>' + esc(t) + '</title>'; }
    var last = live && reviewing ? viewIdx : sess.lastIdx;   // reviewing: nothing after the moment you're on
    var x = VTL_X, nowQ = live ? current : mmCurAt(sess, last);
    var yEnd = nowQ ? yOf(nowQ) : null, p = [], ys = yEnd != null ? [yEnd] : [];
    var lineAt = p.length; p.push('');                    // the line goes in once its ends are known
    var prev = null;                                      // a tick each time the question changes
    for (var i = 0; i <= last; i++) {
      var c = sess.steps[i] && sess.steps[i].cur;
      if (!c || c === prev) continue;
      prev = c; var y = yOf(c); if (y == null) continue;
      ys.push(y);
      p.push('<g class="hit" data-idx="' + i + '">' + tip(mmQLabel(INDEX[c]) + ' asked · ' + at(i)) +
        '<rect x="' + (x + 1) + '" y="' + (y - 5) + '" width="16" height="10"/><line class="tk" x1="' + (x + 3) + '" y1="' + y + '" x2="' + (x + 13) + '" y2="' + y + '"/></g>');
    }
    sess.clips.forEach(function (cl) {                    // recorded parts: red bars left of the line
      var i0 = -1, i1 = -1;
      for (var i = 0; i <= last; i++) { var w = mmStepWin(sess, i); if (w[0] < cl.endMs && w[1] > cl.startMs) { if (i0 < 0) i0 = i; i1 = i; } }
      if (i0 < 0) return;
      var a = yOf(mmCurAt(sess, i0)), b = yOf(mmCurAt(sess, i1)); if (a == null || b == null) return;
      var y0 = Math.min(a, b) - 2, h = Math.max(4, Math.abs(b - a) + 4);
      p.push('<g class="hit" data-idx="' + i0 + '">' + tip('Recorded ' + fmtTime(sess.tbase + cl.startMs / 1000) + '–' + fmtTime(sess.tbase + cl.endMs / 1000)) +
        '<rect class="pad" x="' + (x - 10) + '" y="' + (y0 - 3) + '" width="8" height="' + (h + 6) + '"/>' +
        '<rect class="clip" x="' + (x - 6.75) + '" y="' + y0 + '" width="1.5" height="' + h + '" rx=".75"/></g>');
    });
    (sess.ahead || []).forEach(function (n) {             // answered ahead: amber diamond, at the moment it happened
      if (n.idx > last) return;
      var y = yOf(n.at); if (y == null) return;
      var cx = x - 14, r = 2.4;                           // left of the line; click = go to that question
      p.push('<g class="hit" data-jump="' + n.id + '">' + tip('Answered ahead: ' + n.label + ' — click to go there') +
        '<circle class="pad" cx="' + cx + '" cy="' + y + '" r="7"/>' +
        '<path class="ahead" d="M' + cx + ' ' + (y - r) + ' L' + (cx + r) + ' ' + y + ' L' + cx + ' ' + (y + r) + ' L' + (cx - r) + ' ' + y + 'Z"/></g>');
    });
    sess.marks.forEach(function (m) {                     // added questions: green dots
      if (!m.q || m.idx > last) return;
      var y = yOf(mmCurAt(sess, m.idx)); if (y == null) return;
      p.push('<g class="hit" data-idx="' + m.idx + '">' + tip('Question added: ' + m.text) +
        '<circle class="add" cx="' + (x + 32) + '" cy="' + y + '" r="3.5"/></g>');
    });
    // from the first question asked to the one being asked now (or the furthest reached,
    // if the interview went back up the tree)
    if (ys.length) p[lineAt] = '<line class="ln" x1="' + x + '" y1="' + Math.min.apply(null, ys) + '" x2="' + x + '" y2="' + Math.max.apply(null, ys) + '"/>';
    if (yEnd == null) yEnd = ys.length ? ys[ys.length - 1] : 0;
    if (live) p.push('<circle class="nowring" cx="' + x + '" cy="' + yEnd + '" r="6"/><circle class="now" cx="' + x + '" cy="' + yEnd + '" r="4.5"/>');
    vtl.innerHTML = p.join('');
  }

  function topicOf(n) { while (n && n.depth > 0) n = n.parent; return (n && n.id !== '_root') ? n : topics()[0]; }
  function addQMark(idx, text) {
    var m = { idx: clamp(idx, 0, Math.max(0, liveIdx)), text: text, q: true };   // q: an added question, not a note
    var el = document.createElement('button');
    el.className = 'tl-mark q';
    attachTip(el, function () { return 'ADDED QUESTION · ' + fmtTime(timeAtIdx(m.idx)); }, function () { return m.text; });
    el.addEventListener('click', function (ev) { ev.stopPropagation(); seekIdx(m.idx, true); });
    $('tlTrack').appendChild(el); m.el = el; userMarks.push(m);
    updateTL();
    return m;
  }
  function addQuestion() {
    composer('QUESTION', 'q', 'Type a question to slot into the sequence', function (text, idx) {
      if (VIEWER) {
        // the tree lives on the recording computer: ask it to insert the question; it comes
        // back to this page with the next tree update (a couple of seconds)
        fetch(API + '/api/shared/event', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'question', uid: newUid(), data: { text: text, idx: idx, host: current, by: ME } }) }).catch(function () {});
        addQMark(idx, text);
        notifyQuestion(text, idx);
        return;
      }
      insertQuestion(text, idx, current);
      notifyQuestion(text, idx);
    });
  }
  // put an asked-on-the-fly question into the tree after the one being asked (hostId)
  function insertQuestion(text, idx, hostId, from) {
    var host = INDEX[hostId], topicNode = host ? topicOf(host) : topics()[0];
    var anchor = host; while (anchor && anchor.depth > 1) anchor = anchor.parent;   // depth-1 node in the lineage
    var pos = (anchor && anchor.parent === topicNode) ? topicNode.children.indexOf(anchor) + 1 : undefined;
    pushHistory();                                   // saves the tree (and publishes it while live)
    var q = mk({ kind: 'standard', depth: 1, text: text, collapsed: false, added: true });
    attach(topicNode, q, pos);
    renumber(); layout(); buildSpine();
    if (q.el) q.el.classList.add('qadded');
    if (live) {                                      // it's covered — it was just asked
      state[q.id] = 'green'; q.el.dataset.s = 'green'; coverage();
      if (STEPS[idx]) { STEPS[idx].mark = STEPS[idx].mark || []; STEPS[idx].mark.push([q.id, 'green']); }   // survives rebuilds & sessions
    }
    var m = addQMark(idx, text);
    if (m && from) { m.from = from; if (m.el) m.el.classList.add('shared'); }
    planSync();                                      // the tagger can now recognise answers to it
    if (!from) select(q.id, false);
    return q;
  }
  var qnoteTimer = null;
  function notifyQuestion(text, idx) {
    var el = $('qnote');
    el.innerHTML = '<span class="qi">✚</span><div class="qc">' +
      '<div class="ql">QUESTION ADDED · ' + fmtTime(timeAtIdx(idx)) + '</div>' +
      '<div class="qt">' + esc(text) + '</div></div>' +
      '<button class="qx" aria-label="Dismiss">×</button>';
    el.classList.add('active');
    el.querySelector('.qx').addEventListener('click', function () {
      el.classList.remove('active'); if (qnoteTimer) clearTimeout(qnoteTimer);
    });
    if (qnoteTimer) clearTimeout(qnoteTimer);
    qnoteTimer = setTimeout(function () { el.classList.remove('active'); }, 20000);   // ≥20 s; × still closes it sooner
  }

  /* ---------- R = record a red clip on the timeline ---------- */
  function recNow() { return liveIdx < 0 ? 0 : cumEnd[liveIdx]; }
  function idxAtMs(ms) { for (var i = 0; i <= liveIdx; i++) { if (ms <= cumEnd[i]) return i; } return Math.max(0, liveIdx); }
  function startRec(isRepeat) {
    if (!live || reviewing || isRepeat || recSpan) return;
    var end = recNow();
    // press = start 10 s back; holding keeps recording forward; release ends the clip
    recSpan = { startMs: Math.max(0, end - 10000), endMs: end, pressMs: end, pressedAt: Date.now(),
                el: document.createElement('button') };
    recSpan.el.className = 'tl-rec live';
    $('tlTrack').appendChild(recSpan.el);
    app.classList.add('recording');
    showRater(recSpan);
    recTimer = setInterval(updateTL, 250);               // grow the red bar while R is held
    updateTL();
  }
  function stopRec() {
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    app.classList.remove('recording');
    if (!recSpan) return;
    var s = recSpan; recSpan = null;
    s.endMs = Math.max(recNow(), s.pressMs + (Date.now() - s.pressedAt));   // ends exactly at release
    s.el.classList.remove('live');
    s.uid = newUid();
    armClip(s);
    shareItem('clip', s);
    updateTL();
    if ($('rater').classList.contains('active')) startRaterTimeout();   // 3s to pick a reaction, else dismiss
  }
  function armClip(s) {                    // a finished clip: clickable, tooltip, on the timeline
    s.el.addEventListener('click', function (ev) { ev.stopPropagation(); addClipNote(s); });
    attachTip(s.el, function () { return 'RECORDED CLIP · click to add a note'; }, function () {
      var b = fmtTime(TBASE + s.startMs / 1000) + ' – ' + fmtTime(TBASE + s.endMs / 1000);
      if (s.reaction) { var m = reactMeta(s.reaction); b += '\n' + m.g + ' ' + m.l; }
      (s.notes || []).forEach(function (nt) { b += '\n✎ ' + nt; });
      return b;
    });
    redSpans.push(s);
  }
  document.addEventListener('keyup', function (e) { if (e.key.toLowerCase() === 'r') stopRec(); });

  /* ---------- 1–4 emotion rater on the recorded clip ---------- */
  function reactMeta(n) {
    return { 1: { g: '★', l: 'Interesting' }, 2: { g: '≠', l: "Doesn't add up" },
             3: { g: '?', l: 'Question mark' }, 4: { g: '✎', l: 'Note' } }[n];
  }
  function reactColor(n) { return { 1: '#4E9A6B', 2: '#C4695A', 3: '#2B5FD9', 4: '#8B5CF6' }[n]; }
  function renderRecBadge(s) {
    var b = s.el.querySelector('.rbadge');
    if (!b) { b = document.createElement('span'); b.className = 'rbadge'; s.el.appendChild(b); }
    var n = s.reaction || ((s.notes && s.notes.length) ? 4 : 0);
    if (!n) { b.remove(); return; }
    b.textContent = reactMeta(n).g; b.style.color = reactColor(n);
  }
  var raterTimer = null;
  function showRater(s) { rateTarget = s; $('rater').classList.add('active'); positionRater(); if (raterTimer) { clearTimeout(raterTimer); raterTimer = null; } }
  function hideRater() { rateTarget = null; $('rater').classList.remove('active'); if (raterTimer) { clearTimeout(raterTimer); raterTimer = null; } }
  function startRaterTimeout() { if (raterTimer) clearTimeout(raterTimer); raterTimer = setTimeout(hideRater, 3000); }  // 3s to rate, else it clears
  // clicking anywhere off the rater dismisses it (unless it lands on a rater button)
  document.addEventListener('pointerdown', function (e) {
    if (rateTarget && !e.target.closest('.rater')) hideRater();
  }, true);
  function positionRater() {
    if (!rateTarget) return;
    var track = $('tlTrack'); if (!track) return;
    var span = spanNow();
    var mid = ((clamp(rateTarget.startMs, 0, recNow()) + clamp(rateTarget.endMs, 0, recNow())) / 2 / span) * LIVE_X;
    var tr = track.getBoundingClientRect(), vp = viewport.getBoundingClientRect();
    var x = clamp(tr.left - vp.left + mid * tr.width, 60, vp.width - 60);
    $('rater').style.left = x + 'px';
    $('rater').style.bottom = (vp.height - (tr.top - vp.top) + 14) + 'px';
  }
  function applyRate(n) {
    if (!rateTarget) return;
    var s = rateTarget;
    if (n === 'note') { hideRater(); addClipNote(s); return; }
    s.reaction = n; renderRecBadge(s); hideRater(); updateTL();
    shareItem('clip', s);
  }
  $('rater').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rate]');
    if (b) applyRate(b.dataset.rate === 'note' ? 'note' : +b.dataset.rate);
  });
  // clip notes are an append-log: past notes shown on top, you write a continuation below
  function addClipNote(s) {
    if (!live) return;
    s.notes = s.notes || [];
    var card = document.createElement('div');
    card.className = 'livenote clip';
    var past = s.notes.map(function (n) { return '<div class="ln-past">' + esc(n) + '</div>'; }).join('');
    card.innerHTML = '<div class="ln-top">CLIP NOTE · ' + fmtTime(12 + s.startMs / 1000) + ' – ' + fmtTime(12 + s.endMs / 1000) + '</div>' +
      (past ? '<div class="ln-cont">EARLIER ON THIS CLIP</div><div class="ln-log">' + past + '</div>' : '') +
      '<div class="ln-tx" contenteditable="true" spellcheck="false" data-ph="' +
      (s.notes.length ? 'Continue the note…' : 'Write a note for this clip…') + '"></div>';
    viewport.appendChild(card);
    var tx = card.querySelector('.ln-tx');
    function done() {
      tx.removeEventListener('blur', done);
      var t = tx.textContent.trim();
      if (t) { s.notes.push(t); renderRecBadge(s); updateTL(); shareItem('clip', s); }
      card.classList.add('out'); setTimeout(function () { card.remove(); }, 260);
    }
    tx.addEventListener('blur', done);
    tx.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); tx.blur(); }
      else if (e.key === 'Escape') { tx.textContent = ''; tx.blur(); }
      e.stopPropagation();
    });
    setTimeout(function () { tx.focus(); }, 30);
  }

  // reconstruct the whole UI as of steps 0..idx having played
  function rebuildTo(idx, moveCam) {
    clearAnnos(); clearBadges(); toasts.innerHTML = '';
    state = {}; notes = [];
    NODES.forEach(function (n) { delete n.el.dataset.s; });
    NODES.forEach(function (n) { if (n.depth === 1) { state[n.id] = 'red'; n.el.dataset.s = 'red'; } });
    var curId = null;
    for (var i = 0; i <= idx; i++) {
      var e = STEPS[i];
      if (e.cur) { curId = e.cur; current = e.cur; }
      if (e.mark) e.mark.forEach(function (m) { markNode(m[0], m[1]); });
      if (e.anno) e.anno.forEach(function (a) { addAnno(a.id, a.text, a.kind); });   // live annotations
      if (e.notes) e.notes.forEach(function (nt) { notes.push(nt); badge(nt.topic); });
    }
    caps.querySelectorAll('.line').forEach(function (l) { l.remove(); });
    for (var j = Math.max(0, idx - 2); j <= idx; j++) pushLine(STEPS[j].w, STEPS[j].t, STEPS[j].a);
    if (curId) setCurrent(curId, moveCam);
    coverage(); drawInspector(); updateTL();
  }

  function seekIdx(i, moveCam) {
    i = clamp(i, 0, liveIdx);
    reviewing = i < liveIdx;
    if (reviewing) clearTimeout(timer);
    viewIdx = i;
    rebuildTo(i, moveCam && !tlDrag);
  }

  function goLive() {
    reviewing = false; viewIdx = liveIdx;
    rebuildTo(liveIdx, true);
    if (!liveReal && !paused && step < STEPS.length) { tickAt = Date.now(); timer = setTimeout(tick, 900); }
  }

  function setPaused(on) {
    if (!live) return;
    paused = !!on;
    caps.classList.toggle('paused', paused);
    pauseBtn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE; pauseBtn.title = paused ? 'Resume' : 'Pause';
    var rec = caps.querySelector('.rec');
    if (rec) rec.textContent = paused ? 'Paused · nothing is being recorded' : 'Recording · 2 speakers · local';
    if (paused) {
      clearTimeout(timer);
      pausedAt = Date.now();
      tickDur = Math.max(0, tickDur - (pausedAt - tickAt));
    } else {
      pauseOffset += Date.now() - pausedAt;
      tickAt = Date.now();
      if (!reviewing) timer = setTimeout(tick, tickDur);
    }
  }
  pauseBtn.addEventListener('click', function () { liveReal ? setOffRecord(!LIVE.off) : setPaused(!paused); });

  /* ---------- off the record (real interviews) ----------
     The pipeline replaces incoming audio with silence while this is on, so nothing is
     transcribed or stored. The timeline shows the gap as a grey band. */
  function setOffRecord(on, fromServer) {
    if (!live || !liveReal || (LIVE.restored && !LIVE.attached) || !!on === !!LIVE.off) return;
    LIVE.off = !!on;
    if (!fromServer) fetch(API + '/api/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: LIVE.off }) }).catch(function () {});
    if (LIVE.off) {
      var span = { startMs: recNow(), pressMs: recNow(), pressedAt: Date.now(), endMs: null, el: document.createElement('div') };
      span.el.className = 'tl-off'; span.el.title = 'Off the record';
      $('tlTrack').appendChild(span.el);
      LIVE.offSpans.push(span);
      LIVE.offTimer = setInterval(updateTL, 500);          // let the grey band grow while off
    } else {
      var cur = LIVE.offSpans[LIVE.offSpans.length - 1];
      if (cur && cur.endMs == null) cur.endMs = cur.pressMs + (Date.now() - cur.pressedAt);
      if (LIVE.offTimer) { clearInterval(LIVE.offTimer); LIVE.offTimer = null; }
    }
    caps.classList.toggle('offrec', LIVE.off);
    pauseBtn.innerHTML = LIVE.off ? ICON_PLAY : ICON_PAUSE;
    pauseBtn.title = LIVE.off ? 'Back on the record' : 'Off the record — stop transcribing until you resume';
    pauseBtn.classList.toggle('on', LIVE.off);
    var rec = caps.querySelector('.rec');
    if (rec) rec.textContent = LIVE.off ? 'Off the record · nothing is transcribed' : 'Recording · live · local';
    updateTL();
  }
  runBtn.addEventListener('click', function () { live ? stopLive() : startLive(); });
  var liveBtn = $('liveBtn');
  if (liveBtn) liveBtn.addEventListener('click', function () { live ? stopLive() : startLiveBackend(); });


