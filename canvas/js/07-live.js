  // 07-live.js — Live interview: demo script, auto annotation, real backend and coverage. All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ---------- live interview ---------- */
  var I = 'INTERVIEWER', S = 'DESIGNER';
  /* ---------- auto annotation ---------- */
  var ANNO = {
    'm1': 'Portable air purifiers. Owns form through production CAD — sits on the engineering side.',
    's1-1': 'Consumer appliances: kettles, purifiers, speakers. Returns to anything with a motor or fan.',
    'f1-1-1': 'Constraint-led. Airflow and acoustics drive the form somewhere he would not have gone.',
    'f1-1-2': 'Hidden difficulty: tolerance stacking on parts nobody sees.',
    's1-2': '4 designers, 3 engineers downstream. Hands over STEP, native SolidWorks and drawings.',
    'f1-2-1': 'Not solo — dedicated engineering group downstream.',
    'f1-2-2': 'Friction at draft angles and ribs. Engineering redoes half once tooling weighs in.',
    's1-3': 'About one day in four in the workshop. More time at the printers than the bench.',
    'f1-3-1': 'Ratio worsening — more screen, more meetings.',
    'f1-3-2': 'Would take three days a week hands-on if the schedule allowed.',
    's1-4': 'Proud: first purifier, shipped in 9 months. Bad: speaker, supplier CAD wrong by 2 mm throughout.',
    'm3': 'Daily tool is SolidWorks.',
    's5-4': 'Sends STEP plus native files to engineering.',
    's6-1': 'Shared drive with folder names, no PDM. Says he hates it.',
    's6-2': 'Versioning by folder naming.',
    's2-3': 'Prototyping is in-house 3D printing.',
    's5-3': 'Runs his own print prep.',
    's7-1': 'AI is costing him time rather than saving it. Unprompted and negative.',
    'm2': 'Process runs paper → foam → CAD, in that order. Sketch-led, not screen-led.',
    's2-1': 'Ideation is on paper first; the screen comes late.',
    'f2-1-1': 'A concept enters CAD only when a sketch can no longer answer the question.',
    'f2-1-2': 'Never skips sketching — screen kills ideas too early for him.',
    's2-2': 'Constraints enter early: wall thickness and draft from day one.',
    'f2-2-1': 'A thin-section fill problem forced a full housing redesign.',
    's2-4': 'Done when prototypes stop surprising him; engineering signs the tolerance review.',
    's3-1': 'Pro/E → Inventor → SolidWorks. Each switch cost ~a month of speed.',
    'f3-1-1': 'Lost muscle memory and a pile of macros across the switches.',
    's3-2': 'Free hand: direct modelling for concept, parametric only when it earns it.',
    'f3-2-1': 'Parametric is "a tax when you are still exploring."',
    's3-4': 'SpaceMouse plus heavy custom hotkeys. Half his speed is the keymap.',
    'm4': 'Build strategy is chosen by the reader: clean+parametric for engineering, direct edits solo.',
    's4-1': 'Parametric vs direct is decided by audience, not preference.',
    's4-3': 'Feature-tree discipline is social — tidy for others, a "horror show" for himself.',
    'f4-3-2': 'Inherits a messy tree by rebuilding rather than fixing it.',
    's4-2': 'Surfaces by hand more than most IDs; checks quality with zebra stripes.'
  };
  var FLAGS = {
    'f1-4-1': 'Thin — he described the failure, not what he took from it. Probe if time.'
  };

  var SCRIPT = [
    { w: I, t: 'Let\u2019s start easy — what are you designing right now, and where do you sit between design and engineering on it?', cur: 'm1' },
    { w: S, t: 'Right now it\u2019s a range of portable air purifiers. I take them from the form through to production CAD, so I sit fairly far over on the engineering side.', mark: [['m1', 'green']] },
    { w: S, t: 'There is an engineering team, but they only pick it up once I have handed over solid parts.', mark: [['s1-2', 'amber']] },
    { w: I, t: 'What kinds of products have you worked on? Any category you keep coming back to?', cur: 's1-1' },
    { w: S, t: 'Consumer appliances mostly. Kettles, purifiers, a couple of speakers. I keep coming back to anything with a motor or a fan in it.', mark: [['s1-1', 'green']] },
    { w: I, t: 'What drew you to that category?' },
    { w: S, t: 'You get a real constraint to design against. Airflow and acoustics push the form somewhere you would not have gone on your own.', mark: [['f1-1-1', 'green']] },
    { w: S, t: 'The thing nobody outside guesses is how much of it is tolerance stacking on parts nobody ever sees.', mark: [['f1-1-2', 'green']] },
    { w: I, t: 'How big is the team around you, and who do you hand work off to?', cur: 's1-2' },
    { w: S, t: 'Four designers, then three engineers downstream. I hand over STEP and native SolidWorks files, plus the drawings.',
      mark: [['s1-2', 'green'], ['f1-2-1', 'green'], ['m3', 'amber'], ['s5-4', 'amber']],
      notes: [
        { id: 'm3', label: 'TOPIC 3 OPENER', topic: 3, text: 'Named SolidWorks as the daily tool before you asked. Open topic 3 on history, not on what he uses.' },
        { id: 's5-4', label: 'Q5.4', topic: 5, text: 'STEP plus native to engineering. Interop partly covered.' }
      ] },
    { w: S, t: 'Version control is the messy bit. We are on a shared drive with folder names, which I hate.',
      mark: [['s6-1', 'amber'], ['s6-2', 'amber']],
      notes: [{ id: 's6-1', label: 'Q6.1', topic: 6, text: 'Folders on a drive, no PDM, and he already volunteered that he hates it. Skip the what, go to the cost.' }] },
    { w: I, t: 'Where do the boundaries between your job and theirs get blurry?' },
    { w: S, t: 'Draft angles and ribs, usually. I put them in, then they redo half of them once tooling has an opinion.', mark: [['f1-2-2', 'green']] },
    { w: I, t: 'How much of your week is hands-on versus at a screen?', cur: 's1-3' },
    { w: S, t: 'Maybe one day in four in the workshop. We print a lot in-house, so I am at the printers more than I am at the bench.',
      mark: [['s1-3', 'green'], ['s2-3', 'amber'], ['s5-3', 'amber']],
      notes: [
        { id: 's2-3', label: 'Q2.3', topic: 2, text: 'Prototyping is in-house printing. You have the headline already.' },
        { id: 's5-3', label: 'Q5.3', topic: 5, text: 'Runs his own print prep. Ask which slicer, not whether.' }
      ] },
    { w: I, t: 'Has that ratio shifted over the last few years?' },
    { w: S, t: 'It has gone the wrong way. More screen, more meetings. Some of that is the AI stuff eating the time I thought it would save.',
      mark: [['f1-3-1', 'green'], ['s7-1', 'amber']],
      notes: [{ id: 's7-1', label: 'Q7.1', topic: 7, text: 'Unprompted, and negative: AI is costing him time. Strongest thread in the interview so far.' }] },
    { w: I, t: 'Is it the ratio you would choose?', cur: 'f1-3-2' },
    { w: S, t: 'No. I would take three days a week with material in my hands if the schedule allowed it.', mark: [['f1-3-2', 'green']] },
    { w: I, t: 'Tell me about a project you are proud of, and one that went badly.', cur: 's1-4' },
    { w: S, t: 'Proud of the first purifier, we shipped it in nine months. The bad one was a speaker where I trusted a supplier\u2019s CAD and it was wrong by two millimetres everywhere.', mark: [['s1-4', 'green'], ['f1-4-1', 'amber']] },
    { w: I, t: 'Good. Let me take you into how you actually work, then.', cur: 'm2' },

    /* ---- TOPIC 2 · physical design process ---- */
    { w: S, t: 'Sure. It always starts on paper for me. I sketch until something feels right, then block it out rough in foam before anything touches CAD.',
      mark: [['m2', 'green'], ['s2-1', 'amber']] },
    { w: I, t: 'Where does ideation happen for you — paper, foam, or straight to screen?', cur: 's2-1' },
    { w: S, t: 'Paper first, always. The screen kills ideas too early for me, so I never really skip the sketching.',
      mark: [['s2-1', 'green'], ['f2-1-2', 'green']] },
    { w: S, t: 'A concept only earns its way into CAD once a sketch can no longer answer the question I have.', mark: [['f2-1-1', 'green']] },
    { w: I, t: 'When do material and process constraints enter — early or late?', cur: 's2-2' },
    { w: S, t: 'Early. With a fan you are fighting wall thickness and draft from day one. I had a whole housing redesigned once because the tool could not fill a thin section.',
      mark: [['s2-2', 'green'], ['f2-2-1', 'green']] },
    { w: S, t: 'I will usually run a rough airflow sim myself before it ever goes near the engineers.',
      mark: [['s5-2', 'amber']],
      notes: [{ id: 's5-2', label: 'Q5.2', topic: 5, text: 'Runs his own airflow sim before handoff. Simulation is partly answered already — ask where he stops, not whether.' }] },
    { w: I, t: 'How do you know when a design is actually done?', cur: 's2-4' },
    { w: S, t: 'When the prototypes stop surprising me. Then engineering signs off on the tolerance review. We print so much in-house that I get to that point fast.',
      mark: [['s2-4', 'green'], ['f2-4-1', 'green'], ['s2-3', 'green']] },

    /* ---- TOPIC 3 · CAD tools & history ---- */
    { w: I, t: 'Let us talk tools. You mentioned SolidWorks earlier — how did you end up on it?', cur: 'm3' },
    { w: S, t: 'Started in Pro/E at university, then Inventor at my first job, SolidWorks ever since. Each move cost me about a month before I was fast again.',
      mark: [['m3', 'green'], ['s3-1', 'green'], ['f3-1-2', 'green']] },
    { w: I, t: 'What did you lose in those switches?', cur: 'f3-1-1' },
    { w: S, t: 'Muscle memory, mostly. And a pile of macros I never bothered to rebuild.', mark: [['f3-1-1', 'green']] },
    { w: I, t: 'If the choice were entirely yours — no legacy files, no team — what would you reach for?', cur: 's3-2' },
    { w: S, t: 'Something direct-modelling for the concept work. Parametric is a tax when you are still exploring. I would keep SolidWorks around purely for the drawings and tolerancing though.',
      mark: [['s3-2', 'green'], ['f3-2-1', 'green'], ['f3-2-2', 'green'], ['s5-4', 'green']] },
    { w: I, t: 'How do you drive the model day to day — mouse, SpaceMouse, shortcuts?', cur: 's3-4' },
    { w: S, t: 'SpaceMouse in one hand, a stack of custom hotkeys under the other. Honestly half my speed is that keymap, not the practice.',
      mark: [['s3-4', 'green'], ['f3-4-1', 'green'], ['f3-4-2', 'green']] },

    /* ---- TOPIC 4 · modelling philosophy ---- */
    { w: I, t: 'When you open a fresh part file, how do you decide how to build it?', cur: 'm4' },
    { w: S, t: 'I think about who opens it after me. If it is going to engineering it is clean and parametric; if it is just me exploring, direct edits all the way.',
      mark: [['m4', 'green'], ['s4-1', 'green'], ['f4-1-1', 'green']] },
    { w: I, t: 'How disciplined is your feature tree, then?', cur: 's4-3' },
    { w: S, t: 'Disciplined when someone else will see it. My own concept files are a horror show and I have made my peace with that.',
      mark: [['s4-3', 'green'], ['f4-3-1', 'green']] },
    { w: S, t: 'Inheriting a tree with a thousand un-named features is the worst. I usually just rebuild it from scratch rather than untangle it.',
      mark: [['f4-3-2', 'green'], ['f4-4-2', 'green']] },
    { w: I, t: 'How much surfacing do you do?', cur: 's4-2' },
    { w: S, t: 'More than most IDs. Anything with a nice transition I will surface by hand and check it with zebra stripes, not just my eye.',
      mark: [['s4-2', 'green'], ['f4-2-1', 'green'], ['f4-2-2', 'green']] },
    { w: I, t: 'Great. Let us follow the geometry once it leaves CAD.', cur: 'm5' }
  ];

  var RANK = { red: 0, amber: 1, green: 2 };

  /* ================= live backend (real diarization + LLM coverage) ================= */
  // STEPS is the active timeline source: SCRIPT for the demo, a growing array of real
  // diarized turns when connected live. TBASE offsets the demo clock (starts at 00:12).
  var STEPS = SCRIPT, TBASE = 12, liveReal = false;
  var API = location.protocol === 'file:' ? 'http://localhost:8000' : '';
  var LIVE = { steps: [], byId: {}, lastSeg: 0, lastCov: 0, session: null, poll: null,
               interviewer: 'Interviewer', fails: 0 };

  function buildPlan() {
    var qs = [];
    NODES.forEach(function (n) {
      if (n.depth >= 1 && n.kind !== 'topic') {
        var cs = (n.cues && n.cues.length) ? '  [answered when they mention: ' + n.cues.join(', ') + ']' : '';
        var ks = (n.asks && n.asks.length) ? '  [asked when interviewer says: ' + n.asks.join(', ') + ']' : '';
        ks += '  [strictness: ' + sensWord(nodeSens(n)) + ']';
        qs.push({ id: n.id, topic: n.topic || 1,
                  label: (n.label === '↳' ? 'follow' : n.label) || '', text: n.text + cs + ks });
      }
    });
    return { interviewer: LIVE.interviewer, questions: qs };
  }

  function computeTimeline() {
    DUR = []; cumEnd = []; var run = 0;
    STEPS.forEach(function (e, i) {
      if (e.tEnd != null) {                                  // live: real seconds
        DUR[i] = Math.max(300, (e.tEnd - (e.tStart != null ? e.tStart : 0)) * 1000);
        cumEnd[i] = e.tEnd * 1000;
      } else {                                               // demo: synthetic pacing
        DUR[i] = Math.min(6200, 1300 + e.t.length * 42);
        run += DUR[i]; cumEnd[i] = run;
      }
    });
    totalDur = cumEnd.length ? (cumEnd[cumEnd.length - 1] || 1) : 1;
  }

  function addTlDot(i) {
    var e = STEPS[i]; if (!e || !e.notes || !e.notes.length) return;
    if (tlDots.some(function (d) { return d.i === i; })) return;
    var nt = e.notes[0], dot = document.createElement('button');
    dot.className = 'tl-mark';
    attachTip(dot, function () { return 'ANSWERED AHEAD · ' + nt.label + ' · TOPIC ' + nt.topic; },
      function () { return nt.text; });
    dot.addEventListener('click', function (ev) { ev.stopPropagation(); seekIdx(i, true); });
    $('tlTrack').appendChild(dot); tlDots.push({ el: dot, i: i });
  }

  function startLiveBackend() {
    if (live) { stopLive(); return; }        // toggle off if already running
    fetch(API + '/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPlan()) }).catch(function () {});
    // note the session already in the DB so we can ignore it, THEN start a fresh pipeline
    var src = ($('srcSel') && $('srcSel').value) || 'sample';
    LIVE.src = src; LIVE.startedAt = Date.now();
    fetch(API + '/api/segments?after=0').then(function (r) { return r.json(); }).then(function (d) {
      LIVE.staleSession = d.session || null;
      return fetch(API + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: src, split: src === 'call' ? $('iv2Sel').value : 'none' }) });
    }).catch(function () {});
    enterLiveView('Connecting · local diarization');
    publishTree();
    LIVE.poll = setInterval(livePoll, 1000);
    SESS.id = null; SESS.lastSig = '';
    SESS.timer = setInterval(function () { autosave(false); }, 10000);   // the session log
    livePoll();
  }

  function enterLiveView(label) {
    live = true; liveReal = true; LIVE.on = true; LIVE.restored = false; LIVE.attached = false;
    LIVE.covSession = null; LIVE.lastEv = 0; LIVE.evSession = undefined;
    LIVE.off = false; LIVE.offSpans = []; if (LIVE.offTimer) { clearInterval(LIVE.offTimer); LIVE.offTimer = null; }
    pauseBtn.innerHTML = ICON_PAUSE; pauseBtn.classList.remove('on');
    pauseBtn.title = 'Off the record — stop transcribing until you resume';
    STEPS = LIVE.steps = []; LIVE.byId = {}; LIVE.lastSeg = 0; LIVE.lastCov = 0; LIVE.session = null; LIVE.staleSession = null; LIVE.fails = 0;
    TBASE = 0; notes = []; state = {};
    liveIdx = -1; viewIdx = -1; reviewing = false; tlDrag = false; userMarks = []; tlCursorX = null; hideTip();
    if (recTimer) { clearInterval(recTimer); recTimer = null; } recSpan = null; redSpans = []; hideRater();
    document.querySelectorAll('.worldnote').forEach(function (n) { n.remove(); });
    setEdit(false); setFollow(true, true);
    app.classList.add('live'); app.classList.add('live-real');
    NODES.forEach(function (n) { if (n.depth === 1) { state[n.id] = 'red'; n.el.dataset.s = 'red'; } });
    legendLive.hidden = false; hint.hidden = true;
    runBtn.innerHTML = ICON_STOP; runBtn.classList.add('on'); runBtn.title = 'Stop live interview';
    pauseBtn.hidden = true;
    setDockLive(true);
    caps.hidden = false;
    caps.innerHTML = '<div class="status"><span class="dot"></span><span class="rec">' + esc(label) + '</span>' +
      '<span class="mono roam"></span><span class="spacer"></span>' +
      '<button class="spkbtn" id="spkBtn" hidden title="Who is who — rename a speaker">Speakers</button>' +
      '<span class="mono clock">00:00</span></div>' +
      '<div class="tl" id="tl"><button class="tl-live" id="tlLive">LIVE</button>' +
      '<div class="tl-track" id="tlTrack"><div class="tl-elapsed" id="tlElapsed"></div>' +
      '<div class="tl-played" id="tlPlayed"></div><div class="tl-future"></div><div class="tl-head" id="tlHead"></div></div>' +
      '<span class="tl-time mono" id="tlTime">00:00</span></div>';
    LIVE.speakers = [];
    clearBadges(); clearAnnos(); toasts.innerHTML = '';
    setLayer('tree'); initTL(); coverage(); drawInspector();
    if (liveBtn) liveBtn.classList.add('on');
    syncTransport();
  }

  function livePoll() {
    fetch(API + '/api/segments?after=' + LIVE.lastSeg).then(function (r) { return r.json(); }).then(function (d) {
      LIVE.fails = 0;
      if (d.waiting || !d.segments) return;
      if (d.session && d.session === LIVE.staleSession) {      // old data — wait for the pipeline's fresh session
        var rec = caps.querySelector('.rec'); if (rec) rec.textContent = 'Listening · waiting for audio';
        return;
      }
      if (d.session && d.session !== LIVE.session) {           // fresh session appeared -> follow it, clear the stale view
        LIVE.session = d.session; resetLiveSession(); return;   // next poll fetches from the top
      }
      if (d.speakers) applySpeakerNames(d.speakers);
      d.segments.forEach(applySegment);
      if (d.segments.length) LIVE.lastSeg = d.segments[d.segments.length - 1].id;
    }).catch(function () {
      if (++LIVE.fails === 3) { var rec = caps.querySelector('.rec'); if (rec) rec.textContent = 'No backend at ' + (API || 'this origin') + ' — start assistant.py'; }
    });
    pollShared();
    fetch(API + '/api/coverage?after=' + LIVE.lastCov).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.events) return;
      // Coverage numbering restarts for every interview. Only use events for the interview
      // we are showing, and restart the counter when the server switches interviews -
      // otherwise a previous interview's events push the counter past the new ones.
      if (d.session !== LIVE.covSession) { LIVE.covSession = d.session; LIVE.lastCov = 0; return; }
      if (!LIVE.session || d.session !== LIVE.session) return;
      d.events.forEach(applyCoverage);
      if (d.events.length) LIVE.lastCov = d.events[d.events.length - 1].id;
    }).catch(function () {});
    // surface a stalled capture instead of hanging on "waiting" forever
    if (liveIdx < 0 && Date.now() - (LIVE.startedAt || 0) > 9000) {
      fetch(API + '/api/status').then(function (r) { return r.json(); }).then(function (s) {
        if (!s.running && liveIdx < 0) {
          var rec = caps.querySelector('.rec');
          if (rec) rec.textContent =
            LIVE.src === 'call' ? 'Capture stopped — allow Microphone for Fieldnotes System Audio, run ./start.sh in your terminal'
            : LIVE.src === 'system' ? 'Capture stopped — allow audio recording & run ./start.sh in your terminal'
            : LIVE.src === 'device' ? 'Capture stopped — grant Microphone permission & restart the server'
            : 'Capture stopped before any audio — see diarization/pipeline.log';
        }
      }).catch(function () {});
    }
  }

  function resetLiveSession() {                 // a new diarization session started — clear the stale view
    STEPS = LIVE.steps = []; LIVE.byId = {}; LIVE.lastSeg = 0; LIVE.lastCov = 0;
    notes = []; state = {};
    caps.querySelectorAll('.line').forEach(function (l) { l.remove(); });
    clearBadges(); clearAnnos(); toasts.innerHTML = '';
    NODES.forEach(function (n) {
      delete n.el.dataset.s; n.el.classList.remove('cur'); n.el.classList.remove('next');
      if (n.depth === 1) { state[n.id] = 'red'; n.el.dataset.s = 'red'; }
    });
    liveIdx = -1; viewIdx = -1; reviewing = false;
    var rec = caps.querySelector('.rec'); if (rec) rec.textContent = 'Listening · live · local';
    initTL(); coverage(); drawInspector(); updateTL();
  }

  function applySegment(seg) {
    if (LIVE.byId[seg.id] != null) return;
    var isInt = isInterviewerName(seg.speaker);
    var step = { w: seg.speaker, raw: seg.raw || seg.speaker, t: seg.text, a: isInt, tStart: seg.t_start, tEnd: seg.t_end,
                 seg_id: seg.id, mark: [], notes: [] };
    STEPS.push(step);
    var i = STEPS.length - 1;
    LIVE.byId[seg.id] = i;
    computeTimeline();
    liveIdx = i;
    var rec = caps.querySelector('.rec');           // a line finishing after "off the record" was clicked
    if (rec) rec.textContent = LIVE.off ? 'Off the record · nothing is transcribed'
      : VIEWER ? 'Watching · live from the recording computer' : 'Recording · live · local';
    var c = caps.querySelector('.clock'); if (c) c.textContent = fmtTime(TBASE + seg.t_end);
    if (!reviewing) { viewIdx = i; pushLine(seg.speaker, seg.text, isInt); }
    updateTL();
  }

  function applyCoverage(evt) {
    var i = LIVE.byId[evt.seg_id]; if (i == null) return;
    var step = STEPS[i];
    (evt.matches || []).forEach(function (m) {
      var n = INDEX[m.id]; if (!n) return;
      var doApply = !reviewing && liveIdx >= i;
      if (m.status === 'ask') {
        step.cur = m.id;
        if (doApply) setCurrent(m.id);
        return;
      }
      if (!step.mark.some(function (x) { return x[0] === m.id; })) step.mark.push([m.id, m.status]);
      if (doApply) markNode(m.id, m.status);
      var hereTopicNow = INDEX[current] ? INDEX[current].topic : (hereTopic || 1);
      var ahead = n.topic !== hereTopicNow;
      step.anno = step.anno || [];
      if (ahead) {
        if (!step.anno.some(function (a) { return a.id === m.id && a.kind === 'ahead'; })) {
          step.anno.push({ id: m.id, text: step.t, kind: 'ahead' });
          var note = { id: m.id, label: (n.label === '↳' ? 'FOLLOW-UP' : n.label), topic: n.topic, text: step.t };
          if (!step.notes.some(function (x) { return x.id === m.id; })) step.notes.push(note);
          if (doApply) { addAnno(m.id, step.t, 'ahead'); notify(note); addTlDot(i); }
        }
      } else if (m.status === 'green') {
        if (!step.anno.some(function (a) { return a.id === m.id && a.kind === 'answer'; })) {
          step.anno.push({ id: m.id, text: step.t, kind: 'answer' });
          if (doApply) addAnno(m.id, step.t, 'answer');
        }
      }
    });
    computeTimeline(); updateTL();
  }
  function markNode(id, s) {
    var n = INDEX[id]; if (!n) return;
    if (RANK[s] <= RANK[state[id] || 'red']) return;
    state[id] = s;
    n.el.dataset.s = s;
    if (n.parent && n.parent.collapsed) { n.parent.collapsed = false; ensureFold(n.parent); layout(); }
    var hereNow = INDEX[current] ? INDEX[current].topic : 1;
    if (!liveReal && ANNO[id]) {        // demo annotations; live builds its own from real text
      if (n.topic !== hereNow) addAnno(id, ANNO[id], 'ahead');
      else if (s === 'green') addAnno(id, ANNO[id], 'answer');
    }
    if (!liveReal && FLAGS[id]) addAnno(id, FLAGS[id], 'flag');
    coverage();
  }

  function toast(note) {
    var el = document.createElement('button');
    el.className = 'toast';
    el.innerHTML = '<span class="hd"><b>ANSWERED AHEAD</b><span>' + note.label + ' · TOPIC ' + note.topic +
      '</span></span>' + esc(note.text);
    el.title = 'Go to ' + note.label;
    el.addEventListener('click', function () { jumpTo(note.id); dismiss(el); });
    toasts.appendChild(el);
    if (MO && !REDUCED) { el.style.animation = 'none'; pop(el, { x: [24, 0], scale: [0.97, 1] }); }
    // keep at most 3 visible. Count only toasts not already fading out: dismiss() is a no-op
    // on a fading one, so looping on children.length spun forever and froze the whole tab.
    var showing = [].filter.call(toasts.children, function (t) { return !t.classList.contains('out'); });
    while (showing.length > 3) dismiss(showing.shift());
    setTimeout(function () { dismiss(el); }, 8000);
  }
  function dismiss(el) {
    if (!el || el.classList.contains('out')) return;
    el.classList.add('out');
    if (MO && !REDUCED) { el.style.transition = 'none'; popOut(el, { x: 16 }, function () { el.remove(); }); return; }
    setTimeout(function () { el.remove(); }, 320);
  }
  function notify(note) {
    note.at = note.at || current; note.idx = note.idx != null ? note.idx : liveIdx;   // for the side timeline
    notes.push(note); badge(note.topic); toast(note); drawInspector();
  }

  function setCurrent(id, moveCam) {
    NODES.forEach(function (n) { n.el.classList.remove('cur'); n.el.classList.remove('next'); });
    current = id;
    var n = INDEX[id];
    n.el.classList.add('cur');
    if (follow && moveCam !== false) centerOn(n, Math.max(cam.z, .78), true);
    markHere(n.topic);
    posLabel.textContent = 'AT ' + (n.kind === 'opener' ? 'OPENER' : n.label) + ' · TOPIC ' + n.topic;
    var t = topics().filter(function (x) { return x.n === n.topic; })[0], nx = null;
    if (t) for (var i = 0; i < t.qs.length; i++) {
      if ((state[t.qs[i].id] || 'red') === 'red' && t.qs[i].id !== id) { nx = t.qs[i]; break; }
    }
    if (nx) nx.el.classList.add('next');
  }

  function pushLine(w, t, isA) {
    var d = document.createElement('div');
    d.className = 'line' + ((isA || w === I) ? ' a' : '');
    d.innerHTML = '<span class="who">' + w + '</span><span class="txt">' + esc(t) + '</span>';
    caps.insertBefore(d, caps.querySelector('.status'));
    var lines = caps.querySelectorAll('.line');
    if (lines.length > 3) lines[0].remove();
  }

  var t0 = 0, paused = false, tickAt = 0, tickDur = 0, pauseOffset = 0, pausedAt = 0;
  function clock() {
    var s = Math.floor((Date.now() - t0 - pauseOffset - (paused ? Date.now() - pausedAt : 0)) / 1000) + 12;
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function tick() {
    if (reviewing) return;
    if (step >= STEPS.length) { finish(); return; }
    var e = STEPS[step++];
    liveIdx = step - 1; viewIdx = liveIdx;
    if (e.cur) setCurrent(e.cur);
    pushLine(e.w, e.t);
    if (e.mark) e.mark.forEach(function (m) { markNode(m[0], m[1]); });
    if (e.notes) e.notes.forEach(notify);
    if (e.mark && e.mark.some(function (m) { return m[0] === selected; })) drawInspector();
    var c = caps.querySelector('.clock'); if (c) c.textContent = clock();
    updateTL();
    tickDur = Math.min(6200, 1300 + e.t.length * 42);
    tickAt = Date.now();
    if (!reviewing) timer = setTimeout(tick, tickDur);
  }

  function startLive() {
    LIVE.offSpans = [];
    STEPS = SCRIPT; TBASE = 12; liveReal = false;      // demo mode
    live = true; step = 0; notes = []; state = {}; t0 = Date.now();
    paused = false; pauseOffset = 0;
    liveIdx = -1; viewIdx = -1; reviewing = false; tlDrag = false; userMarks = []; tlCursorX = null; hideTip();
    if (recTimer) { clearInterval(recTimer); recTimer = null; } recSpan = null; redSpans = []; hideRater(); document.querySelectorAll('.worldnote').forEach(function (n) { n.remove(); });
    setEdit(false); setFollow(true, true);
    app.classList.add('live');
    NODES.forEach(function (n) {
      if (n.depth === 1) { state[n.id] = 'red'; n.el.dataset.s = 'red'; }
    });
    legendLive.hidden = false; hint.hidden = true;
    runBtn.innerHTML = ICON_STOP; runBtn.classList.add('on'); runBtn.title = 'Stop interview';
    pauseBtn.hidden = false; pauseBtn.innerHTML = ICON_PAUSE; pauseBtn.title = 'Pause';
    setDockLive(true);
    caps.hidden = false;
    caps.innerHTML = '<div class="status"><span class="dot"></span><span class="rec">Recording · 2 speakers · local</span>' +
      '<span class="mono roam"></span><span class="spacer"></span><span class="mono clock">00:12</span></div>' +
      '<div class="tl" id="tl"><button class="tl-live" id="tlLive">LIVE</button>' +
      '<div class="tl-track" id="tlTrack"><div class="tl-elapsed" id="tlElapsed"></div>' +
      '<div class="tl-played" id="tlPlayed"></div><div class="tl-future"></div><div class="tl-head" id="tlHead"></div></div>' +
      '<span class="tl-time mono" id="tlTime">00:12</span></div>';
    clearBadges(); clearAnnos(); toasts.innerHTML = '';
    setLayer('tree');
    initTL();
    coverage(); drawInspector(); tick();
    syncTransport();
  }

  function stopLive() {
    if (liveIdx >= 0 || redSpans.length || userMarks.length) {
      MM_LAST = mmSnapshot();                           // keep it for the mind map
      SESS.last = sessionSnapshot();                    // ...and for "Download session file"
      autosave(true);                                   // final entry in the session log
    }
    if (SESS.timer) { clearInterval(SESS.timer); SESS.timer = null; }
    clearTimeout(timer); live = false;
    if (LIVE.poll) { clearInterval(LIVE.poll); LIVE.poll = null; }
    var onlyReviewing = LIVE.restored && !LIVE.attached;
    LIVE.restored = LIVE.attached = false;
    if (liveReal && !onlyReviewing && !VIEWER) fetch(API + '/api/stop', { method: 'POST' }).catch(function () {});   // stop the pipeline too
    STEPS = SCRIPT; TBASE = 12; liveReal = false; LIVE.on = false;
    app.classList.remove('live-real');
    if (liveBtn) liveBtn.classList.remove('on');
    reviewing = false; liveIdx = -1; viewIdx = -1; tlDrag = false; userMarks = []; hideTip();
    if (recTimer) { clearInterval(recTimer); recTimer = null; } recSpan = null; redSpans = []; hideRater(); document.querySelectorAll('.worldnote').forEach(function (n) { n.remove(); });
    setDockLive(false);
    app.classList.remove('live');
    NODES.forEach(function (n) { delete n.el.dataset.s; n.el.classList.remove('cur'); n.el.classList.remove('next'); });
    legendLive.hidden = true; hint.hidden = false;
    runBtn.innerHTML = ICON_PLAY; runBtn.classList.remove('on'); runBtn.title = 'Run interview';
    pauseBtn.hidden = true; paused = false; caps.classList.remove('paused'); caps.classList.remove('offrec');
    pauseBtn.innerHTML = ICON_PAUSE; pauseBtn.classList.remove('on'); pauseBtn.title = 'Pause';
    LIVE.off = false; if (LIVE.offTimer) { clearInterval(LIVE.offTimer); LIVE.offTimer = null; }
    caps.hidden = true; caps.innerHTML = '';
    clearAnnos();
    state = {}; notes = []; clearBadges(); toasts.innerHTML = '';
    coverage(); drawInspector();
    syncTransport();
  }

  function finish() {
    // no hard ending — the live indicator simply rests at the present, future still open to the right
    var rec = caps.querySelector('.rec');
    if (rec) rec.textContent = 'Recording · 2 speakers · local';
    updateTL();
  }

