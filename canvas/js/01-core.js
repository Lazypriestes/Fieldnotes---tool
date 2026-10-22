  // 01-core.js — Setup, the question model, undo history, cue helpers. All files share one closure: see ui_asset() in analysis/assistant.py.
  var TREE = JSON.parse(document.getElementById('treedata').textContent);
  var $ = function (id) { return document.getElementById(id); };

  var app = $('app'), viewport = $('viewport'), world = $('world'), svg = $('edges'),
      track = $('track'), insp = $('insp'), caps = $('caps'), scrim = $('scrim'),
      palInput = $('palInput'), palList = $('palList'), runBtn = $('runBtn'),
      posLabel = $('posLabel'), countEl = $('count'), legendLive = $('legendLive'),
      zoomVal = $('zoomVal'), hint = $('hint'), toasts = $('toasts'),
      annolayer = $('annolayer'), leads = $('leads'),
      addNoteBtn = $('addNote'), layerSw = $('layerSw'), dropline = $('dropline'), editBtn = $('editBtn'),
      resizer = $('resizer'), bodyEl = document.querySelector('.body'),
      followBtn = $('followBtn'), pauseBtn = $('pauseBtn');

  // top bar removed — its controls now live on the canvas; keep detached stubs so old refs stay safe
  var _stub = document.createElement('div');
  addNoteBtn = addNoteBtn || _stub; layerSw = layerSw || _stub;
  editBtn = editBtn || _stub; followBtn = followBtn || _stub;
  hint = hint || _stub; countEl = countEl || _stub;
  legendLive = legendLive || _stub; posLabel = posLabel || _stub;   // the bottom legend bar is gone too
  // The bottom timeline (time scrubber) is switched off: the left timeline shows the interview
  // by question instead. Set this to true to bring the scrubber back (git tag: with-bottom-timeline).
  var SHOW_SCRUBBER = false;
  app.classList.toggle('no-scrubber', !SHOW_SCRUBBER);
  // the recording menu rides just above the captions card, whatever its height
  if (window.ResizeObserver) new ResizeObserver(function () {
    app.style.setProperty('--capsH', (caps.offsetHeight + 12) + 'px');
  }).observe(caps);

  var ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3l8 5-8 5z" fill="currentColor"/></svg>';
  var ICON_STOP = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/></svg>';

  var NODES = [], INDEX = {}, ROOT = { id: '_root', children: [], collapsed: false, depth: -1, h: 0, y: 0 };
  var state = {}, selected = null, current = null, live = false, notes = [], timer = null, step = 0, hereTopic = 1;
  var pageNotes = [];
  var seq = 0, editing = false, follow = true;
  var DUR = [], cumEnd = [], totalDur = 1, liveIdx = -1, viewIdx = -1, reviewing = false, tlDrag = false;

  var W = [225, 310, 255];
  var X = [0, 360, 810];
  var X_TREE = 810, X_NOTES = 1090;   // follow-up column shifts right on the notes layer
  var GAP = [34, 16, 10];
  var BLOCK_GAP = 128;   // extra air between one topic+its questions and the next block

  function topics() { return ROOT.children; }

  /* ---------- model ---------- */
  function mk(o) {
    o.children = o.children || [];
    if (o.collapsed === undefined) o.collapsed = false;
    // ids must never repeat: a counter restarts at every page load and used to hand out an id a
    // saved question already had. Unique per moment instead; a duplicate in a saved tree is renamed.
    if (!o.id || INDEX[o.id]) o.id = 'n' + Date.now().toString(36) + (++seq).toString(36) + Math.floor(Math.random() * 1296).toString(36);
    NODES.push(o); INDEX[o.id] = o;
    return o;
  }
  function attach(parent, node, index) {
    node.parent = parent;
    if (index === undefined || index < 0) parent.children.push(node);
    else parent.children.splice(index, 0, node);
    return node;
  }
  function detach(node) {
    var a = node.parent.children, i = a.indexOf(node);
    if (i > -1) a.splice(i, 1);
  }
  function walk(n, fn) { fn(n); n.children.forEach(function (c) { walk(c, fn); }); }

  /* ---------- history ---------- */
  var undoStack = [], redoStack = [];
  function ser(n) { return { i: n.id, k: n.kind, t: n.text, m: n.mins, c: n.collapsed, cu: n.cues, ak: n.asks, ad: n.added || undefined,
    sv: n.sensManual ? n.sens : undefined, cm: n.cuesMine, am: n.asksMine, ch: n.children.map(ser) }; }
  function snap() { return JSON.stringify(ROOT.children.map(ser)); }
  // one undo history for the tree AND the page notes: each entry holds both
  function histSnap(tree) { return JSON.stringify({ t: tree || snap(), n: pageNotes.map(serializeNote) }); }
  function pushHistory(before) {
    if (before === undefined) before = histSnap();
    else if (before.charAt(0) === '[') before = histSnap(before);   // a tree-only snapshot taken before an edit
    undoStack.push(before);
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
    scheduleFileSave();
  }
  function rebuild(d, parent) {
    var n = attach(parent, mk({ id: d.i, kind: d.k, depth: parent.depth + 1, text: d.t, mins: d.m, collapsed: d.c }));
    if (d.cu) n.cues = d.cu;
    if (d.ak) n.asks = d.ak;
    if (d.ad) n.added = true;
    if (d.sv != null) { n.sens = d.sv; n.sensManual = true; }
    if (d.cm) n.cuesMine = d.cm;
    if (d.am) n.asksMine = d.am;
    d.ch.forEach(function (c) { rebuild(c, n); });
    return n;
  }
  // How specific a reply must be to count as answered, from the question's wording:
  // numbers / yes-no / which-who-when -> strict; open or opinion questions -> loose.
  function strictnessOf(text) {
    var q = ' ' + String(text).toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    if (/ (tell me about|walk me through|describe|what drew|how do you feel|anything else|what should i have asked|in general|your thoughts|talk about|mean to you|honest reaction|in five years|in ten years|what else (should|would|is there|do you want)) /.test(q)) return 'loose';
    if (/ how (many|much|big|long|often|old|far) | what percentage | ratio | how frequently /.test(q) ||
        /^ (is|are|do|does|did|have|has|can|could|would|will|was|were|should) /.test(q) ||
        / (early or late|yes or no|or not) /.test(q) || /\b(which|who|when)\b/.test(q)) return 'strict';
    return 'normal';
  }
  var SENS_OF = { loose: 0.4, normal: 0.6, strict: 0.8 };
  function nodeSens(n) { return n.sensManual ? n.sens : SENS_OF[strictnessOf(n.text)]; }
  function sensWord(v) { return v < 0.5 ? 'loose' : v > 0.7 ? 'strict' : 'normal'; }
  function nodeCues(n) { if (!n.cues) n.cues = cues(n); return n.cues; }   // materialize the heuristic once, then it's editable
  function nodeAsks(n) { if (!n.asks) n.asks = [n.text.split(/[,:?]/)[0].toLowerCase().trim()].filter(Boolean); return n.asks; }
  function restore(json) {
    var data = JSON.parse(json);
    NODES.forEach(function (n) {
      if (n.el) n.el.remove();
      if (n.ghostEl) n.ghostEl.remove();
      if (n.fold) n.fold.remove();
    });
    NODES = []; INDEX = {}; ROOT.children = [];
    data.forEach(function (d) { rebuild(d, ROOT); });
    renumber(); layout(); buildSpine();
    if (selected && INDEX[selected]) select(selected, false);
    else { selected = null; drawInspector(); }
  }
  function restoreHist(h) {
    var d = JSON.parse(h);
    if (Array.isArray(d)) { restore(h); return; }
    if (d.t !== snap()) restore(d.t);
    if (JSON.stringify(pageNotes.map(serializeNote)) !== JSON.stringify(d.n)) rebuildPageNotes(d.n);
    scheduleFileSave();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(histSnap());
    restoreHist(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(histSnap());
    restoreHist(redoStack.pop());
  }

  Object.keys(TREE).forEach(function (k) {
    var t = TREE[k], head = t.head.split('~');
    var tn = attach(ROOT, mk({ id: 'topic' + k, kind: 'topic', depth: 0,
      text: head[0].replace(/^\d+\s*·\s*/, '').trim(), mins: (head[1] || '4 min').trim() }));
    attach(tn, mk({ id: 'm' + k, kind: 'opener', depth: 1, text: t.main.replace(/^"|"$/g, '') }));
    t.qs.forEach(function (q) {
      var m = q.t.match(/^(Q[\d.]+)\s+(.*)$/);
      var qn = attach(tn, mk({ id: q.id, kind: q.probe ? 'probe' : 'standard', depth: 1,
        text: m ? m[2] : q.t, collapsed: true }));
      q.f.forEach(function (f) {
        attach(qn, mk({ id: f.id, kind: f.probe ? 'fprobe' : 'follow', depth: 2,
          text: f.t.replace(/^↳\s*/, '') }));
      });
    });
  });
  var closeT = attach(ROOT, mk({ id: 'topic8', kind: 'topic', depth: 0, text: 'CLOSE & NOTES', mins: '2 min' }));
  attach(closeT, mk({ id: 'close', kind: 'opener', depth: 1, text: 'What should I have asked you that I didn\u2019t?' }));

  function renumber() {
    topics().forEach(function (t, i) {
      t.n = i + 1; t.topic = t.n; t.label = 'TOPIC ' + t.n;
      t.minutes = parseFloat(t.mins) || 4;
      var qi = 0;
      t.children.forEach(function (c) {
        c.topic = t.n; c.depth = 1;
        if (c.kind === 'opener') c.label = 'OPENER';
        else { qi++; c.label = 'Q' + t.n + '.' + qi; }
        c.children.forEach(function (f) { f.topic = t.n; f.depth = 2; f.label = '↳'; });
      });
      t.qs = t.children.filter(function (c) { return c.kind !== 'opener'; });
    });
    NODES.forEach(refreshLabel);
    countEl.textContent = topics().reduce(function (a, t) { return a + t.qs.length; }, 0) + ' Q · ' +
      topics().reduce(function (a, t) { return a + t.minutes; }, 0) + ' MIN';
  }

  /* ---------- cues ---------- */
  var STOP = ('what how why when who where do does did you your the a an and or of to in on for it its is are was were be been ' +
    'that this those these with from at by as if any some more most much many other others than then there here into out up down ' +
    'about over under again actually really ever still just only also them they their he she we us my mine one two get got go goes ' +
    'going make makes made take takes let lets keep keeps come comes tell walk say says something anything work works worked working ' +
    'use uses used using thing things way ways would could should can may might will have has had not no yes but so all each between ' +
    'around after before does').split(/\s+/);
  function cues(n) {
    var seen = {}, out = [];
    n.text.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).forEach(function (w) {
      if (w.length < 4 || STOP.indexOf(w) > -1 || seen[w]) return;
      seen[w] = 1; out.push(w);
    });
    return out.sort(function (a, b) { return b.length - a.length; }).slice(0, 4);
  }

