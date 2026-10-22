  // 06-annotation.js — Annotation page, side panel, follow, edit mode. All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ---------- annotation layer ---------- */
  var annoList = [], layerName = 'tree';

  function addAnno(id, text, kind) {
    var n = INDEX[id]; if (!n) return;
    if (annoList.some(function (a) { return a.id === id && a.kind === kind; })) return;
    var a = { id: id, kind: kind, text: text, stamp: clock(), from: INDEX[current] ? INDEX[current].topic : 1 };
    var el = document.createElement('div');
    el.className = 'anode ' + kind;
    var lab = kind === 'flag' ? 'NEEDS A PROBE' : kind === 'ahead' ? 'ANSWERED AHEAD' : 'ANSWER';
    el.innerHTML = '<span class="m">' + lab + '<span class="src">' + a.stamp +
      (kind === 'ahead' ? ' · FROM T' + a.from : '') + '</span></span>' +
      '<div class="tx" contenteditable="true" spellcheck="false">' + esc(text) + '</div>';
    a.el = el; annoList.push(a); annolayer.appendChild(el);
    if (n.parent && n.parent.collapsed) { n.parent.collapsed = false; ensureFold(n.parent); }
    scheduleLayout();
  }
  // Live coverage can add several annotations per poll; coalesce them into one layout per
  // frame instead of a full re-layout (edges, notes, connectors) for every single match.
  var layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(function () { layoutQueued = false; layout(); });
  }
  function clearAnnos() { annoList.forEach(function (a) { a.el.remove(); }); annoList = []; layoutAnnos(); }

  function layoutAnnos() {
    var lanes = {}, paths = [];
    // read every height in one pass BEFORE any position writes — interleaving reads with
    // writes forces a synchronous reflow per annotation
    var vis = annoList.filter(function (a) {
      var n = INDEX[a.id], show = !!n && !isHidden(n);
      a.el.style.display = show ? '' : 'none';
      return show;
    });
    vis.forEach(function (a) { a.h = a.el.offsetHeight || a.h; });
    vis.forEach(function (a) {
      var n = INDEX[a.id];
      var lane = n.depth, x = X[n.depth] + W[n.depth] + 30, y = n.y + 6;
      lanes[lane] = lanes[lane] || [];
      lanes[lane].forEach(function (p) { if (y < p.b + 7 && y + a.h > p.t - 7) y = p.b + 7; });
      lanes[lane].push({ t: y, b: y + a.h });
      a.el.style.left = x + 'px'; a.el.style.top = y + 'px';
      paths.push('<path class="lead" d="M' + (X[n.depth] + W[n.depth]) + ' ' + (n.y + n.h / 2) + ' L' + x + ' ' + (y + 12) + '"/>');
    });
    leads.innerHTML = paths.join('');
  }

  viewport.addEventListener('dblclick', function (e) {
    if (editing || layerName === 'mindmap') return;
    if (e.target.closest('.node,.fold,.ghost,.pnote,.anode,.zoomctl,.caps,.dock,.transport,.filemenu,.conn-hit,.rater,.qnote,.xmodal,.spkpop')) return;
    var p = toWorld(e.clientX, e.clientY);
    addPageNote(p.x, p.y);            // notes are addable anytime, right on the canvas
  });
  var SCENES = ['tree', 'notes', 'mindmap'];
  function setLayer(name) {
    layerName = name;
    app.classList.toggle('layer-notes', name === 'notes');
    app.classList.toggle('layer-mindmap', name === 'mindmap');
    addNoteBtn.hidden = name !== 'notes';
    layerSw.querySelectorAll('[data-layer]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.layer === name));
    });
    document.querySelectorAll('.dock [data-scene]').forEach(function (b) { b.classList.toggle('on', b.dataset.scene === name); });
    hint.textContent = name === 'notes' ? 'DOUBLE-CLICK TO DROP A STICKY'
      : name === 'mindmap' ? 'MIND MAP · CLICK A TOPIC · DRAG TO MOVE AROUND · ⌥SCROLL TO ZOOM · F RECENTERS'
      : 'DRAG TO PAN · ⌥SCROLL TO ZOOM · E TO EDIT';
    X[2] = name === 'notes' ? X_NOTES : X_TREE;
    NODES.forEach(function (n) { if (n.depth === 2 && n.el) n.el.style.left = X[2] + 'px'; });
    pageNotes.forEach(function (nt) { nt.expanded = false; updateCollapse(nt); });   // dots on tree, full on mind map
    layout();
    if (name === 'mindmap') renderMindmapCards();
    drawInspector();                      // its transcript snippets switch to anonymized on the mind map
  }
  function cycleScene() { setLayer(SCENES[(SCENES.indexOf(layerName) + 1) % SCENES.length]); }
  function setDockLive(on) {
    var d = $('dock'); if (!d) return;
    d.querySelectorAll('.live-act').forEach(function (b) { b.disabled = !on; });
  }
  $('dock').addEventListener('click', function (e) {
    var a = e.target.closest('[data-act]');
    if (a) {
      if (a.dataset.act === 'edit') setEdit(!editing);
      else if (a.dataset.act === 'follow') setFollow(!follow);
      else if (a.dataset.act === 'note') { live ? addLiveNote() : addPageNoteCentered(); }
      else if (a.dataset.act === 'question') addQuestion();
      else if (a.dataset.act === 'record') { startRec(false); stopRec(); }
      return;
    }
    var s = e.target.closest('[data-scene]');
    if (s) setLayer(s.dataset.scene);
  });
  layerSw.addEventListener('click', function (e) {
    var b = e.target.closest('[data-layer]'); if (b) setLayer(b.dataset.layer);
  });

  /* ---------- side panel ---------- */
  var panelW = 248, panelOpen = true;
  function setPanel(open) {
    panelOpen = open;
    bodyEl.classList.toggle('nopanel', !open);
    resizer.title = open ? 'Drag to resize · click to hide' : 'Click to show panel';
    apply(false);
  }
  function setPanelWidth(w) {
    panelW = clamp(w, 180, 560);
    bodyEl.style.setProperty('--insp-w', panelW + 'px');
  }

  resizer.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    try { resizer.setPointerCapture(e.pointerId); } catch (_e) {};
    resizer.classList.add('on');
    var r = bodyEl.getBoundingClientRect(), startX = e.clientX, moved = false;
    function mv(ev) {
      if (!moved && Math.abs(ev.clientX - startX) < 4) return;
      moved = true;
      if (!panelOpen) setPanel(true);
      setPanelWidth(r.right - ev.clientX - 3);
    }
    function up() {
      resizer.classList.remove('on');
      resizer.removeEventListener('pointermove', mv);
      resizer.removeEventListener('pointerup', up);
      if (!moved) setPanel(!panelOpen);
      apply(false);
    }
    resizer.addEventListener('pointermove', mv);
    resizer.addEventListener('pointerup', up);
  });
  resizer.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPanelWidth(panelW + 24); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setPanelWidth(panelW - 24); }
  });

  /* ---------- camera follow ---------- */
  function setFollow(on, silent) {
    follow = !!on;
    followBtn.setAttribute('aria-pressed', String(follow));
    followBtn.textContent = follow ? 'FOLLOW' : 'FREE ROAM';
    var fb = $('dock') && $('dock').querySelector('[data-act="follow"]');
    if (fb) { fb.classList.toggle('on', follow); fb.querySelector('.dtip').firstChild.textContent = follow ? 'Following camera' : 'Free roam'; }
    var st = caps.querySelector('.roam');
    if (st) st.textContent = follow ? '' : 'free roam';
    syncFollowPill();
    if (follow && !silent && live && INDEX[current]) centerOn(INDEX[current], Math.max(cam.z, .78), true);
  }
  followBtn.addEventListener('click', function () { setFollow(!follow); });
  // top bar, during an interview: "Following" while the view tracks the question being asked;
  // "Back to live" (F) once you've moved away, so it's never a mystery why the view stays put
  function syncFollowPill() {
    var p = $('followPill'); if (!p) return;
    p.hidden = !live;
    p.classList.toggle('off', !follow);
    p.innerHTML = follow ? '<i></i>Following' : 'Back to live <b>F</b>';
    p.title = follow ? 'The view follows the question being asked — click to look around freely' : 'Go back to the question being asked';
  }
  $('followPill').addEventListener('click', function () { setFollow(!follow); });
  function breakFollow() { if (live && follow) setFollow(false, true); }

  /* ---------- edit mode ---------- */
  function setEdit(on) {
    if (on && VIEWER) return;                 // the tree belongs to the recording computer
    editing = !!on;
    app.classList.toggle('editing', editing);
    editBtn.setAttribute('aria-pressed', String(editing));
    var eb = $('dock') && $('dock').querySelector('[data-act="edit"]');
    if (eb) eb.classList.toggle('on', editing);
    hint.textContent = editing
      ? 'DRAG TO REORDER · DOUBLE-CLICK TO RENAME · ⏎ SIBLING · ⇥ CHILD'
      : 'DRAG TO PAN · ⌥SCROLL TO ZOOM · E TO EDIT';
    if (editing && layerName === 'notes') setLayer('tree');
    layout();
    drawInspector();
  }
  editBtn.addEventListener('click', function () { setEdit(!editing); });


