  // 11-files.js — Boot, and the tree files menu. All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ---------- boot ---------- */
  /* ================= files: multiple trees / blank pages (tldraw-style) ================= */
  var FILES = [], ACTIVE = null, filesTimer = null, BUILTIN = null;
  function persistFiles() {
    try { localStorage.setItem('fnt_files', JSON.stringify(FILES)); localStorage.setItem('fnt_active', ACTIVE); } catch (e) {}
  }
  function saveActive() {
    var f = FILES.filter(function (x) { return x.id === ACTIVE; })[0]; if (!f) return;
    f.data = snap(); f.notes = pageNotes.map(serializeNote);
    // another window may have saved other trees since this one loaded: take theirs, replace only ours
    try {
      var disk = JSON.parse(localStorage.getItem('fnt_files') || 'null');
      if (disk && disk.length) {
        var has = false;
        FILES = disk.map(function (x) { if (x.id === ACTIVE) { has = true; return f; } return x; });
        if (!has) FILES.push(f);
      }
    } catch (e) {}
    persistFiles();
  }
  // Two windows on this computer share the trees: when the other one saves, this one shows it
  // straight away (instead of later saving its older copy over it). Not during an interview,
  // and not while you have an edit of your own about to be saved.
  window.addEventListener('storage', function (e) {
    if (e.key !== 'fnt_files' || !e.newValue) return;
    var disk; try { disk = JSON.parse(e.newValue); } catch (_e) { return; }
    var mine = disk.filter(function (x) { return x.id === ACTIVE; })[0];
    var busy = live || editing || noteBusy || document.querySelector('[contenteditable="true"]:focus');
    if (busy) {                                   // keep our active tree, take everything else
      var cur = FILES.filter(function (x) { return x.id === ACTIVE; })[0];
      FILES = disk.map(function (x) { return x.id === ACTIVE && cur ? cur : x; });
      renderFileList(); return;
    }
    FILES = disk;
    if (mine && (mine.data !== snap() || JSON.stringify(mine.notes || []) !== JSON.stringify(pageNotes.map(serializeNote)))) {
      clearTimeout(filesTimer);
      if (mine.data !== snap()) restore(mine.data);
      rebuildPageNotes(mine.notes);
    }
    updateFileUI(); renderFileList();
  });
  function scheduleFileSave() {
    if (live && liveReal && !VIEWER) setTimeout(publishTree, 0);   // keep a joined viewer's tree in step
    if (!ACTIVE) return;
    clearTimeout(filesTimer);
    filesTimer = setTimeout(saveActive, 1000);
  }
  function newId() { return 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
  function starterTree() {
    var t = newId(), o = newId();
    return JSON.stringify([{ i: t, k: 'topic', t: 'New topic', m: '4 min', c: false,
      ch: [{ i: o, k: 'opener', t: 'Opening question', c: false, ch: [] }] }]);
  }
  function clearSessionArt() {
    if (live) stopLive();
    clearAnnos();
  }
  function loadFile(id, frameIt) {
    var f = FILES.filter(function (x) { return x.id === id; })[0]; if (!f) return;
    clearSessionArt();
    selected = null;
    restore(f.data);
    rebuildPageNotes(f.notes);
    ACTIVE = id;
    updateFileUI(); persistFiles();
    markHere(1);
    if (frameIt !== false && topics()[0]) { frame(subtree(topics()[0]), false, .84); posLabel.textContent = 'TOPIC 1'; }
  }
  function switchFile(id) {
    closeFileList();
    if (id === ACTIVE) return;
    saveActive(); loadFile(id);
  }
  function newBlank() {
    saveActive();
    var id = newId();
    FILES.push({ id: id, name: 'Untitled ' + (FILES.length + 1), data: starterTree() });
    loadFile(id); renderFileList();
    setEdit(true);
  }
  function deleteFile(id) {
    if (FILES.length <= 1) return;
    var i = FILES.map(function (x) { return x.id; }).indexOf(id);
    FILES.splice(i, 1);
    if (ACTIVE === id) loadFile(FILES[Math.max(0, i - 1)].id);
    persistFiles(); renderFileList();
  }
  function renameFile(id, name) {
    var f = FILES.filter(function (x) { return x.id === id; })[0];
    if (f) { f.name = (name || '').trim() || f.name; persistFiles(); updateFileUI(); }
  }
  function updateFileUI() {
    var f = FILES.filter(function (x) { return x.id === ACTIVE; })[0];
    $('fileName').textContent = f ? f.name : 'file';
    var list = $('fileList');
    if (list && !list.hidden) renderFileList();
  }
  /* ---------- interview sessions, listed under the tree they were run with ----------
     "+ New interview" names a session ahead of time; the next ◉ interview records into it.
     Double-click a name to rename it; click a recorded one to open it. */
  var TREE_SESS = null;
  function treeOfSession(it) {
    if (it.tree_id && FILES.some(function (f) { return f.id === it.tree_id; })) return it.tree_id;
    var byName = FILES.filter(function (f) { return f.name === it.name; })[0];   // older sessions: by tree name
    return byName ? byName.id : null;
  }
  function sessTitle(it) {
    if (it.title) return it.title;
    var d = new Date((it.saved_at || '').replace(' ', 'T'));
    return 'Interview' + (isNaN(d) ? '' : ' · ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toTimeString().slice(0, 5));
  }
  function sessRow(it) {
    var recording = live && liveReal && SESS.id === it.id, next = SESS.planned === it.id;
    var meta = it.lines ? (it.duration || '') + ' · ' + it.lines + ' lines' : (next ? 'next interview' : 'not recorded yet');
    return '<div class="sessrow' + (next ? ' next' : '') + (recording ? ' rec' : '') + '" data-sid="' + esc(it.id) + '" data-lines="' + (it.lines || 0) + '"' +
      ' title="' + (it.lines ? 'Open this interview' : 'Record the next interview into this session') + ' · double-click the name to rename">' +
      '<span class="sico"></span><span class="sname" data-sid="' + esc(it.id) + '">' + esc(sessTitle(it)) + '</span>' +
      '<span class="smeta">' + esc(recording ? 'recording' : meta) + '</span></div>';
  }
  function sessRows(f) {
    var mine = (TREE_SESS || []).filter(function (it) { return treeOfSession(it) === f.id; });
    var html = mine.map(sessRow).join('');
    if (f.id === ACTIVE && !VIEWER && TREE_SESS) html += '<div class="sessnew" data-snew="' + f.id + '">+ New interview</div>';
    return html;
  }
  function loadTreeSessions() {
    if (VIEWER) return;
    fetch(API + '/api/sessions').then(function (r) { return r.json(); })
      .then(function (d) { TREE_SESS = d.sessions || []; if (!$('fileList').hidden) renderFileList(); })
      .catch(function () {});
  }
  function newInterview(treeId) {
    var f = FILES.filter(function (x) { return x.id === treeId; })[0]; if (!f) return;
    var n = (TREE_SESS || []).filter(function (it) { return treeOfSession(it) === treeId; }).length + 1;
    fetch(API + '/api/session/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Interview ' + n, tree_id: treeId, tree_name: f.name }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) return;
        SESS.planned = d.id; SESS.title = d.title;
        TREE_SESS.unshift({ id: d.id, title: d.title, tree_id: treeId, name: f.name, lines: 0 });
        renderFileList();
        var el = $('fileList').querySelector('.sname[data-sid="' + d.id + '"]'); if (el) renameSession(el);   // name it right away
      }).catch(function () {});
  }
  function renameSession(el) {
    el.setAttribute('contenteditable', 'true'); el.focus();
    var r = document.createRange(); r.selectNodeContents(el);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    function done() {
      el.removeEventListener('blur', done); el.removeAttribute('contenteditable');
      var id = el.dataset.sid, title = el.textContent.trim();
      var it = (TREE_SESS || []).filter(function (x) { return x.id === id; })[0];
      if (!title || !it || title === it.title) { renderFileList(); return; }
      it.title = title;
      if (SESS.id === id || SESS.planned === id) SESS.title = title;
      fetch(API + '/api/session/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, title: title }) }).catch(function () {});
      renderFileList();
    }
    el.addEventListener('blur', done);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      else if (e.key === 'Escape') { el.textContent = ''; el.blur(); }
      e.stopPropagation();
    });
  }
  function openTreeSession(row) {
    var id = row.dataset.sid;
    if (row.dataset.lines === '0') {                      // not recorded yet: the next interview goes here
      var it = (TREE_SESS || []).filter(function (x) { return x.id === id; })[0];
      SESS.planned = SESS.planned === id ? null : id; SESS.title = SESS.planned && it ? it.title : null;
      renderFileList(); return;
    }
    fetch(API + '/api/session?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (j) {
      if (j.ok && restoreSession(j.data, false)) closeFileList();
    }).catch(function () {});
  }

  function renderFileList() {
    var list = $('fileList'); if (!list) return;
    var html = '<div class="flhd">TREES</div>';
    FILES.forEach(function (f) {
      html += '<div class="filerow' + (f.id === ACTIVE ? ' on' : '') + '" data-id="' + f.id + '">' +
        '<span class="fdot"></span><span class="fn" data-id="' + f.id + '">' + esc(f.name) + '</span>' +
        '<button class="fx" data-del="' + f.id + '" title="Delete">×</button></div>' +
        '<div class="fsess" data-tree="' + f.id + '">' + sessRows(f) + '</div>';
    });
    var stray = (TREE_SESS || []).filter(function (it) { return !treeOfSession(it); });
    if (stray.length) html += '<div class="flhd">OTHER INTERVIEWS</div><div class="fsess">' + stray.map(sessRow).join('') + '</div>';
    html += '<div class="filenew" id="fileNew"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3.5v9M3.5 8h9"/></svg>New blank tree</div>';
    html += '<div class="filenew" id="fileTpl"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3.5h6l3 3v6H3z"/><path d="M9 3.5v3h3"/></svg>Industrial-design CAD (template)</div>';
    html += '<div class="filenew" id="fileImport"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 10.5v-8M4.5 6L8 2.5 11.5 6"/><path d="M3 12.5h10"/></svg>Import tree</div>';
    html += '<div class="filenew" id="fileSess"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2.5h8l2.5 2.5v8.5H3z"/><path d="M5.5 2.5v3.5h5V2.5"/></svg>Interview session</div>';
    html += '<div class="filenew" id="fileExport"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2.5v8M4.5 7L8 10.5 11.5 7"/><path d="M3 12.5h10"/></svg>Export document</div>';
    list.innerHTML = html;
  }
  function openFileList() { loadTreeSessions(); renderFileList(); $('fileList').hidden = false; $('filemenu').classList.add('open'); }
  function closeFileList() { $('fileList').hidden = true; $('filemenu').classList.remove('open'); }
  function newFromTemplate() {
    if (!BUILTIN) return;
    saveActive();
    var id = newId();
    FILES.push({ id: id, name: 'industrial-design-cad-ai', data: BUILTIN, notes: [] });
    loadFile(id); renderFileList();
  }
  function initFiles() {
    BUILTIN = snap();      // the built-in CAD tree, captured before any saved file replaces it
    var saved = null, savedActive = null;
    try { saved = JSON.parse(localStorage.getItem('fnt_files') || 'null'); savedActive = localStorage.getItem('fnt_active'); } catch (e) {}
    if (saved && saved.length) {
      FILES = saved;
      ACTIVE = (savedActive && saved.some(function (f) { return f.id === savedActive; })) ? savedActive : saved[0].id;
      var f = FILES.filter(function (x) { return x.id === ACTIVE; })[0];
      if (f) { selected = null; restore(f.data); rebuildPageNotes(f.notes); }
    } else {
      ACTIVE = newId();
      FILES = [{ id: ACTIVE, name: 'industrial-design-cad-ai', data: snap() }];
      persistFiles();
    }
    updateFileUI();
    $('fileBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      $('fileList').hidden ? openFileList() : closeFileList();
    });
    $('fileList').addEventListener('click', function (e) {
      if (e.target.closest('[contenteditable="true"]')) return;          // renaming
      var sn = e.target.closest('[data-snew]');
      if (sn) { e.stopPropagation(); newInterview(sn.dataset.snew); return; }
      var srow = e.target.closest('.sessrow');
      if (srow) {                                         // single click waits a moment: a double-click renames
        e.stopPropagation(); clearTimeout(srow._t);
        srow._t = setTimeout(function () { openTreeSession(srow); }, 230); return;
      }
      var del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); deleteFile(del.dataset.del); return; }
      if (e.target.closest('#fileNew')) { newBlank(); return; }
      if (e.target.closest('#fileTpl')) { newFromTemplate(); return; }
      if (e.target.closest('#fileExport')) { closeFileList(); openExport(); return; }
      if (e.target.closest('#fileImport')) { closeFileList(); openImport(); return; }
      if (e.target.closest('#fileSess')) { closeFileList(); openSessions(); return; }
      var fn = e.target.closest('.fn');
      if (fn && fn.getAttribute('contenteditable') === 'true') return;   // editing, don't switch
      var row = e.target.closest('.filerow');
      if (row) switchFile(row.dataset.id);
    });
    $('fileList').addEventListener('dblclick', function (e) {
      var sname = e.target.closest('.sname');
      if (sname) { e.stopPropagation(); clearTimeout(sname.closest('.sessrow')._t); renameSession(sname); return; }
      var fn = e.target.closest('.fn'); if (!fn) return;
      e.stopPropagation();
      fn.setAttribute('contenteditable', 'true'); fn.focus();
      var r = document.createRange(); r.selectNodeContents(fn);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      function done() { fn.removeAttribute('contenteditable'); renameFile(fn.dataset.id, fn.textContent); fn.removeEventListener('blur', done); fn.removeEventListener('keydown', key); }
      function key(ev) { if (ev.key === 'Enter') { ev.preventDefault(); fn.blur(); } if (ev.key === 'Escape') { fn.textContent = ''; fn.blur(); } ev.stopPropagation(); }
      fn.addEventListener('blur', done); fn.addEventListener('keydown', key);
    });
    document.addEventListener('pointerdown', function (e) {
      if (!$('fileList').hidden && !e.target.closest('#filemenu')) closeFileList();
    });
  }

  renumber();
  layout();
  setTimeout(function () { syncTransport(); checkResume(); }, 0);
  buildSpine();
  markHere(1);
  initFiles();
  setLayer('tree');
  setDockLive(false);
  setEdit(false);
  setFollow(true, true);
  setPanelWidth(248);
  setPanel(true);
  frame(subtree(topics()[0]), false, .84);
  posLabel.textContent = 'TOPIC 1';
  drawInspector();
  window.addEventListener('resize', function () { layout(); });
