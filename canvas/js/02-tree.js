  // 02-tree.js — Rendering question nodes and laying out the tree (animated). All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ---------- rendering ---------- */
  var chev = '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M2 1 L6 4 L2 7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  function ensureEl(n) {
    if (n.el) return;
    var el = document.createElement('div');
    el.className = 'node ' + (n.kind === 'fprobe' ? 'follow probe' : n.kind === 'probe' ? 'probe' : n.kind) + (n.added ? ' qadded' : '');
    el.dataset.id = n.id;
    el.tabIndex = 0;
    el.style.width = W[n.depth] + 'px';
    el.style.left = X[n.depth] + 'px';
    el.innerHTML = '<span class="edge3"></span><span class="id"></span>' +
      '<span class="q">' + esc(n.text) + '</span>' +
      (n.kind === 'topic' ? '<span class="mins"></span>' : '') +
      '<span class="ctl"><button data-act="add" title="Add after">+</button>' +
      '<button class="del" data-act="del" title="Delete">−</button></span>';
    n.el = el; world.appendChild(el);

    if (n.depth < 2) {
      var g = document.createElement('div');
      g.className = 'ghost'; g.dataset.ghost = n.id;
      g.style.width = W[n.depth + 1] + 'px';
      g.style.left = X[n.depth + 1] + 'px';
      g.textContent = n.depth === 0 ? '+ QUESTION' : '+ FOLLOW-UP';
      n.ghostEl = g; world.appendChild(g);
      n.ghost = { isGhost: true, h: 26, depth: n.depth + 1, parent: n, children: [] };
    }
    measure(n);
  }

  function refreshLabel(n) {
    if (!n.el) return;
    var idline = n.kind === 'topic' ? n.label
      : n.kind === 'opener' ? 'OPENER'
      : n.kind === 'probe' ? n.label + ' · PROBE'
      : n.depth === 2 ? '' : n.label;
    var idEl = n.el.querySelector('.id');
    idEl.textContent = idline;
    idEl.style.display = idline ? '' : 'none';
    var m = n.el.querySelector('.mins');
    if (m) m.textContent = '~' + n.mins + ' · ' + (n.qs ? n.qs.length : 0) + ' questions';
  }

  function measure(n) {
    var d = n.el.style.display;
    n.el.style.display = '';
    n.h = n.el.offsetHeight;
    n.el.style.display = d;
  }

  function removeNode(n) {
    walk(n, function (m) {
      if (m.el) m.el.remove();
      if (m.ghostEl) m.ghostEl.remove();
      if (m.fold) { m.fold.remove(); m.fold = null; }
      delete INDEX[m.id];
      var i = NODES.indexOf(m); if (i > -1) NODES.splice(i, 1);
      annoList = annoList.filter(function (a) {
        if (a.id === m.id) { a.el.remove(); return false; } return true;
      });
    });
    detach(n);
  }

  var rootGhost = document.createElement('div');
  rootGhost.className = 'ghost'; rootGhost.dataset.ghost = '_root';
  rootGhost.style.width = W[0] + 'px'; rootGhost.style.left = X[0] + 'px';
  rootGhost.textContent = '+ TOPIC';
  world.appendChild(rootGhost);
  ROOT.ghostEl = rootGhost;
  ROOT.ghost = { isGhost: true, h: 26, depth: 0, parent: ROOT, children: [] };

  function ensureFold(n) {
    if (!n.children.length) { if (n.fold) { n.fold.remove(); n.fold = null; } return; }
    if (!n.fold) {
      var f = document.createElement('button');
      f.className = 'fold'; f.dataset.fold = n.id;
      n.fold = f; world.appendChild(f);
    }
    n.fold.setAttribute('aria-expanded', String(!n.collapsed));
    n.fold.innerHTML = chev + '<span>' + n.children.length + '</span>';
  }

  /* ---------- layout ---------- */
  function place(n, y) {
    var kids = n.collapsed ? [] : n.children.slice();
    if (editing && !n.collapsed && n.ghost) kids.push(n.ghost);
    if (!kids.length) { n.y = y; return y + n.h + GAP[n.depth]; }
    var cy = y;
    kids.forEach(function (k) { cy = place(k, cy); });
    if (n.depth === 0) cy += BLOCK_GAP;   // block-to-block separation
    if (n.depth < 0) { n.y = 0; return cy; }
    var f = kids[0], l = kids[kids.length - 1];
    n.y = (f.y + l.y + l.h) / 2 - n.h / 2;
    return Math.max(cy, n.y + n.h + GAP[n.depth]);
  }

  function isHidden(n) {
    var p = n.parent;
    while (p) { if (p.collapsed) return true; p = p.parent; }
    return false;
  }

  var bounds = { w: 0, h: 0 };
  /* Every layout change animates as ONE motion: boxes, connecting lines, fold buttons, notes
     and note connectors move together frame by frame (the boxes used to glide by CSS while
     lines and folds snapped, so branches visibly detached). Folding children slide into
     their parent and fade; unfolding ones grow out of it. With an anchor (the node you just
     folded) the view shifts so that node stays under the cursor. */
  /* Motion (motion.dev, kept in canvas/vendor so it works offline) adds springs to a few small
     moments. Without it, or with "reduce motion" on, the same things happen without the flourish. */
  var MO = window.Motion || null;
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var SPRING = { type: 'spring', visualDuration: 0.3, bounce: 0.16 };
  function pop(el, from, opts) {                      // spring an element into its resting place
    if (!MO || REDUCED || !el) return;
    MO.animate(el, Object.assign({ opacity: [0, 1] }, from || { scale: [0.96, 1], y: [8, 0] }), opts || SPRING)
      .then(function () { el.style.transform = ''; el.style.opacity = ''; });   // hand back to CSS (hover etc.)
  }
  function popOut(el, to, done) {
    if (!MO || REDUCED || !el) { done(); return; }
    MO.animate(el, Object.assign({ opacity: 0 }, to || {}), { duration: 0.2, ease: 'easeIn' }).then(done);
  }

  var LAYOUT_ANIM = { raf: 0, ctl: null, anchor: null, off: 0, touched: [] }, LAYOUT_MS = 280;
  function stopLayoutAnim() {
    if (LAYOUT_ANIM.raf) { cancelAnimationFrame(LAYOUT_ANIM.raf); LAYOUT_ANIM.raf = 0; }
    if (LAYOUT_ANIM.ctl) { LAYOUT_ANIM.ctl.stop(); LAYOUT_ANIM.ctl = null; }
    LAYOUT_ANIM.touched.forEach(function (el) { el.style.opacity = ''; });
    LAYOUT_ANIM.touched = [];
  }
  function layout() {
    var animate = !LAYOUT_ANIM.off && !REDUCED && !(typeof drag !== 'undefined' && drag) &&
                  NODES.some(function (n) { return n.x != null && n.el && n.el.style.display !== 'none'; });
    var prev = {};
    if (animate) NODES.forEach(function (n) {           // where things are NOW (mid-animation counts)
      if (n.el && n.el.style.display !== 'none' && n.x != null) prev[n.id] = { x: n.x, y: n.y };
    });
    var anchor = LAYOUT_ANIM.anchor, aY0 = anchor && prev[anchor.id] ? prev[anchor.id].y : null, camY0 = cam.y;
    LAYOUT_ANIM.anchor = null;
    stopLayoutAnim();
    layoutNow();                                         // final positions and visibility
    if (!animate) return;

    var items = [], extra = {};
    function visAncestor(n, inPrev) {                    // nearest ancestor that is / was on screen
      for (var a = n.parent; a && a !== ROOT; a = a.parent) {
        if (inPrev ? prev[a.id] : !isHidden(a)) return inPrev ? prev[a.id] : { x: a.x, y: a.y };
      }
      return null;
    }
    NODES.forEach(function (n) {
      var vis = !isHidden(n), was = !!prev[n.id];
      if (!vis && !was) return;
      var to = vis ? { x: n.x, y: n.y } : (visAncestor(n, false) || prev[n.id]);
      var from = was ? prev[n.id] : (visAncestor(n, true) || to);
      if (vis && was && from.x === to.x && from.y === to.y) return;
      if (!vis) extra[n.id] = 1;
      items.push({ n: n, from: from, to: to, vis: vis, was: was });
    });
    var camTo = camY0;
    if (anchor && aY0 != null && !isHidden(anchor)) camTo = camY0 - (anchor.y - aY0) * cam.z;
    if (!items.length && camTo === camY0) return;

    // e = how far along (a spring may overshoot 1 a touch), k = the same clamped to 0..1 for fades
    function step(e, k) {
      items.forEach(function (it) {
        var n = it.n, x = it.from.x + (it.to.x - it.from.x) * e, y = it.from.y + (it.to.y - it.from.y) * e;
        n.x = x; n.y = y;
        n.el.style.left = x + 'px'; n.el.style.top = y + 'px';
        var op = !it.vis ? 1 - k : !it.was ? k : null;
        if (op != null) {
          n.el.style.display = ''; n.el.style.opacity = op; LAYOUT_ANIM.touched.push(n.el);
        }
        if (n.fold && (it.vis || it.was)) {
          n.fold.style.left = (x + W[n.depth] + 7) + 'px'; n.fold.style.top = (y + n.h / 2 - 9.5) + 'px';
          if (op != null) { n.fold.style.display = ''; n.fold.style.opacity = op; LAYOUT_ANIM.touched.push(n.fold); }
        }
      });
      drawEdges(extra, k);
      if (annoList.length) layoutAnnos();
      drawConns(); drawVTL();
      if (camTo !== camY0) { cam.y = camY0 + (camTo - camY0) * e; apply(false); }
    }
    function settle() {                                  // land exactly on the final layout
      LAYOUT_ANIM.raf = 0; LAYOUT_ANIM.ctl = null;
      items.forEach(function (it) {
        it.n.x = it.to.x; it.n.y = it.to.y;
        if (!it.vis) { it.n.el.style.display = 'none'; if (it.n.fold) it.n.fold.style.display = 'none'; }
      });
      if (camTo !== camY0) { cam.y = camTo; apply(false); }
      LAYOUT_ANIM.touched.forEach(function (el) { el.style.opacity = ''; }); LAYOUT_ANIM.touched = [];
      drawEdges(); layoutAnnos(); drawConns();
    }
    if (MO) {                                            // a soft spring: branches settle, not stop dead
      LAYOUT_ANIM.ctl = MO.animate(0, 1, { type: 'spring', visualDuration: 0.32, bounce: 0.12,
        onUpdate: function (v) { step(v, Math.max(0, Math.min(1, v))); }, onComplete: settle });
      return;
    }
    var t0 = performance.now();
    function frame(now) {
      var k = Math.min(1, (now - t0) / LAYOUT_MS), e = 1 - Math.pow(1 - k, 3);   // ease-out
      step(e, k);
      if (k < 1) { LAYOUT_ANIM.raf = requestAnimationFrame(frame); return; }
      settle();
    }
    LAYOUT_ANIM.raf = requestAnimationFrame(frame);
  }
  (function () {
    function watch(id, cardSel) {
      var m = document.getElementById(id); if (!m) return;
      new MutationObserver(function () {
        if (m.hidden) return;
        pop(m, {}, { duration: 0.16 });
        pop(m.querySelector(cardSel), { scale: [0.95, 1], y: [10, 0] });
      }).observe(m, { attributes: true, attributeFilter: ['hidden'] });
    }
    ['exportModal', 'importModal', 'sessModal'].forEach(function (id) { watch(id, '.xcard'); });
    watch('helpScrim', '.helppanel'); watch('scrim', '.pal');
    var sp = document.getElementById('spkPop');
    if (sp) new MutationObserver(function () { if (!sp.hidden) pop(sp, { scale: [0.96, 1], y: [-6, 0] }); })
      .observe(sp, { attributes: true, attributeFilter: ['hidden'] });
  })();
  function layoutNow() {
    ROOT.h = 0;
    NODES.forEach(ensureEl);
    NODES.forEach(ensureFold);
    place(ROOT, 0);
    var maxX = 0, maxY = 0;
    NODES.forEach(function (n) {
      var hid = isHidden(n);
      n.el.style.display = hid ? 'none' : '';
      if (n.fold) n.fold.style.display = hid ? 'none' : '';
      if (n.ghostEl) n.ghostEl.style.display = (hid || n.collapsed) ? 'none' : '';
      if (hid) return;
      n.x = X[n.depth];
      n.el.style.top = n.y + 'px';
      n.el.style.left = n.x + 'px';
      if (n.fold) {
        n.fold.style.left = (n.x + W[n.depth] + 7) + 'px';
        n.fold.style.top = (n.y + n.h / 2 - 9.5) + 'px';
      }
      if (n.ghostEl && !n.collapsed) {
        n.ghostEl.style.left = X[n.ghost.depth] + 'px';
        n.ghostEl.style.top = n.ghost.y + 'px';
      }
      maxX = Math.max(maxX, n.x + W[n.depth]);
      maxY = Math.max(maxY, n.y + n.h);
    });
    rootGhost.style.top = ROOT.ghost.y + 'px';
    bounds = { w: maxX, h: maxY };
    svg.setAttribute('width', maxX + 40); svg.setAttribute('height', maxY + 40);
    drawEdges();
    layoutAnnos();
    drawConns();
    drawVTL();
  }


