  // 09-documents.js — Export (Word / PDF) and import (tldraw, Word, PDF, picture). All files share one closure: see ui_asset() in analysis/assistant.py.
  /* ================= export: Word / PDF document of the tree + session ================= */
  var XOPT = { format: 'docx', transcript: 'annotated' };
  function exportPayload() {
    var sess = mmSession(), fname = (FILES.filter(function (x) { return x.id === ACTIVE; })[0] || {}).name;
    var qlabel = {}, qtext = {};
    NODES.forEach(function (n) { if (n.depth > 0) { qlabel[n.id] = mmQLabel(n); qtext[n.id] = n.text; } });
    var plan = topics().map(function (t) {
      return { label: t.label, text: t.text, children: t.children.map(function (q) {
        return { id: q.id, label: mmQLabel(q), text: q.text, added: !!q.added, children: q.children.map(function (f) {
          return { id: f.id, label: '↳', text: f.text, added: !!f.added };
        }) };
      }) };
    });
    var d = {
      title: $('xTitle').value.trim() || fname || 'Interview', format: XOPT.format,
      options: { questions: $('xQuestions').checked, transcript: XOPT.transcript, notes: $('xNotes').checked,
                 recordings: $('xRec').checked, anonymize: $('xAnon').checked },
      plan: plan, qlabel: qlabel, qtext: qtext, steps: [], clips: [], notes: [],
      page_notes: pageNotes.map(function (n) { return (n.text || '').trim(); }).filter(Boolean)
    };
    if (sess && sess.lastIdx >= 0) {
      var at = function (ms) { return fmtTime(sess.tbase + ms / 1000); };
      for (var i = 0; i <= sess.lastIdx; i++) {
        var e = sess.steps[i]; if (!e) continue;
        var w = mmStepWin(sess, i);
        d.steps.push({ time: at(w[0]), start: w[0], end: w[1], text: e.t, speaker: e.w,
          role: mmIsInterviewer(e) ? 'Interviewer' : 'Candidate',
          marks: (e.mark || []).map(function (m) { return [m[0], m[1]]; }),
          ahead: (e.anno || []).filter(function (a) { return a.kind === 'ahead'; }).map(function (a) { return a.id; }) });
      }
      d.duration = at(sess.cum[sess.lastIdx] || 0);
      d.clips = sess.clips.map(function (c) {
        return { start: c.startMs, end: c.endMs, time: at(c.startMs) + ' – ' + at(c.endMs),
                 reaction: c.reaction ? reactMeta(c.reaction).l : '', notes: (c.notes || []).slice() };
      });
      d.notes = sess.marks.filter(function (m) { return !m.q; }).map(function (m) {
        return { time: at(sess.cum[m.idx] || 0), text: m.text, qid: m.host || mmCurAt(sess, m.idx) };
      });
    }
    return d;
  }
  function syncExportUI() {
    var sess = mmSession(), has = !!(sess && sess.lastIdx >= 0);
    document.querySelectorAll('#exportModal [data-xseg]').forEach(function (seg) {
      seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', XOPT[seg.dataset.xseg] === b.dataset.v); });
    });
    document.querySelectorAll('#exportModal [data-xseg="transcript"] button').forEach(function (b) { b.disabled = !has && b.dataset.v !== 'none'; });
    $('xRec').disabled = !has; $('xRec').closest('label').classList.toggle('off', !has);
    var n = has ? (sess.lastIdx + 1) : 0, c = has ? sess.clips.length : 0;
    $('xInfo').textContent = has
      ? (live ? 'Current interview' : 'Last interview') + ': ' + n + ' lines, ' + c + ' recorded clip' + (c === 1 ? '' : 's') + '.'
      : 'No interview recorded yet — the document will contain the question plan and notes.';
  }
  function openExport() {
    var f = FILES.filter(function (x) { return x.id === ACTIVE; })[0];
    $('xTitle').value = f ? f.name : 'Interview';
    var sess = mmSession();
    if (!(sess && sess.lastIdx >= 0)) XOPT.transcript = 'none';
    $('xStatus').textContent = ''; $('xStatus').classList.remove('err');
    syncExportUI();
    $('exportModal').hidden = false;
  }
  $('exportModal').addEventListener('click', function (e) {
    if (e.target === $('exportModal') || e.target.closest('[data-xclose]')) { $('exportModal').hidden = true; return; }
    var b = e.target.closest('[data-xseg] button');
    if (b && !b.disabled) { XOPT[b.parentNode.dataset.xseg] = b.dataset.v; syncExportUI(); }
  });
  $('xGo').addEventListener('click', function () {
    var d = exportPayload(), st = $('xStatus'), go = $('xGo');
    var lines = d.steps.length + d.notes.length;
    st.classList.remove('err');
    st.textContent = d.options.anonymize && lines ? 'Anonymizing ' + lines + ' texts, then building…' : 'Building…';
    go.disabled = true;
    fetch(API + '/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
        var cd = r.headers.get('Content-Disposition') || '', m = cd.match(/filename="([^"]+)"/);
        return r.blob().then(function (b) { return { blob: b, name: m ? m[1] : 'interview.' + d.format }; });
      })
      .then(function (res) {
        var url = URL.createObjectURL(res.blob), a = document.createElement('a');
        a.href = url; a.download = res.name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        st.textContent = 'Downloaded ' + res.name;
      })
      .catch(function (err) {
        st.classList.add('err');
        st.textContent = /Failed to fetch/i.test(err.message) ? 'No backend — start the server (./start.sh)' : err.message;
      })
      .then(function () { go.disabled = false; });
  });

  /* ================= import: build a tree from tldraw / Miro export / Word / PDF / picture ===== */
  var IMP = null;                           // last parsed result {name, topics, info}
  function openImport() {
    IMP = null;
    $('iFile').value = ''; $('iPreview').hidden = true; $('iNameRow').hidden = true;
    $('iStatus').textContent = ''; $('iStatus').classList.remove('err'); $('iGo').disabled = true;
    $('importModal').hidden = false;
  }
  function importFile(file) {
    if (!file) return;
    var st = $('iStatus');
    st.classList.remove('err');
    st.textContent = 'Reading ' + file.name + '…';
    $('iGo').disabled = true; $('iPreview').hidden = true;
    var rd = new FileReader();
    rd.onload = function () {
      st.textContent = /\.(png|jpe?g|heic|heif|webp|gif|tiff?)$/i.test(file.name)
        ? 'Reading the text in the picture (on this Mac)…' : 'Building the tree…';
      fetch(API + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, data: rd.result }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
        .then(function (res) {
          IMP = res;
          $('iPreview').innerHTML = '<div class="info">' + esc(res.info) + '</div>' + res.topics.map(function (t) {
            return '<div class="it">' + esc(t.title) + '</div>' + t.questions.map(function (q) {
              return '<div class="iq">• ' + esc(q.text) + '</div>' +
                q.followups.map(function (f) { return '<div class="if">↳ ' + esc(f) + '</div>'; }).join('');
            }).join('');
          }).join('');
          $('iPreview').hidden = false;
          $('iName').value = res.name; $('iNameRow').hidden = false;
          st.textContent = 'Check the preview, then create the tree.';
          $('iGo').disabled = false;
        })
        .catch(function (err) {
          st.classList.add('err');
          st.textContent = /Failed to fetch/i.test(err.message) ? 'No backend — start the server (./start.sh)' : err.message;
        });
    };
    rd.onerror = function () { st.classList.add('err'); st.textContent = 'Could not read that file.'; };
    rd.readAsDataURL(file);
  }
  function importedTreeData(topics) {
    var n = 0, base = newId();
    function id() { return base + '_' + (++n); }        // unique even when built in one millisecond
    return JSON.stringify(topics.map(function (t) {
      return { i: id(), k: 'topic', t: t.title, m: '4 min', c: false, ch: t.questions.map(function (q) {
        return { i: id(), k: 'standard', t: q.text, c: false, ch: q.followups.map(function (f) {
          return { i: id(), k: 'follow', t: f, c: false, ch: [] };
        }) };
      }) };
    }));
  }
  $('iFile').addEventListener('change', function () { importFile(this.files[0]); });
  var iDrop = $('iDrop');
  ['dragenter', 'dragover'].forEach(function (ev) {
    iDrop.addEventListener(ev, function (e) { e.preventDefault(); iDrop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    iDrop.addEventListener(ev, function (e) { e.preventDefault(); iDrop.classList.remove('over'); });
  });
  iDrop.addEventListener('drop', function (e) { importFile(e.dataTransfer.files[0]); });
  $('importModal').addEventListener('click', function (e) {
    if (e.target === $('importModal') || e.target.closest('[data-xclose]')) $('importModal').hidden = true;
  });
  $('iGo').addEventListener('click', function () {
    if (!IMP) return;
    saveActive();
    var id = newId();
    FILES.push({ id: id, name: ($('iName').value || '').trim() || IMP.name, data: importedTreeData(IMP.topics), notes: [] });
    loadFile(id); renderFileList();
    $('importModal').hidden = true;
  });

