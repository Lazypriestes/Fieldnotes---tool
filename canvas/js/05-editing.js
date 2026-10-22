  // 05-editing.js — Pan and zoom, topic spine, editing, drag to reorder, selection, palette. All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ---------- pan & zoom ---------- */
  var pan = null;
  viewport.addEventListener('pointerdown', function (e) {
    var ui = '.debrief,.zoomctl,.caps,.anode,.sticky,.dock,.transport,.rater,.qnote,.livenote,.worldnote,.filemenu,.pnote,.conn-hit,.mmcard,.mmscript,.mmchips,.mmhit,.xmodal,.spkpop';
    var block = layerName === 'notes' ? ui : '.node,.fold,.ghost,' + ui;
    if (e.target.closest(block)) return;
    breakFollow();
    pan = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    viewport.classList.add('dragging');
    try { viewport.setPointerCapture(e.pointerId); } catch (_e) {};
  });
  viewport.addEventListener('pointermove', function (e) {
    if (!pan) return;
    cam.x = pan.cx + (e.clientX - pan.x); cam.y = pan.cy + (e.clientY - pan.y);
    apply(false);
  });
  function endPan() { if (!pan) return; pan = null; viewport.classList.remove('dragging'); nearestTopic(); }
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);

  viewport.addEventListener('wheel', function (e) {
    if (e.target.closest && e.target.closest('.debrief')) return;     // the debrief scrolls normally
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) {   // zoom keeps follow on
      var nz = clamp(cam.z * Math.pow(0.995, e.deltaY), .2, 2);
      if (follow && live && INDEX[current]) {   // pivot on the followed question, not the cursor
        var n = INDEX[current];
        cam.z = nz;
        cam.x = viewport.clientWidth / 2 - (n.x + W[n.depth] / 2) * cam.z;
        cam.y = vh() / 2 - (n.y + n.h / 2) * cam.z;
      } else {
        var r = viewport.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
        cam.x = px - (px - cam.x) * (nz / cam.z);
        cam.y = py - (py - cam.y) * (nz / cam.z);
        cam.z = nz;
      }
    } else { breakFollow(); cam.x -= e.deltaX; cam.y -= e.deltaY; }   // panning drops to free roam
    apply(false); nearestTopic();
  }, { passive: false });

  function zoomBy(f) {
    var nz = clamp(cam.z * f, .2, 2);
    if (follow && live && INDEX[current]) { centerOn(INDEX[current], nz, true); return; }
    var px = viewport.clientWidth / 2, py = vh() / 2;
    cam.x = px - (px - cam.x) * (nz / cam.z);
    cam.y = py - (py - cam.y) * (nz / cam.z);
    cam.z = nz; apply(true);
  }
  $('zoomIn').addEventListener('click', function () { zoomBy(1.25); });
  $('zoomOut').addEventListener('click', function () { zoomBy(.8); });
  $('fit').addEventListener('click', fitAll);
  $('themeBtn').addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
    this.textContent = dark ? '☾' : '☀';
  });

  function toggleHelp(on) { $('helpScrim').hidden = (on === undefined) ? !$('helpScrim').hidden : !on; }
  $('helpBtn').addEventListener('click', function () { toggleHelp(); });
  $('helpX').addEventListener('click', function () { toggleHelp(false); });
  $('helpScrim').addEventListener('mousedown', function (e) { if (e.target === $('helpScrim')) toggleHelp(false); });

  var nrTimer = null;
  function nearestTopic() {
    clearTimeout(nrTimer);
    nrTimer = setTimeout(function () {
      var cyw = (vh() / 2 - cam.y) / cam.z, best = null, bd = 1e12;
      topics().forEach(function (t) {
        var d = Math.abs(t.y + t.h / 2 - cyw);
        if (d < bd) { bd = d; best = t; }
      });
      if (best) markHere(best.n);
    }, 90);
  }

  /* ---------- spine ---------- */
  var segs = [], badges = {};
  function buildSpine() {
    track.innerHTML = ''; segs = [];
    topics().forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'seg'; b.style.flexGrow = t.minutes;
      b.innerHTML = '<span class="lab">' + t.n + ' ' + esc(t.text.split(/[,&]/)[0].trim()) + '</span><span class="fill"></span>';
      b.addEventListener('click', function () {
        frame(subtree(t), true, .84); markHere(t.n); posLabel.textContent = 'TOPIC ' + t.n;
      });
      track.appendChild(b); segs.push(b);
    });
    coverage();
    Object.keys(badges).forEach(function (k) { paintBadge(+k); });
    markHere(hereTopic);
  }
  function markHere(n) {
    hereTopic = n;
    segs.forEach(function (s, i) { s.classList.toggle('here', topics()[i] && topics()[i].n === n); });
  }
  function coverage() {
    topics().forEach(function (t, i) {
      if (!segs[i]) return;
      var sc = 0;
      t.qs.forEach(function (q) { sc += state[q.id] === 'green' ? 1 : state[q.id] === 'amber' ? .4 : 0; });
      segs[i].querySelector('.fill').style.width = (t.qs.length ? sc / t.qs.length * 100 : 0) + '%';
    });
  }
  function paintBadge(topicNum) {
    var i = topics().map(function (t) { return t.n; }).indexOf(topicNum);
    if (i < 0 || !segs[i]) return;
    var b = segs[i].querySelector('.badge');
    if (!b) { b = document.createElement('span'); b.className = 'badge'; segs[i].appendChild(b); }
    b.textContent = badges[topicNum];
  }
  function badge(topicNum) { badges[topicNum] = (badges[topicNum] || 0) + 1; paintBadge(topicNum); }
  function clearBadges() {
    badges = {};
    segs.forEach(function (s) { var b = s.querySelector('.badge'); if (b) b.remove(); });
  }

  /* ---------- editing ---------- */
  function newNode(kind, depth, text) {
    return mk({ kind: kind, depth: depth, text: text, collapsed: false });
  }

  function addTopic(index) {
    pushHistory();
    var t = newNode('topic', 0, 'New topic');
    t.mins = '4 min';
    attach(ROOT, t, index);
    attach(t, newNode('opener', 1, 'New opening question'));
    renumber(); layout(); buildSpine();
    select(t.id); edit(t.id);
    return t;
  }
  function addChild(parent, index) {
    pushHistory();
    var d = parent.depth + 1;
    var n = newNode(d === 1 ? 'standard' : 'follow', d, d === 1 ? 'New question' : 'New follow-up');
    attach(parent, n, index);
    if (parent.collapsed) parent.collapsed = false;
    renumber(); layout();
    if (parent.depth === 0) buildSpine();
    select(n.id); edit(n.id);
    return n;
  }
  function addSibling(n) {
    if (n.depth === 0) return addTopic(topics().indexOf(n) + 1);
    return addChild(n.parent, n.parent.children.indexOf(n) + 1);
  }
  function del(n) {
    pushHistory();
    var wasTopic = n.depth === 0, nxt = n.parent;
    removeNode(n);
    if (selected === n.id) selected = null;
    renumber(); layout();
    if (wasTopic) buildSpine();
    if (nxt && nxt.id !== '_root') select(nxt.id, false); else drawInspector();
  }

  function edit(id) {
    var n = INDEX[id]; if (!n) return;
    var before = snap(), was = n.text;
    var q = n.el.querySelector('.q');
    q.setAttribute('contenteditable', 'true');
    q.focus();
    var r = document.createRange(); r.selectNodeContents(q);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    function commit() {
      q.removeAttribute('contenteditable');
      n.text = q.textContent.trim() || n.text;
      if (n.text !== was) pushHistory(before);
      q.textContent = n.text;
      measure(n); layout();
      if (n.depth === 0) buildSpine();
      if (selected === n.id) drawInspector();
      q.removeEventListener('blur', commit);
      q.removeEventListener('keydown', key);
    }
    function key(e) {
      if (e.key === 'Enter') { e.preventDefault(); q.blur(); }
      if (e.key === 'Escape') { q.textContent = n.text; q.blur(); }
      e.stopPropagation();
    }
    q.addEventListener('blur', commit);
    q.addEventListener('keydown', key);
  }

  world.addEventListener('dblclick', function (e) {
    if (!editing) return;
    var el = e.target.closest('.node');
    if (el && !e.target.closest('.ctl')) { e.stopPropagation(); edit(el.dataset.id); }
  });

  world.addEventListener('click', function (e) {
    var g = editing && e.target.closest('[data-ghost]');
    if (g) {
      var pid = g.dataset.ghost;
      if (pid === '_root') addTopic(); else addChild(INDEX[pid]);
      return;
    }
    var act = editing && e.target.closest('[data-act]');
    if (act) {
      var n = INDEX[act.closest('.node').dataset.id];
      if (act.dataset.act === 'add') addSibling(n); else del(n);
      return;
    }
    var f = e.target.closest('[data-fold]');
    if (f) { var m = INDEX[f.dataset.fold]; m.collapsed = !m.collapsed; ensureFold(m); LAYOUT_ANIM.anchor = m; layout(); return; }
    var nd = e.target.closest('[data-id]');
    if (nd && !dragMoved) select(nd.dataset.id, false);
  });

  var allOpen = false;
  var _expandAll = $('expandAll');
  if (_expandAll) _expandAll.addEventListener('click', function () {
    allOpen = !allOpen;
    NODES.forEach(function (n) { if (n.depth === 1 && n.children.length) n.collapsed = !allOpen; });
    layout();
    this.textContent = allOpen ? 'COLLAPSE ALL' : 'EXPAND ALL';
  });

  /* ---------- drag to reorder ---------- */
  var drag = null, dragMoved = false;
  world.addEventListener('pointerdown', function (e) {
    var el = e.target.closest('.node');
    if (!editing) return;
    if (!el || e.target.closest('.ctl') || e.target.closest('[contenteditable="true"]')) return;
    if (app.classList.contains('layer-notes') || app.classList.contains('layer-mindmap')) return;
    var n = INDEX[el.dataset.id];
    var p = toWorld(e.clientX, e.clientY);
    drag = { n: n, ox: p.x - n.x, oy: p.y - n.y, started: false, pid: e.pointerId };
    dragMoved = false;
    try { el.setPointerCapture(e.pointerId); } catch (_e) {};
  });

  world.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var p = toWorld(e.clientX, e.clientY);
    var n = drag.n;
    if (!drag.started) {
      if (Math.abs(p.y - drag.oy - n.y) < 4 && Math.abs(p.x - drag.ox - n.x) < 4) return;
      drag.started = true; dragMoved = true;
      n.el.classList.add('dragging');
    }
    n.el.style.left = (p.x - drag.ox) + 'px';
    n.el.style.top = (p.y - drag.oy) + 'px';
    var t = dropTarget(n, p.y);
    drag.target = t;
    if (t) {
      dropline.style.display = 'block';
      dropline.style.left = X[n.depth] + 'px';
      dropline.style.width = W[n.depth] + 'px';
      dropline.style.top = t.y + 'px';
    } else dropline.style.display = 'none';
  });

  function dropTarget(n, cursorY) {
    var cands = n.depth === 0 ? [ROOT]
      : NODES.filter(function (m) { return m.depth === n.depth - 1 && !isHidden(m) && !m.collapsed && m !== n; });
    if (!cands.length) return null;
    var best = null, bd = 1e12;
    cands.forEach(function (c) {
      var kids = c.children.filter(function (k) { return k !== n; });
      var top = kids.length ? kids[0].y : (c.y || 0);
      var bot = kids.length ? kids[kids.length - 1].y + kids[kids.length - 1].h : (c.y || 0) + (c.h || 0);
      var d = cursorY < top ? top - cursorY : cursorY > bot ? cursorY - bot : 0;
      if (d < bd) { bd = d; best = c; }
    });
    if (!best) return null;
    var kids = best.children.filter(function (k) { return k !== n; });
    var idx = kids.length;
    for (var i = 0; i < kids.length; i++) {
      if (cursorY < kids[i].y + kids[i].h / 2) { idx = i; break; }
    }
    var y = kids.length === 0 ? (best.y || 0) + (best.h || 0) / 2
      : idx === 0 ? kids[0].y - 6
      : kids[idx - 1].y + kids[idx - 1].h + 4;
    return { parent: best, index: idx, y: y };
  }

  function endDrag() {
    if (!drag) return;
    var n = drag.n, t = drag.target;
    n.el.classList.remove('dragging');
    dropline.style.display = 'none';
    if (drag.started && t) {
      pushHistory();
      // t.index is already computed with n excluded from the sibling list, so no extra shift
      detach(n);
      attach(t.parent, n, t.index);
      if (n.depth !== t.parent.depth + 1) {
        walk(n, function (m) { m.depth = Math.min(2, m.parent.depth + 1); if (m.el) { m.el.style.width = W[m.depth] + 'px'; } });
      }
      renumber(); buildSpine();
    }
    layout();
    drag = null;
    setTimeout(function () { dragMoved = false; }, 0);
  }
  world.addEventListener('pointerup', endDrag);
  world.addEventListener('pointercancel', endDrag);

  /* ---------- selection & inspector ---------- */
  // go to a question from elsewhere (an "answered ahead" pop-up, the side panel, the mind map):
  // pause follow so the view stays there, open its branch, glide to it and flash it
  function jumpTo(id) {
    var n = INDEX[id]; if (!n) return;
    if (layerName === 'mindmap') setLayer('tree');
    breakFollow();
    select(id, true);                       // reveals collapsed parents, selects, glides the camera
    n.el.classList.remove('mmflash'); void n.el.offsetWidth; n.el.classList.add('mmflash');
    setTimeout(function () { n.el.classList.remove('mmflash'); }, 1700);
  }
  function select(id, moveCam) {
    var n = INDEX[id]; if (!n) return;
    selected = id;
    NODES.forEach(function (m) { m.el.classList.toggle('sel', m.id === id); });
    var p = n.parent, changed = false;
    while (p && p.id !== '_root') { if (p.collapsed) { p.collapsed = false; ensureFold(p); changed = true; } p = p.parent; }
    if (changed) layout();
    if (moveCam) centerOn(n, Math.max(cam.z, .7), true);
    markHere(n.topic || hereTopic);
    posLabel.textContent = (n.label === '↳' ? 'FOLLOW-UP' : n.label) + (n.depth ? ' · TOPIC ' + n.topic : '');
    drawInspector();
  }

  function drawInspector() {
    var n = INDEX[selected], html = '';
    if (live && notes.length) {
      html += '<div class="kicker">COVERED OUT OF ORDER · ' + notes.length + '</div><div class="notes">';
      notes.slice().reverse().forEach(function (x) {
        html += '<button class="note" data-jump="' + x.id + '"><b>' + x.label + ' · TOPIC ' + x.topic + '</b>' +
          (layerName === 'mindmap' ? anonHTML(x.text) : esc(x.text)) + '</button>';   // mind map: anonymized only
      });
      html += '</div><div class="hr" style="margin-top:6px"></div>';
    }
    if (!n) { html += '<div class="empty">Select a node, or double-click one to rename it.</div>'; insp.innerHTML = html; wireInsp(); return; }
    if (n.kind === 'topic') {
      html += '<div class="kicker">' + n.label + '</div>' +
        '<div class="fld"><label>Title</label><div class="qbox" contenteditable="EDITABLE" data-edit="' + n.id + '">' + esc(n.text) + '</div></div>' +
        '<div class="fld"><label>Time budget</label><div class="qbox" contenteditable="EDITABLE" data-mins="' + n.id + '">' + esc(n.mins) + '</div></div>' +
        '<div class="empty">' + n.qs.length + ' questions. Drag the topic card to reorder it; the spine and all IDs renumber.</div>' +
        '<div class="fld"><button class="ai-btn wide" id="autoTopic">✦ Auto-fill cues for every question in this topic</button></div>';
      insp.innerHTML = html.replace(/contenteditable="EDITABLE"/g, 'contenteditable="' + editing + '"'); wireInsp();
      var at = $('autoTopic'); if (at) at.addEventListener('click', function () { autoFillTopic(n, at); });
      return;
    }
    var isF = n.depth === 2;
    html += '<div class="kicker">' + (n.kind === 'opener' ? 'TOPIC ' + n.topic + ' OPENER' : isF ? 'FOLLOW-UP TO ' + n.parent.label : n.label) + '</div>';
    html += '<div class="fld"><label>Question</label><div class="qbox" contenteditable="EDITABLE" data-edit="' + n.id + '">' + esc(n.text) + '</div></div>';
    html += '<div class="fld"><label>Counts as asking <button class="ai-btn" data-aiasks="' + n.id + '">✦ auto</button></label>' +
      '<div class="tags">' +
      nodeAsks(n).map(function (c) { return '<span class="tag">' + esc(c) + '<button class="tagx" data-rmask="' + esc(c) + '">×</button></span>'; }).join('') +
      '<span class="tag add" id="addAsk">+</span></div></div>';
    html += '<div class="fld"><label>Counts as answered <button class="ai-btn" data-aicues="' + n.id + '">✦ auto</button></label>' +
      '<div class="tags">' +
      nodeCues(n).map(function (c) { return '<span class="tag">' + esc(c) + '<button class="tagx" data-rmcue="' + esc(c) + '">×</button></span>'; }).join('') +
      '<span class="tag add" id="addCue">+</span></div></div>';
    var sv = Math.round(nodeSens(n) * 100);
    html += '<div class="fld"><label>How specific an answer must be' + (n.sensManual ? '' : ' <span class="autotag">auto</span>') +
      '</label><div class="sens">' +
      '<input type="range" min="30" max="90" value="' + sv + '" id="sens"><span class="v" id="sensv">' + sensWord(sv / 100) + '</span></div></div>';
    if (live) {
      var s = state[selected] || 'red';
      html += '<div class="hr"></div><div class="fld"><label>Status</label><div class="qbox" style="color:var(--' + s + ')">' +
        (s === 'green' ? 'Answered' : s === 'amber' ? 'Touched on' : 'Not covered') + '</div></div>';
    }
    insp.innerHTML = html.replace(/contenteditable="EDITABLE"/g, 'contenteditable="' + editing + '"'); wireInsp();
  }

  function wireInsp() {
    var sens = $('sens');
    if (sens) {
      sens.addEventListener('input', function () { $('sensv').textContent = sensWord(sens.value / 100); });
      sens.addEventListener('change', function () {            // you set it: it stays yours
        var n = INDEX[selected]; if (!n) return;
        n.sens = sens.value / 100; n.sensManual = true;
        scheduleFileSave(); planSync(); drawInspector();
      });
    }
    insp.querySelectorAll('[data-jump]').forEach(function (b) {
      b.addEventListener('click', function () { jumpTo(b.dataset.jump); });
    });
    insp.querySelectorAll('[data-edit]').forEach(function (d) {
      var before = null, was = null;
      d.addEventListener('focus', function () { before = snap(); was = d.textContent; });
      d.addEventListener('blur', function () {
        var n = INDEX[d.dataset.edit]; if (!n) return;
        if (before !== null && d.textContent !== was) pushHistory(before);
        n.text = d.textContent.trim() || n.text;
        n.el.querySelector('.q').textContent = n.text;
        measure(n); layout(); if (n.depth === 0) buildSpine();
      });
      d.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); d.blur(); } e.stopPropagation(); });
    });
    insp.querySelectorAll('[data-mins]').forEach(function (d) {
      var before = null, was = null;
      d.addEventListener('focus', function () { before = snap(); was = d.textContent; });
      d.addEventListener('blur', function () {
        var n = INDEX[d.dataset.mins]; if (!n) return;
        if (before !== null && d.textContent !== was) pushHistory(before);
        n.mins = d.textContent.trim() || n.mins;
        renumber(); layout(); buildSpine();
      });
      d.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); d.blur(); } e.stopPropagation(); });
    });
    // ---- editable cue fields (remove / manual add / AI auto) ----
    wireCueField(nodeAsks, 'asking', 'data-rmask', 'addAsk', 'data-aiasks');
    wireCueField(nodeCues, 'answered', 'data-rmcue', 'addCue', 'data-aicues');
  }

  // ✦ for a whole topic: both cue lists for each question and follow-up, one after another
  function autoFillTopic(t, btn) {
    var list = [];
    t.children.forEach(function (q) { list.push(q); q.children.forEach(function (f) { list.push(f); }); });
    var i = 0, failed = 0;
    btn.disabled = true;
    (function next() {
      if (i >= list.length) {
        scheduleFileSave(); planSync();
        btn.textContent = failed ? '✦ Done — ' + failed + ' could not be filled (is Ollama running?)' : '✦ Done — ' + list.length + ' questions filled';
        btn.disabled = false;
        return;
      }
      var n = list[i++];
      btn.textContent = '…' + i + ' / ' + list.length + ' · ' + n.text.slice(0, 32);
      var ask = function (kind) {
        return fetch(API + '/api/cues', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: n.text, kind: kind, context: cueContext(n) }) })
          .then(function (r) { return r.json(); }).then(function (d) { if (!d.ok) throw 0; applyAutoCues(n, kind, d); });
      };
      ask('asking').then(function () { return ask('answered'); }).catch(function () { failed++; }).then(next);
    })();
  }
  function mineOf(n, kind) {
    if (kind === 'asking') return n.asksMine || (n.asksMine = []);
    return n.cuesMine || (n.cuesMine = []);
  }
  // ✦ auto result: generated cues replace the previous generated/default ones; yours stay
  function applyAutoCues(n, kind, d) {
    var mine = mineOf(n, kind), next = mine.slice();
    (d.cues || []).forEach(function (x) { if (next.indexOf(x) < 0) next.push(x); });
    if (kind === 'asking') n.asks = next; else n.cues = next;
    if (kind === 'answered' && d.strictness && !n.sensManual) n.sens = SENS_OF[d.strictness];
  }
  // what the cue generator needs to read a question the way it's meant here
  var planTimer = null;
  function planSync() {
    if (!live || !liveReal || VIEWER || (LIVE.restored && !LIVE.attached)) return;
    clearTimeout(planTimer);
    planTimer = setTimeout(function () {
      var plan = buildPlan(); plan.rescan = false;              // keep the coverage so far
      fetch(API + '/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan) }).catch(function () {});
    }, 1200);
  }
  function cueContext(n) {
    var t = topicOf(n), f = FILES.filter(function (x) { return x.id === ACTIVE; })[0];
    var sibs = (n.parent && n.parent !== ROOT ? n.parent.children : []).filter(function (x) { return x !== n; })
      .map(function (x) { return x.text; });
    return { interview: f ? f.name : '', topic: t ? t.text : '', siblings: sibs,
             parent: n.depth === 2 && n.parent ? n.parent.text : null };
  }
  function wireCueField(getArr, aiKind, rmAttr, addId, aiAttr) {
    insp.querySelectorAll('[' + rmAttr + ']').forEach(function (b) {
      b.addEventListener('click', function () {
        var n = INDEX[selected]; if (!n) return;
        var a = getArr(n), v = b.getAttribute(rmAttr), i = a.indexOf(v), mine = mineOf(n, aiKind);
        if (i > -1) a.splice(i, 1);
        if (mine.indexOf(v) > -1) mine.splice(mine.indexOf(v), 1);
        scheduleFileSave(); planSync(); drawInspector();
      });
    });
    var add = $(addId);
    if (add) add.addEventListener('click', function () {
      var inp = document.createElement('input');
      inp.className = 'tag-input'; inp.placeholder = 'add…';
      add.replaceWith(inp); inp.focus();
      var done = false;
      function commit(save) {
        if (done) return; done = true;
        var n = INDEX[selected], v = inp.value.trim().toLowerCase();
        if (save && v && n) {
          var a = getArr(n), mine = mineOf(n, aiKind);
          if (a.indexOf(v) < 0) a.push(v);
          if (mine.indexOf(v) < 0) mine.push(v);              // typed by you: auto never removes it
          scheduleFileSave(); planSync();
        }
        drawInspector();
      }
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        else if (e.key === 'Escape') { commit(false); }
        e.stopPropagation();
      });
      inp.addEventListener('blur', function () { commit(true); });
    });
    var ai = insp.querySelector('[' + aiAttr + ']');
    if (ai) ai.addEventListener('click', function () {
      var n = INDEX[selected]; if (!n) return;
      ai.classList.add('busy'); ai.textContent = '…thinking';
      fetch(API + '/api/cues', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: n.text, kind: aiKind, context: cueContext(n) }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { applyAutoCues(n, aiKind, d); scheduleFileSave(); planSync(); drawInspector(); })
        .catch(function () { ai.textContent = 'no server'; setTimeout(function () { if (ai.isConnected) { ai.classList.remove('busy'); ai.textContent = '✦ auto'; } }, 1500); });
    });
  }

  /* ---------- palette ---------- */
  var palRows = [], palOn = 0;
  function openPal() { scrim.hidden = false; palInput.value = ''; palInput.focus(); fillPal(''); }
  function closePal() { scrim.hidden = true; }
  function fillPal(q) {
    q = q.trim().toLowerCase();
    palRows = NODES.filter(function (n) { return !q || (n.text + ' ' + n.label + ' ' + n.id).toLowerCase().indexOf(q) > -1; }).slice(0, 40);
    palOn = 0;
    if (!palRows.length) { palList.innerHTML = '<li class="none">No question matches that.</li>'; return; }
    palList.innerHTML = palRows.map(function (n, i) {
      return '<li class="' + (i ? '' : 'on') + '" data-i="' + i + '"><span class="pid">' +
        (n.kind === 'topic' ? 'TOPIC' : n.kind === 'opener' ? 'OPEN' : n.label) + '</span><span class="ptx">' +
        esc(n.text.slice(0, 76)) + '</span><span class="ptp">' + (n.topic || '') + '</span></li>';
    }).join('');
  }
  function movePal(d) {
    var items = palList.children; if (!palRows.length) return;
    items[palOn].classList.remove('on');
    palOn = (palOn + d + palRows.length) % palRows.length;
    items[palOn].classList.add('on'); items[palOn].scrollIntoView({ block: 'nearest' });
  }
  palInput.addEventListener('input', function () { fillPal(this.value); });
  palList.addEventListener('click', function (e) {
    var li = e.target.closest('li[data-i]'); if (li) { select(palRows[+li.dataset.i].id, true); closePal(); }
  });
  scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) closePal(); });
  $('palBtn').addEventListener('click', openPal);
  document.addEventListener('keydown', function (e) {
    var xm = document.querySelector('.xmodal:not([hidden])');   // export / import window: no shortcuts
    if (xm) { if (e.key === 'Escape') xm.hidden = true; return; }
    if (e.target.closest && e.target.closest('input, textarea, select')) return;   // typing a name, not a shortcut
    if (!$('helpScrim').hidden) { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); toggleHelp(false); } return; }
    if (e.key === '?' && !e.metaKey && !e.ctrlKey && !document.querySelector('[contenteditable="true"]:focus')) { e.preventDefault(); toggleHelp(true); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPal(); return; }
    if (!scrim.hidden) {
      if (e.key === 'Escape') closePal();
      else if (e.key === 'ArrowDown') { e.preventDefault(); movePal(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); movePal(-1); }
      else if (e.key === 'Enter' && palRows[palOn]) { select(palRows[palOn].id, true); closePal(); }
      return;
    }
    if (document.querySelector('[contenteditable="true"]:focus')) return;
    if (rateTarget) {
      if (live && e.key >= '1' && e.key <= '3') { e.preventDefault(); applyRate(+e.key); return; }
      if (live && e.key.toLowerCase() === 'n') { e.preventDefault(); applyRate('note'); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideRater(); return; }
      hideRater();   // any other feature engaged — dismiss the rater, then let the key act
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault(); if (e.shiftKey) redo(); else undo(); return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === '\\') { e.preventDefault(); setPanel(!panelOpen); return; }
    if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); layerName === 'mindmap' ? dbRecenter() : setFollow(!follow); return; }
    if (e.key.toLowerCase() === 'e' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setEdit(!editing); return; }
    if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); cycleScene(); return; }
    if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); live ? addLiveNote() : addPageNoteCentered(); return; }
    if (live && e.key.toLowerCase() === 'q' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); addQuestion(); return; }
    if (live && e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); startRec(e.repeat); return; }
    if (!editing || !selected) return;
    if (e.key === 'Enter') { e.preventDefault(); addSibling(INDEX[selected]); }
    if (e.key === 'Tab') { e.preventDefault(); addChild(INDEX[selected]); }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); del(INDEX[selected]); }
  });

