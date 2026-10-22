  // 11-files.js — Boot, and the tree files menu. All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ---------- boot ---------- */
  /* ================= files: multiple trees / blank pages (tldraw-style) ================= */
  var FILES = [], ACTIVE = null, filesTimer = null, BUILTIN = null;
  function persistFiles() {
    try { localStorage.setItem('fnt_files', JSON.stringify(FILES)); localStorage.setItem('fnt_active', ACTIVE); } catch (e) {}
  }
  function saveActive() {
    var f = FILES.filter(function (x) { return x.id === ACTIVE; })[0];
    if (f) { f.data = snap(); f.notes = pageNotes.map(serializeNote); persistFiles(); }
  }
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
    if (typeof stickies !== 'undefined') { stickies.forEach(function (s) { s.el.remove(); }); stickies.length = 0; }
    clearAnnos(); if (typeof updateCount === 'function') updateCount();
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
  function renderFileList() {
    var list = $('fileList'); if (!list) return;
    var html = '<div class="flhd">TREES</div>';
    FILES.forEach(function (f) {
      html += '<div class="filerow' + (f.id === ACTIVE ? ' on' : '') + '" data-id="' + f.id + '">' +
        '<span class="fdot"></span><span class="fn" data-id="' + f.id + '">' + esc(f.name) + '</span>' +
        '<button class="fx" data-del="' + f.id + '" title="Delete">×</button></div>';
    });
    html += '<div class="filenew" id="fileNew"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3.5v9M3.5 8h9"/></svg>New blank tree</div>';
    html += '<div class="filenew" id="fileTpl"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3.5h6l3 3v6H3z"/><path d="M9 3.5v3h3"/></svg>Industrial-design CAD (template)</div>';
    html += '<div class="filenew" id="fileImport"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 10.5v-8M4.5 6L8 2.5 11.5 6"/><path d="M3 12.5h10"/></svg>Import tree</div>';
    html += '<div class="filenew" id="fileSess"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2.5h8l2.5 2.5v8.5H3z"/><path d="M5.5 2.5v3.5h5V2.5"/></svg>Interview session</div>';
    html += '<div class="filenew" id="fileExport"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2.5v8M4.5 7L8 10.5 11.5 7"/><path d="M3 12.5h10"/></svg>Export document</div>';
    list.innerHTML = html;
  }
  function openFileList() { renderFileList(); $('fileList').hidden = false; $('filemenu').classList.add('open'); }
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
