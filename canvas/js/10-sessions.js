  // 10-sessions.js — Interview sessions, shared notes and clips, the second interviewer view. All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ================= interview sessions: autosave log, download / upload, resume =========== */
  // While a real interview runs, the whole session (transcript as the canvas holds it, coverage,
  // recordings, notes, added questions, the tree) is saved to sessions/<id>.json every 10 s and
  // on stop. A session can be downloaded as one file, opened again from a file or from the list,
  // and — if the pipeline is still running after a reload — resumed live where it left off.
  var SESS = { id: null, timer: null, lastSig: '', savedAt: null, err: null, last: null };
  function sessionSnapshot() {
    var f = FILES.filter(function (x) { return x.id === ACTIVE; })[0] || {};
    var n = Math.max(0, liveIdx + 1);
    return {
      format: 'fieldnotes-session', version: 1, src: LIVE.src || null, demo: !liveReal,
      session_id: LIVE.session || null,
      tree: { name: f.name || 'Interview', data: snap(), notes: pageNotes.map(serializeNote) },
      steps: STEPS.slice(0, n).map(function (e) {
        return { w: e.w, raw: e.raw || null, t: e.t, a: !!e.a, tStart: e.tStart, tEnd: e.tEnd, seg_id: e.seg_id,
                 mark: e.mark || [], notes: e.notes || [], anno: e.anno || [], cur: e.cur || null };
      }),
      clips: redSpans.map(function (c) { return { startMs: c.startMs, endMs: c.endMs, reaction: c.reaction || 0, notes: (c.notes || []).slice(), uid: c.uid || null, from: c.from || null }; }),
      marks: userMarks.map(function (m) { return { idx: m.idx, text: m.text, host: m.host || null, q: !!m.q, uid: m.uid || null, from: m.from || null }; }),
      offRecord: (LIVE.offSpans || []).map(function (o) { return { startMs: o.startMs, endMs: o.endMs != null ? o.endMs : o.pressMs + (Date.now() - o.pressedAt) }; }),
      current: current || null, tbase: TBASE, lastSeg: LIVE.lastSeg, lastCov: LIVE.lastCov,
      duration: n ? fmtTime(TBASE + (cumEnd[n - 1] || 0) / 1000) : '00:00'
    };
  }
  function sessionSig() {
    return [liveIdx, current, redSpans.map(function (c) { return (c.reaction || 0) + ':' + (c.notes || []).length; }).join(','),
            userMarks.map(function (m) { return m.text.length; }).join(',')].join('|');
  }
  function autosave(force) {
    if (VIEWER || !liveReal || liveIdx < 0 || (LIVE.restored && !LIVE.attached)) return;
    var sig = sessionSig();
    if (!force && sig === SESS.lastSig) return;
    var id = SESS.id || (SESS.id = LIVE.session || ('s' + Date.now().toString(36)));
    fetch(API + '/api/session/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, data: sessionSnapshot() }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) { SESS.lastSig = sig; SESS.savedAt = new Date(); SESS.err = null; } else SESS.err = d.error; updateSessUI(); })
      .catch(function () { SESS.err = 'server not reachable — not saved'; updateSessUI(); });
  }
  function clock24(d) { return d ? d.toTimeString().slice(0, 8) : ''; }
  function updateSessUI() {
    var b = $('sessBtn');
    if (b) {
      b.classList.toggle('saved', !!(live && SESS.savedAt && !SESS.err));
      b.title = live && liveReal ? (SESS.err ? 'Session NOT saved: ' + SESS.err
        : SESS.savedAt ? 'Session autosaved ' + clock24(SESS.savedAt) : 'Session will autosave once the first line arrives')
        : 'Interview session — autosave log, download, open';
    }
    var st = $('sStat'); if (!st || $('sessModal').hidden) return;
    st.className = 'sstat' + (live ? ' live' : '');
    if (live && LIVE.restored && !LIVE.attached) st.textContent = 'Reviewing a saved session (not live). Click ◉ to close it and start a new interview.';
    else if (live && liveReal) st.textContent = SESS.err ? '⚠ Not saved: ' + SESS.err
      : SESS.savedAt ? 'Live interview · autosaved every 10 s · last saved ' + clock24(SESS.savedAt) + (SESS.id ? ' (sessions/' + SESS.id + '.json)' : '')
      : 'Live interview · autosave starts with the first transcript line.';
    else if (live) st.textContent = 'Demo running — demos aren’t logged, but you can still download it.';
    else st.textContent = SESS.last ? 'No interview running. The last one is ready to download.' : 'No interview running.';
    $('sDown').disabled = !(live || SESS.last);
  }
  function downloadSession() {
    var d = live ? sessionSnapshot() : SESS.last;
    if (!d) return;
    var name = ((d.tree && d.tree.name) || 'interview').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'interview';
    var blob = new Blob([JSON.stringify(d)], { type: 'application/json' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name + '-' + new Date().toISOString().slice(0, 10) + '.fieldnotes.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    sessMsg('Downloaded ' + a.download);
  }
  function sessMsg(t, err) { var m = $('sMsg'); m.textContent = t; m.classList.toggle('err', !!err); }

  function restoreSession(d, attach) {
    if (!d || d.format !== 'fieldnotes-session' || !Array.isArray(d.steps)) { sessMsg('That isn’t a Fieldnotes session file.', true); return false; }
    if (live) stopLive();
    // the tree it was recorded against: reuse an identical one, else add it as a new tree
    var t = d.tree || {}, f = FILES.filter(function (x) { return x.data === t.data; })[0];
    if (!f && t.data) {
      saveActive();
      f = { id: newId(), name: (t.name || 'Interview') + ' (session)', data: t.data, notes: t.notes || [] };
      FILES.push(f); persistFiles();
    }
    if (f && f.id !== ACTIVE) { saveActive(); loadFile(f.id, false); }
    var when = (d.saved_at || '').replace('T', ' ').slice(0, 16);
    enterLiveView(attach ? 'Resumed · live · local' : 'Saved session' + (when ? ' · ' + when : ''));
    liveReal = !d.demo; LIVE.src = d.src || null;
    if (!liveReal) app.classList.remove('live-real');
    TBASE = d.tbase != null ? d.tbase : 0;
    STEPS = LIVE.steps = d.steps; LIVE.byId = {};
    STEPS.forEach(function (e, i) { if (e.seg_id != null) LIVE.byId[e.seg_id] = i; });
    computeTimeline();
    liveIdx = viewIdx = STEPS.length - 1;
    (d.clips || []).forEach(function (c) {
      var clip = { startMs: c.startMs, endMs: c.endMs, reaction: c.reaction || 0, notes: (c.notes || []).slice(),
                   uid: c.uid || newUid(), from: c.from || null, el: document.createElement('button') };
      clip.el.className = 'tl-rec' + (clip.from ? ' shared' : ''); $('tlTrack').appendChild(clip.el);
      armClip(clip); renderRecBadge(clip);
    });
    (d.marks || []).forEach(function (m) {
      if (m.q) addQMark(m.idx, m.text);
      else addUserMark(m.idx, m.text, { host: m.host, uid: m.uid, from: m.from, quiet: true });
    });
    (d.offRecord || []).forEach(function (o) {
      var el = document.createElement('div'); el.className = 'tl-off'; el.title = 'Off the record';
      $('tlTrack').appendChild(el);
      LIVE.offSpans.push({ startMs: o.startMs, endMs: o.endMs, pressMs: o.startMs, pressedAt: Date.now(), el: el });
    });
    LIVE.restored = true; LIVE.attached = !!attach; LIVE.session = d.session_id || null;
    LIVE.lastSeg = d.lastSeg || STEPS.reduce(function (a, e) { return Math.max(a, e.seg_id || 0); }, 0);
    LIVE.lastCov = d.lastCov || 0;
    if (d.current) current = d.current;
    if (liveIdx >= 0) rebuildTo(liveIdx, true); else updateTL();
    var c = caps.querySelector('.clock'); if (c) c.textContent = d.duration || '00:00';
    SESS.last = d; SESS.lastSig = ''; SESS.savedAt = null; SESS.err = null;
    if (attach) {                           // pick the running pipeline back up where we left off
      SESS.id = d.session_id;
      publishTree();
      LIVE.poll = setInterval(livePoll, 1000);
      SESS.timer = setInterval(function () { autosave(false); }, 10000);
      fetch(API + '/api/status').then(function (r) { return r.json(); }).then(function (st) {
        if (st.off_record) setOffRecord(true, true);        // still off the record on the server
      }).catch(function () {});
    }
    syncTransport(); updateSessUI();
    return true;
  }

  function renderSessList() {
    var list = $('sList');
    list.innerHTML = '<div class="empty">Loading…</div>';
    Promise.all([
      fetch(API + '/api/sessions').then(function (r) { return r.json(); }),
      fetch(API + '/api/status').then(function (r) { return r.json(); }),
      fetch(API + '/api/segments?after=0').then(function (r) { return r.json(); }).catch(function () { return {}; })
    ]).then(function (res) {
      var items = res[0].sessions || [], running = res[1].running ? res[2].session : null;
      if (!items.length) { list.innerHTML = '<div class="empty">No saved sessions yet — they appear here once a live interview has started.</div>'; return; }
      list.innerHTML = items.map(function (it) {
        var resumable = running && it.session_id === running && !(live && LIVE.session === running);
        return '<div class="srec' + (resumable ? ' running' : '') + '"><span class="sn"><b>' + esc(it.name) + '</b>' +
          '<span class="sm">' + esc((it.saved_at || '').replace('T', ' ').slice(0, 16)) + ' · ' + it.lines + ' lines · ' +
          (it.duration || '00:00') + ' · ' + it.clips + ' clip' + (it.clips === 1 ? '' : 's') + (it.src ? ' · ' + esc(it.src) : '') +
          (resumable ? ' · <b>still running</b>' : '') + '</span></span>' +
          (resumable ? '<button class="xbtn primary" data-sresume="' + esc(it.id) + '">Resume live</button>' : '') +
          '<button class="xbtn" data-sopen="' + esc(it.id) + '">Open</button></div>';
      }).join('');
      if (items.some(function (it) { return running && it.session_id === running; }) && !(live && LIVE.session === running)) {
        $('sStat').className = 'sstat resume';
        $('sStat').textContent = 'An interview is still running on the server. Resume it to carry on where you left off — nothing is lost.';
      }
    }).catch(function () {
      list.innerHTML = '<div class="empty">' + (VIEWER ? 'Saved interviews stay on the recording computer. You can still download this one.'
        : 'No backend — start the server (./start.sh).') + '</div>';
    });
  }
  function openSessions() {
    sessMsg('');
    $('sessModal').hidden = false;
    updateSessUI(); renderSessList();
  }
  $('sessBtn').addEventListener('click', openSessions);
  $('sDown').addEventListener('click', downloadSession);
  $('sFile').addEventListener('change', function () {
    var file = this.files[0]; if (!file) return;
    var rd = new FileReader();
    rd.onload = function () {
      var d = null; try { d = JSON.parse(rd.result); } catch (e) {}
      if (restoreSession(d, false)) { $('sessModal').hidden = true; }
    };
    rd.readAsText(file);
    this.value = '';
  });
  $('sessModal').addEventListener('click', function (e) {
    if (e.target === $('sessModal') || e.target.closest('[data-xclose]')) { $('sessModal').hidden = true; return; }
    var o = e.target.closest('[data-sopen],[data-sresume]');
    if (!o) return;
    var resume = !!o.dataset.sresume, id = o.dataset.sresume || o.dataset.sopen;
    fetch(API + '/api/session?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error);
      if (restoreSession(j.data, resume)) $('sessModal').hidden = true;
    }).catch(function (err) { sessMsg(err.message, true); });
  });
  // after a reload: if the server is still recording a session we have a log for, offer to resume
  function checkResume() {
    if (VIEWER) return;
    Promise.all([
      fetch(API + '/api/status').then(function (r) { return r.json(); }),
      fetch(API + '/api/segments?after=0').then(function (r) { return r.json(); }),
      fetch(API + '/api/sessions').then(function (r) { return r.json(); })
    ]).then(function (res) {
      if (!res[0].running || live) return;
      var sid = res[1].session;
      if ((res[2].sessions || []).some(function (it) { return it.session_id === sid; })) openSessions();
    }).catch(function () {});
  }

  // play / pause belong to the Sample demo only
  function syncTransport() {
    var src = ($('srcSel') && $('srcSel').value) || 'sample';
    $('iv2Sel').hidden = src !== 'call';
    $('iv2Sel').disabled = live;                       // fixed for the length of an interview
    if (!live) $('spkPop').hidden = true;
    runBtn.hidden = live ? liveReal : src !== 'sample';
    pauseBtn.hidden = !live || (LIVE.restored && !LIVE.attached);
  }
  try { var lastSrc = localStorage.getItem('fn.src'); if (lastSrc && $('srcSel').querySelector('option[value="' + lastSrc + '"]')) $('srcSel').value = lastSrc; } catch (_e) {}
  $('srcSel').addEventListener('change', function () { try { localStorage.setItem('fn.src', this.value); } catch (_e) {} syncTransport(); });
  try { var iv2 = localStorage.getItem('fn.iv2'); if (iv2) $('iv2Sel').value = iv2; } catch (_e) {}
  $('iv2Sel').addEventListener('change', function () { try { localStorage.setItem('fn.iv2', this.value); } catch (_e) {} });

  // who is who: rename a speaker for this interview (shared through the server)
  function renderSpeakers() {
    $('spkList').innerHTML = (LIVE.speakers || []).map(function (sp) {
      return '<div class="sprow"><input data-raw="' + esc(sp.raw) + '" value="' + esc(sp.name) + '" spellcheck="false">' +
        '<span class="spm">' + (sp.raw !== sp.name ? esc(sp.raw) + ' · ' : '') + Math.round(sp.seconds) + ' s</span></div>';
    }).join('');
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('#spkBtn')) {
      var pop = $('spkPop'), r = e.target.getBoundingClientRect();
      renderSpeakers();
      pop.hidden = false;
      pop.style.left = Math.max(8, Math.min(r.left - 150, innerWidth - 316)) + 'px';
      pop.style.top = Math.max(8, r.top - pop.offsetHeight - 10) + 'px';
      return;
    }
    if (e.target.closest('#spkClose') || (!$('spkPop').hidden && !e.target.closest('#spkPop'))) $('spkPop').hidden = true;
  });
  $('spkPop').addEventListener('change', function (e) {
    var inp = e.target.closest('input[data-raw]'); if (!inp) return;
    fetch(API + '/api/speakers', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: inp.dataset.raw, name: inp.value.trim() }) }).catch(function () {});
    var list = (LIVE.speakers || []).map(function (sp) {   // relabel right away; the next poll confirms
      return sp.raw === inp.dataset.raw ? { raw: sp.raw, name: inp.value.trim() || sp.raw, seconds: sp.seconds } : sp;
    });
    applySpeakerNames(list);
  });

  /* ---------- shared notes and R clips (both interviewers) ----------
     Every note / clip / reaction / clip note is posted to the server's log for this interview;
     each page applies the other's items (matched by uid, so later changes update in place). */
  var ME = Math.random().toString(36).slice(2, 7);       // this page; ignores its own echoes
  function newUid() { return (VIEWER ? 'v' : 'h') + ME + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function shareItem(kind, o) {
    if (!liveReal || !o.uid || (LIVE.restored && !LIVE.attached)) return;
    var data = kind === 'clip'
      ? { startMs: o.startMs, endMs: o.endMs, reaction: o.reaction || 0, notes: (o.notes || []).slice(), by: ME }
      : { idx: o.idx, text: o.text, host: o.host || null, by: ME };
    fetch(API + '/api/shared/event', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: kind, uid: o.uid, data: data }) }).catch(function () {});
  }
  function pollShared() {
    fetch(API + '/api/shared/events?after=' + (LIVE.lastEv || 0)).then(function (r) { return r.json(); }).then(function (d) {
      if (d.session !== LIVE.evSession) { LIVE.evSession = d.session; LIVE.lastEv = 0; return; }   // new interview
      (d.events || []).forEach(applySharedEvent);
      if (d.events && d.events.length) LIVE.lastEv = d.events[d.events.length - 1].id;
    }).catch(function () {});
  }
  function applySharedEvent(ev) {
    if (ev.data && ev.data.by === ME) return;                              // my own change coming back
    var who = ev.from === 'viewer' ? 'second interviewer' : 'recording computer', v = ev.data;
    if (ev.kind === 'clip') {
      var c = redSpans.filter(function (x) { return x.uid === ev.uid; })[0];
      if (!c) {
        c = { uid: ev.uid, from: who, startMs: v.startMs, endMs: v.endMs, reaction: 0, notes: [], el: document.createElement('button') };
        c.el.className = 'tl-rec shared'; $('tlTrack').appendChild(c.el); armClip(c);
      }
      c.startMs = v.startMs; c.endMs = v.endMs; c.reaction = v.reaction || 0; c.notes = (v.notes || []).slice();
      renderRecBadge(c); updateTL();
    } else if (ev.kind === 'question') {
      if (!VIEWER && !LIVE.qSeen) LIVE.qSeen = {};
      var already = NODES.some(function (n) { return n.added && n.text === v.text; });   // e.g. after a reload
      if (!VIEWER && !LIVE.qSeen[ev.uid] && !already) {  // only the recording computer edits the tree
        LIVE.qSeen[ev.uid] = 1;
        insertQuestion(v.text, v.idx, v.host, who);
        notifyQuestion(v.text + '  (from the ' + who + ')', v.idx);
      }
    } else if (ev.kind === 'note') {
      var m = userMarks.filter(function (x) { return x.uid === ev.uid; })[0];
      if (!m) addUserMark(v.idx, v.text, { uid: ev.uid, from: who, host: v.host, quiet: true });
      else { m.text = v.text; if (m.wnode) m.wnode.querySelector('.wn-tx').textContent = v.text; }
    }
  }

  /* ================= share mode: the second interviewer's view =========================
     With ./start.sh --share, another computer can open the join link. Its page asks the server
     who it is; as a "viewer" it shows the recording Mac's tree and follows the live interview
     (transcript, coverage, off the record). Recording controls stay on the recording Mac. */
  var VIEWER = false, viewerTree = 0, viewerTimer = null;
  function publishTree() {
    if (VIEWER) return;
    var f = FILES.filter(function (x) { return x.id === ACTIVE; })[0] || {};
    fetch(API + '/api/shared/tree', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.name || 'Interview', data: snap(), notes: pageNotes.map(serializeNote) }) }).catch(function () {});
  }
  function enterViewerMode() {
    VIEWER = true;
    app.classList.add('viewer');
    if (editing) setEdit(false);
    hint.textContent = 'JOINED AS SECOND INTERVIEWER · WAITING FOR THE INTERVIEW TO START';
    viewerSync();
    viewerTimer = setInterval(viewerSync, 2000);
  }
  function viewerSync() {
    Promise.all([
      fetch(API + '/api/status').then(function (r) { return r.json(); }),
      fetch(API + '/api/shared/tree').then(function (r) { return r.json(); })
    ]).then(function (res) {
      var st = res[0], tr = res[1];
      if (tr.ok && tr.version !== viewerTree) {                 // the recording Mac's tree (changed)
        viewerTree = tr.version;
        var f = FILES.filter(function (x) { return x.id === 'shared-view'; })[0];
        if (!f) { f = { id: 'shared-view', name: '', data: tr.data, notes: [] }; FILES.push(f); }
        f.name = '⇄ ' + tr.name; f.data = tr.data; f.notes = tr.notes || [];
        if (ACTIVE !== 'shared-view') { saveActive(); ACTIVE = 'shared-view'; }
        selected = null; restore(tr.data); rebuildPageNotes(f.notes);
        updateFileUI();
        if (live && liveIdx >= 0) rebuildTo(reviewing ? viewIdx : liveIdx, false);   // keep the colours
      }
      if (st.running && (!live || (LIVE.restored && !LIVE.attached))) {   // an interview is on: follow it
        enterLiveView('Watching · live from the recording computer');
        LIVE.src = st.source;
        LIVE.poll = setInterval(livePoll, 1000);
        livePoll();
      } else if (!st.running && live && !LIVE.restored) {       // it ended: keep the transcript readable
        if (LIVE.poll) { clearInterval(LIVE.poll); LIVE.poll = null; }
        LIVE.restored = true; LIVE.attached = false;
        if (LIVE.off) setOffRecord(false, true);
        var rec = caps.querySelector('.rec'); if (rec) rec.textContent = 'Interview ended · you can still read and export it';
        syncTransport();
      }
      if (st.running && live && !LIVE.restored && !!st.off_record !== !!LIVE.off) setOffRecord(!!st.off_record, true);
    }).catch(function () {});
  }
  fetch(API + '/api/whoami').then(function (r) { return r.json(); }).then(function (w) {
    if (w.role === 'viewer') enterViewerMode();
  }).catch(function () {});

