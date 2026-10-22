  // 04-notes.js — Camera helpers and page notes (connectable, foldable, resizable). All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ---------- camera ---------- */
  var cam = { x: 60, y: 40, z: 1 };
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function vh() { return viewport.clientHeight - (live ? 84 : 0); }
  // keep text sharp at every zoom: the GPU fast path is on only while the view is moving
  function moving(el, ms) {
    el.classList.add('moving');
    clearTimeout(el._sharpT);
    el._sharpT = setTimeout(function () { el.classList.remove('moving'); }, ms);
  }
  function apply(animate) {
    moving(world, animate ? 680 : 160);
    world.classList.toggle('glide', !!animate);
    world.style.transform = 'translate(' + cam.x + 'px,' + cam.y + 'px) scale(' + cam.z + ')';
    zoomVal.textContent = Math.round(cam.z * 100) + '%';
    if (animate) setTimeout(function () { world.classList.remove('glide'); }, 620);
  }
  function centerOn(n, z, animate) {
    cam.z = clamp(z || cam.z, .2, 2);
    cam.x = viewport.clientWidth / 2 - (n.x + W[n.depth] / 2) * cam.z;
    cam.y = vh() / 2 - (n.y + n.h / 2) * cam.z;
    apply(animate !== false);
  }
  function frame(list, animate, pad) {
    var vis = list.filter(function (n) { return !isHidden(n); });
    if (!vis.length) return;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    vis.forEach(function (n) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + W[n.depth]); y1 = Math.max(y1, n.y + n.h);
    });
    pad = pad || .88;
    cam.z = clamp(Math.min(viewport.clientWidth / (x1 - x0), vh() / (y1 - y0)) * pad, .2, 1.15);
    cam.x = viewport.clientWidth / 2 - (x0 + x1) / 2 * cam.z;
    cam.y = vh() / 2 - (y0 + y1) / 2 * cam.z;
    apply(animate !== false);
  }
  function subtree(n, acc) {
    acc = acc || []; acc.push(n);
    if (!n.collapsed) n.children.forEach(function (c) { subtree(c, acc); });
    return acc;
  }
  function fitAll() { frame(NODES, true, .9); posLabel.textContent = 'WHOLE TREE'; }
  function toWorld(cx, cy) {
    var r = viewport.getBoundingClientRect();
    return { x: (cx - r.left - cam.x) / cam.z, y: (cy - r.top - cam.y) / cam.z };
  }

  /* ================= page notes: connectable canvas notes ================= */
  var conns = $('conns'), noteBusy = false;
  function updateCollapse(note, animate) {                 // mm note off the mind map = a purple dot
    var want = note.folded && !note.expanded;
    if (note.morph) { note.morph.stop(); note.morph = null; endMorph(note); }
    if (want === note.el.classList.contains('collapsed')) return;
    if (animate && MO && !REDUCED && note.el.offsetParent) morphNote(note, want);
    else note.el.classList.toggle('collapsed', want);
  }
  // card <-> dot: the text fades first, then the card shrinks into the dot (and grows back out
  // of it the other way round) on a soft spring; connectors follow every frame
  function rgbaOf(c) { var m = String(c).match(/[\d.]+/g) || [0, 0, 0]; return [+m[0], +m[1], +m[2], m[3] != null ? +m[3] : 1]; }
  function shadowOf(v) {                                  // "rgba(r,g,b,a) x y blur spread" -> numbers
    var m = String(v).match(/(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?/);
    return m ? { c: rgbaOf(m[1]), x: +m[2], y: +m[3], b: +m[4], s: +(m[5] || 0) } : { c: [0, 0, 0, 0], x: 0, y: 0, b: 0, s: 0 };
  }
  function morphNote(note, collapse) {
    var el = note.el, kids = [].filter.call(el.children, function (c) { return !c.classList.contains('pdot'); });
    // read both end states straight from the CSS (light/dark, custom size), so every property
    // can travel smoothly: size, padding, corners, fill, border and the shadow under it
    function read(dot) {
      el.classList.toggle('collapsed', dot);
      var cs = getComputedStyle(el), w = el.offsetWidth, h = el.offsetHeight;
      return { w: w, h: h, r: dot ? Math.min(w, h) / 2 : (parseFloat(cs.borderTopLeftRadius) || 7),
               bg: rgbaOf(cs.backgroundColor), bw: parseFloat(cs.borderTopWidth) || 0, bc: rgbaOf(cs.borderTopColor),
               sh: shadowOf(cs.boxShadow), pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat) };
    }
    var dot = read(true), card = read(false);
    el.style.overflow = 'hidden'; el.style.minHeight = '0';
    var A = collapse ? card : dot, B = collapse ? dot : card;
    function L(a, b, q) { return a + (b - a) * q; }
    function col(a, b, q) { return 'rgba(' + [0, 1, 2].map(function (i) { return Math.round(L(a[i], b[i], q)); }).join(',') + ',' + L(a[3], b[3], q).toFixed(3) + ')'; }
    function frame(t) {
      var q = collapse ? Math.max(0, (t - 0.15) / 0.85) : Math.min(t / 0.8, Math.max(1, t)), qc = Math.min(1, q);
      var fade = collapse ? Math.max(0, 1 - t / 0.3) : Math.min(1, Math.max(0, (t - 0.55) / 0.45));
      el.style.width = Math.max(6, L(A.w, B.w, q)) + 'px'; el.style.height = Math.max(6, L(A.h, B.h, q)) + 'px';
      el.style.padding = A.pad.map(function (v, i) { return Math.max(0, L(v, B.pad[i], qc)) + 'px'; }).join(' ');
      el.style.borderRadius = L(A.r, B.r, qc) + 'px';
      el.style.background = col(A.bg, B.bg, qc);
      el.style.borderWidth = L(A.bw, B.bw, qc) + 'px'; el.style.borderColor = col(A.bc, B.bc, qc); el.style.borderStyle = 'solid';
      el.style.boxShadow = col(A.sh.c, B.sh.c, qc) + ' ' + L(A.sh.x, B.sh.x, qc) + 'px ' + L(A.sh.y, B.sh.y, qc) + 'px ' +
        L(A.sh.b, B.sh.b, qc) + 'px ' + L(A.sh.s, B.sh.s, qc) + 'px';
      kids.forEach(function (k) { k.style.opacity = fade; });
      drawConns();
    }
    frame(0);
    note.morphTo = collapse;
    note.morph = MO.animate(0, 1, { type: 'spring', visualDuration: collapse ? 0.34 : 0.38, bounce: 0.14,
      onUpdate: frame, onComplete: function () { note.morph = null; endMorph(note); drawConns(); } });
  }
  function endMorph(note) {                                // land on the class-styled end state
    var el = note.el;
    ['width', 'height', 'padding', 'borderRadius', 'background', 'overflow', 'minHeight',
     'borderWidth', 'borderColor', 'borderStyle', 'boxShadow'].forEach(function (k) { el.style[k] = ''; });
    [].forEach.call(el.children, function (k) { k.style.opacity = ''; });
    el.classList.toggle('collapsed', !!note.morphTo);
  }
  function noteById(id) { for (var i = 0; i < pageNotes.length; i++) if (pageNotes[i].id === id) return pageNotes[i]; return null; }
  function drawConns() {
    if (!conns) return;
    var parts = [];
    pageNotes.forEach(function (note) {
      var collapsed = note.el.classList.contains('collapsed');
      var w = collapsed ? 16 : (note.el.offsetWidth || 184), h = collapsed ? 16 : (note.el.offsetHeight || 46);
      var nx = note.x + w / 2, ny = note.y + h / 2;
      note.links.forEach(function (qid) {
        var other = noteById(qid);
        if (other) {                                      // note -> note: dashed, edge facing the source
          if (!other.el.isConnected) return;
          var oc = other.el.classList.contains('collapsed');
          var ow = oc ? 16 : (other.el.offsetWidth || 184), oh = oc ? 16 : (other.el.offsetHeight || 46);
          var bcx = other.x + ow / 2, bcy = other.y + oh / 2, d2;
          if (Math.abs(bcx - nx) >= Math.abs(bcy - ny)) {
            var ex = bcx > nx ? other.x : other.x + ow, sx = bcx > nx ? 1 : -1, ddx = Math.max(28, Math.abs(ex - nx) / 2);
            d2 = 'M' + nx + ' ' + ny + ' C' + (nx + sx * ddx) + ' ' + ny + ',' + (ex - sx * ddx) + ' ' + bcy + ',' + ex + ' ' + bcy;
          } else {
            var ey = bcy > ny ? other.y : other.y + oh, sy = bcy > ny ? 1 : -1, ddy = Math.max(24, Math.abs(ey - ny) / 2);
            d2 = 'M' + nx + ' ' + ny + ' C' + nx + ' ' + (ny + sy * ddy) + ',' + bcx + ' ' + (ey - sy * ddy) + ',' + bcx + ' ' + ey;
          }
          parts.push('<path class="conn-hit" data-note="' + note.id + '" data-q="' + qid + '" d="' + d2 + '"/>' +
                     '<path class="conn nn' + (collapsed || oc ? ' faint' : '') + '" d="' + d2 + '"/>');
          return;
        }
        var n = INDEX[qid]; if (!n || isHidden(n) || n.x == null) return;
        var ncx = n.x + W[n.depth] / 2, ty = n.y + n.h / 2;
        var leftSide = nx < ncx;                          // anchor to the node edge facing the note
        var tx = leftSide ? n.x : n.x + W[n.depth];
        var dx = Math.max(28, Math.abs(tx - nx) / 2);
        var c1x = nx + (tx > nx ? dx : -dx), c2x = leftSide ? tx - dx : tx + dx;
        var d = 'M' + nx + ' ' + ny + ' C' + c1x + ' ' + ny + ',' + c2x + ' ' + ty + ',' + tx + ' ' + ty;
        parts.push('<path class="conn-hit" data-note="' + note.id + '" data-q="' + qid + '" d="' + d + '"/>' +
                   '<path class="conn' + (collapsed ? ' faint' : '') + '" d="' + d + '"/>');
      });
    });
    conns.innerHTML = parts.join('');
  }
  conns.addEventListener('click', function (e) {
    var hit = e.target.closest('.conn-hit'); if (!hit) return;
    var note = pageNotes.filter(function (p) { return p.id === hit.dataset.note; })[0];
    if (note) { pushHistory(); note.links = note.links.filter(function (q) { return q !== hit.dataset.q; }); drawConns(); }
  });

  // move a note by grabbing it anywhere: its edge, its top strip, or its text while you're not
  // typing in it. A press that doesn't move is a click: it starts typing, caret where you clicked.
  function grabNote(el, ev, tx, pos, onMove, onDone) {
    if (tx.contains(ev.target) && document.activeElement === tx) return false;   // typing: select text
    ev.stopPropagation(); ev.preventDefault();
    var s0 = toWorld(ev.clientX, ev.clientY), x0 = pos.x, y0 = pos.y, cx = ev.clientX, cy = ev.clientY, moved = false;
    try { el.setPointerCapture(ev.pointerId); } catch (_e) {}
    function mv(e2) {
      if (!moved && Math.abs(e2.clientX - cx) < 4 && Math.abs(e2.clientY - cy) < 4) return;
      if (!moved) { moved = true; el.classList.add('grabbing'); }
      var p = toWorld(e2.clientX, e2.clientY);
      pos.x = x0 + (p.x - s0.x); pos.y = y0 + (p.y - s0.y);
      el.style.left = pos.x + 'px'; el.style.top = pos.y + 'px'; if (onMove) onMove();
    }
    function up() {
      el.classList.remove('grabbing');
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (!moved) {
        tx.focus();
        var r = document.caretRangeFromPoint && document.caretRangeFromPoint(cx, cy), sel = getSelection();
        if (r && tx.contains(r.startContainer)) { sel.removeAllRanges(); sel.addRange(r); }
        else { sel.selectAllChildren(tx); sel.collapseToEnd(); }
      }
      if (onDone) onDone(moved);
    }
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    return true;
  }

  function wireNote(note) {
    var el = note.el, tx = el.querySelector('.pn-tx');
    tx.addEventListener('focus', function () { note.before = histSnap(); });
    tx.addEventListener('blur', function () {
      if (tx.textContent !== note.text && note.before) pushHistory(note.before);   // the edit is one undo step
      note.before = null; note.text = tx.textContent; scheduleFileSave();
    });
    tx.addEventListener('keydown', function (e) { if (e.key === 'Escape') tx.blur(); e.stopPropagation(); });
    // eye: keep the note open; eye-off: fold it into a purple dot (click the dot to peek)
    el.querySelector('.pn-corner').addEventListener('click', function (e) {
      e.stopPropagation(); pushHistory(); note.folded = !note.folded; note.expanded = false; paintEye(note);
      updateCollapse(note, true); drawConns();
    });
    // collapsed purple dot: click to expand; it folds back to a dot only after the cursor has
    // been off the card for a moment (a brief slip off the edge or onto a connector dot no
    // longer snaps it shut), and never while you're typing in it
    var foldTimer = null;
    el.addEventListener('mouseenter', function () { clearTimeout(foldTimer); });
    el.addEventListener('mouseleave', function () {
      if (!note.folded || !note.expanded || noteBusy) return;
      clearTimeout(foldTimer);
      foldTimer = setTimeout(function () {
        if (document.activeElement && el.contains(document.activeElement)) return;
        if (el.matches(':hover') || noteBusy) return;
        note.expanded = false; updateCollapse(note, true); drawConns();
      }, 700);
    });
    // the card animates between dot and full size: connectors follow once it has its final size
    el.addEventListener('transitionend', function (ev) {
      if (ev.target === el && (ev.propertyName === 'width' || ev.propertyName === 'height')) drawConns();
    });
    el.querySelector('.pn-del').addEventListener('click', function (e) {
      e.stopPropagation(); pushHistory(); el.remove();
      pageNotes = pageNotes.filter(function (p) { return p !== note; });
      pageNotes.forEach(function (p) { p.links = p.links.filter(function (l) { return l !== note.id; }); });
      drawConns(); scheduleFileSave();
    });
    // corner grip: drag to resize (double-click it to go back to the default size)
    var rs = el.querySelector('.pn-rs');
    rs.addEventListener('pointerdown', function (ev) {
      ev.stopPropagation(); ev.preventDefault();
      var s0 = toWorld(ev.clientX, ev.clientY), w0 = el.offsetWidth, h0 = el.offsetHeight, before = histSnap();
      try { rs.setPointerCapture(ev.pointerId); } catch (_e) {}
      el.classList.add('resizing'); noteBusy = true;
      function mv(e2) {
        var p = toWorld(e2.clientX, e2.clientY);
        note.w = Math.round(clamp(w0 + p.x - s0.x, 120, 640));
        note.h = Math.round(clamp(h0 + p.y - s0.y, 46, 700));
        sizeNote(note); drawConns();
      }
      function up() {
        rs.removeEventListener('pointermove', mv); rs.removeEventListener('pointerup', up); rs.removeEventListener('pointercancel', up);
        el.classList.remove('resizing'); noteBusy = false; drawConns();
        if (el.offsetWidth !== w0 || el.offsetHeight !== h0) pushHistory(before); else scheduleFileSave();
      }
      rs.addEventListener('pointermove', mv); rs.addEventListener('pointerup', up); rs.addEventListener('pointercancel', up);
    });
    rs.addEventListener('dblclick', function (ev) {
      ev.stopPropagation(); pushHistory(); note.w = note.h = null; sizeNote(note); drawConns();
    });
    // drag a side dot -> connect to a question node, or to another note
    function dropTarget(x, y) {
      var over = document.elementFromPoint(x, y); if (!over) return null;
      var nd = over.closest('.node[data-id]'); if (nd) return { el: nd, id: nd.dataset.id };
      var pn = over.closest('.pnote');
      if (pn && pn !== el) { var o = pageNotes.filter(function (p) { return p.el === pn; })[0]; if (o) return { el: pn, id: o.id, note: o }; }
      return null;
    }
    el.querySelectorAll('.pdot').forEach(function (dot) {
      dot.addEventListener('pointerdown', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        var w = el.offsetWidth, h = el.offsetHeight, ax = note.x + w / 2, ay = note.y + h / 2, before = histSnap();
        function mv(e2) {
          var p = toWorld(e2.clientX, e2.clientY);
          var t = conns.querySelector('.conn.temp');
          if (!t) { t = document.createElementNS('http://www.w3.org/2000/svg', 'path'); t.setAttribute('class', 'conn temp'); conns.appendChild(t); }
          t.setAttribute('d', 'M' + ax + ' ' + ay + ' L' + p.x + ' ' + p.y);
          document.querySelectorAll('.linktarget').forEach(function (m) { m.classList.remove('linktarget'); });
          var tg = dropTarget(e2.clientX, e2.clientY); if (tg) tg.el.classList.add('linktarget');
        }
        function up(e2) {
          noteBusy = false;
          document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
          var t = conns.querySelector('.conn.temp'); if (t) t.remove();
          document.querySelectorAll('.linktarget').forEach(function (m) { m.classList.remove('linktarget'); });
          var tg = dropTarget(e2.clientX, e2.clientY);
          var already = tg && (note.links.indexOf(tg.id) >= 0 || (tg.note && tg.note.links.indexOf(note.id) >= 0));
          if (tg && !already) { pushHistory(before); note.links.push(tg.id); }
          drawConns();
        }
        noteBusy = true;
        document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
      });
    });
    // drag the note body to move it (or, when collapsed to a dot, click to expand)
    el.addEventListener('pointerdown', function (ev) {
      if (el.classList.contains('collapsed')) {          // clicking the dot opens the note for good;
        ev.stopPropagation();                             // the eye folds it again
        pushHistory(); note.folded = false; note.expanded = false; paintEye(note);
        updateCollapse(note, true); drawConns();
        return;
      }
      if (ev.target.closest('.pdot,.pn-corner,.pn-del')) return;
      var before = histSnap();
      if (grabNote(el, ev, tx, note, drawConns, function (moved) {
        noteBusy = false;
        if (moved) { if (note.live) note.free = true; pushHistory(before); }   // you placed it: it stops following
      })) noteBusy = true;
    });
  }

  function addPageNote(x, y, seed) {
    if (!seed) pushHistory();
    var note = { id: (seed && seed.id) || ('pn' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36)),
      x: x, y: y, text: (seed && seed.text) || '', links: (seed && seed.links) ? seed.links.slice() : [],
      folded: !!(seed && (seed.folded || seed.mm)), w: seed && seed.w, h: seed && seed.h, live: !!(seed && seed.live),
      at: seed && seed.at || null, free: !!(seed && seed.free) };      // 'mm' = older files' "mind map only", now simply folded
    var el = document.createElement('div');
    el.className = 'pnote';
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.innerHTML =
      '<button class="pn-corner"></button>' +
      '<button class="pn-del" title="Delete note">×</button>' +
      '<span class="pn-grip" title="Drag to move"></span>' +
      '<div class="pn-tx" contenteditable="true" spellcheck="false" data-ph="Type a note…">' + esc(note.text) + '</div>' +
      '<span class="pdot t"></span><span class="pdot r"></span><span class="pdot b"></span><span class="pdot l"></span>' +
      '<span class="pn-rs" title="Drag to resize"></span>';
    note.el = el; world.appendChild(el); paintEye(note); sizeNote(note);
    wireNote(note); pageNotes.push(note); updateCollapse(note); drawConns();
    if (!seed) { scheduleFileSave(); setTimeout(function () { el.querySelector('.pn-tx').focus(); }, 30); }
    return note;
  }
  function addPageNoteCentered() {
    var r = viewport.getBoundingClientRect();
    var p = toWorld(r.left + viewport.clientWidth / 2, r.top + viewport.clientHeight / 2);
    return addPageNote(p.x - 92, p.y - 24);
  }
  function serializeNote(n) { return { id: n.id, x: n.x, y: n.y, text: n.text, folded: !!n.folded, links: n.links, w: n.w || undefined, h: n.h || undefined, live: n.live || undefined, at: n.at || undefined, free: n.free || undefined }; }
  // size lives in CSS variables, so the folded-dot style (a fixed 16px) still wins over it
  function sizeNote(note) {
    if (note.w) note.el.style.setProperty('--pw', note.w + 'px'); else note.el.style.removeProperty('--pw');
    if (note.h) note.el.style.setProperty('--ph', note.h + 'px'); else note.el.style.removeProperty('--ph');
  }
  function paintEye(note) {
    var b = note.el.querySelector('.pn-corner');
    note.el.classList.toggle('folded', !!note.folded);
    b.innerHTML = note.folded ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 2.5l11 11"/></svg>' : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
    b.title = note.folded ? 'Folded into a dot — click to keep it open' : 'Kept open — click to fold it into a dot';
    b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(!note.folded));
  }
  function clearPageNotes() { pageNotes.forEach(function (n) { n.el.remove(); }); pageNotes = []; if (conns) conns.innerHTML = ''; }
  function rebuildPageNotes(arr) { clearPageNotes(); (arr || []).forEach(function (s) { addPageNote(s.x, s.y, s); }); drawConns(); }

