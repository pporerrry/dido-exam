/* =====================================================================
   ระบบเจ้าหน้าที่ — แดชบอร์ดเชิงลึก ทุกห้องเรียน (เชื่อมเซิร์ฟเวอร์กลาง)
   รหัสผ่านตรวจสอบฝั่งเซิร์ฟเวอร์ (456461)
   ===================================================================== */
(function () {
  'use strict';
  var DIDO = window.DIDO;
  var pw = sessionStorage.getItem('dido_staff_pw') || '';
  var records = [];
  var loaded = false; // ระบุว่าโหลดข้อมูลจากเซิร์ฟเวอร์เสร็จแล้วหรือยัง
  var currentProgram = null; // null = ดูทั้งหมด
  var currentTab = 'overview';

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function fmtTime(iso) { try { return new Date(iso).toLocaleString('th-TH'); } catch (e) { return iso; } }

  function injectLogo() {
    var el = $('#staffLogo'); if (!el) return;
    el.innerHTML = '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><circle cx="60" cy="60" r="57" fill="#3e2723"/><circle cx="60" cy="60" r="53" fill="#efebe9"/><path d="M32 26 L40 8 L54 20 Z" fill="#5d4037"/><path d="M88 26 L80 8 L66 20 Z" fill="#5d4037"/><path d="M36 24 L41 12 L50 21 Z" fill="#c8a24b"/><path d="M84 24 L79 12 L70 21 Z" fill="#c8a24b"/><path d="M60 18 C76 18 88 30 88 48 C88 66 78 80 60 80 C42 80 32 66 32 48 C32 30 44 18 60 18 Z" fill="#a1887f"/><path d="M60 56 C70 56 77 63 77 72 C77 80 70 86 60 86 C50 86 43 80 43 72 C43 63 50 56 60 56 Z" fill="#8d6e63"/><ellipse cx="60" cy="80" rx="8" ry="5" fill="#1b1b1b"/><ellipse cx="46" cy="46" rx="4.5" ry="5.5" fill="#2b2320"/><ellipse cx="74" cy="46" rx="4.5" ry="5.5" fill="#2b2320"/><circle cx="47.5" cy="44.5" r="1.6" fill="#fff"/><circle cx="75.5" cy="44.5" r="1.6" fill="#fff"/></svg>';
  }

  function setStatus(msg, ok) {
    var el = $('#connStatus'); if (!el) return;
    el.textContent = msg;
    el.className = 'header-badge ' + (ok ? 'badge-live' : '');
  }

  async function fetchRecords(pass) {
    let r;
    try {
      r = await fetch('/api/admin/records?pw=' + encodeURIComponent(pass));
    } catch (e) {
      throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ต้องรัน "node server.js" (หรือ start.bat) แล้วเปิด http://dido-wittayalai-test/staff.html (ห้ามเปิดไฟล์ staff.html โดยตรงแบบ double-click)');
    }
    if (r.status === 401) throw new Error('รหัสผ่านไม่ถูกต้อง');
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('เซิร์ฟเวอร์ตอบข้อมูลไม่ถูกต้อง'); }
    if (!j.ok) throw new Error(j.error || 'เกิดข้อผิดพลาด');
    return j.records || [];
  }

  function render() {
    var app = $('#staffApp');
    if (!pw) { renderLogin(app); return; }
    if (!loaded) {
      // โหลดครั้งแรก
      fetchRecords(pw).then(function (r) {
        records = r; loaded = true; setStatus('● ออนไลน์ · ' + records.length + ' รายการ', true); render();
      }).catch(function (e) {
        loaded = false; pw = ''; sessionStorage.removeItem('dido_staff_pw'); render();
      });
      return;
    }
    setStatus('● ออนไลน์ · ' + records.length + ' รายการ', true);
    app.innerHTML = headerHtml() + (currentTab === 'overview' ? overviewHtml() : currentTab === 'all' ? allHtml() : programHtml());
    bindEvents();
  }

  function renderLogin(app) {
    var protoOk = location.protocol === 'http:' || location.protocol === 'https:';
    var warn = protoOk ? '' :
      '<div class="notice warn">⚠ คุณเปิดหน้านี้แบบไฟล์ตรง (file://) ซึ่งไม่มีเซิร์ฟเวอร์ กรุณารัน <strong>node server.js</strong> (หรือ start.bat) แล้วเปิด <strong>http://dido-wittayalai-test/staff.html</strong> แทน</div>';
    app.innerHTML =
      '<div class="card" style="max-width:520px;margin:40px auto"><h2>🔐 เข้าสู่ระบบเจ้าหน้าที่</h2>' +
      '<p class="muted">กรอกรหัสผ่านเพื่อเข้าดูรายชื่อ คะแนน และสถิติของผู้เข้าสอบทุกห้อง (ตรวจสอบฝั่งเซิร์ฟเวอร์)</p>' +
      warn +
      '<div class="field"><input id="pwInput" type="password" placeholder="รหัสผ่าน" /></div>' +
      '<div class="error-text" id="pwErr"></div>' +
      '<button class="btn primary block" id="btnLogin">เข้าสู่ระบบ</button></div>';
    $('#btnLogin').addEventListener('click', async function () {
      var v = $('#pwInput').value;
      try {
        records = await fetchRecords(v);
        pw = v; loaded = true; sessionStorage.setItem('dido_staff_pw', v);
        $('#pwErr').textContent = '';
        render();
      } catch (e) { $('#pwErr').textContent = '⚠ ' + e.message; }
    });
    $('#pwInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btnLogin').click(); });
  }

  function headerHtml() {
    return '<div class="card flex-between">' +
      '<div><h2 style="margin:0">แดชบอร์ดเจ้าหน้าที่ — ภาพรวมทุกห้อง</h2>' +
      '<p class="muted">ผู้เข้าสอบทั้งหมด ' + records.length + ' คน · <button class="btn small outline" id="btnRefresh">🔄 โหลดข้อมูลใหม่</button> ' +
      '<button class="btn small outline" id="btnLogout">ออกจากระบบ</button></p></div>' +
      '</div>' +
      '<div class="filter-bar">' +
        '<button class="tab-btn ' + (currentTab === 'overview' ? 'active' : '') + '" data-tab="overview">📊 สรุปทุกห้อง</button>' +
        '<button class="tab-btn ' + (currentTab === 'all' ? 'active' : '') + '" data-tab="all">📋 รายชื่อทั้งหมด</button>' +
      '</div>';
  }

  /* ---------- แท็บสรุปทุกห้อง ---------- */
  function overviewHtml() {
    var rows = DIDO.PROGRAMS.map(function (p) {
      var recs = records.filter(function (r) { return r.programId === p.id; });
      var n = recs.length;
      var avg = n ? round2(recs.reduce(function (a, r) { return a + r.total; }, 0) / n) : '—';
      var max = n ? Math.max.apply(null, recs.map(function (r) { return r.total; })) : '—';
      var min = n ? Math.min.apply(null, recs.map(function (r) { return r.total; })) : '—';
      var comp = n + '/' + p.seats + ' (' + (p.seats ? round2(n / p.seats * 100) : 0) + '%)';
      return '<tr class="row-click" data-pid="' + p.id + '">' +
        '<td>' + (p.category === 'special' ? 'พิเศษ' : 'ธรรมดา') + '</td>' +
        '<td><strong>' + esc(p.code) + '</strong></td>' +
        '<td>' + esc(p.name) + '</td>' +
        '<td>' + p.seats + '</td>' +
        '<td>' + n + '</td>' +
        '<td>' + comp + '</td>' +
        '<td>' + avg + ' / ' + p.totalScore + '</td>' +
        '<td>' + max + '</td>' +
        '<td>' + min + '</td>' +
      '</tr>';
    }).join('');

    return '<div class="card"><h2>📊 สรุปผู้เข้าสอบทุกห้องเรียน</h2>' +
      '<p class="muted">กดแถวเพื่อดูรายละเอียดเชิงลึกของห้องนั้น</p>' +
      '<div style="overflow:auto"><table class="table"><thead><tr>' +
      '<th>หมวด</th><th>รหัส</th><th>แผนการเรียน</th><th>ที่นั่ง</th><th>ผู้สอบ</th><th>อัตราแข่งขัน</th><th>เฉลี่ย</th><th>สูงสุด</th><th>ต่ำสุด</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  /* ---------- แท็บรายชื่อทั้งหมด ---------- */
  function allHtml() {
    var list = records.slice().sort(function (a, b) { return b.total - a.total; });
    var rows = list.map(function (r) {
      return '<tr class="row-click" data-recid="' + r.id + '">' +
        '<td>' + esc(r.firstName) + ' ' + esc(r.lastName) + '</td>' +
        '<td>' + esc(r.school) + '</td>' +
        '<td><strong>' + esc(r.programCode || '') + '</strong></td>' +
        '<td>' + r.total + ' / ' + r.totalMax + '</td>' +
        '<td>' + r.percent + '%</td>' +
        '<td class="muted">' + fmtTime(r.ts) + '</td>' +
      '</tr>';
    }).join('');

    return '<div class="card"><h2>📋 รายชื่อผู้เข้าสอบทั้งหมด (' + records.length + ' คน)</h2>' +
      '<div class="filter-bar"><input id="searchBox" type="text" placeholder="ค้นหาชื่อ / โรงเรียน..." style="flex:1;min-width:220px" /></div>' +
      '<div style="overflow:auto;max-height:600px"><table class="table"><thead><tr>' +
      '<th>ชื่อ-นามสกุล</th><th>โรงเรียนเดิม</th><th>ห้องที่สอบ</th><th>คะแนน</th><th>ร้อยละ</th><th>ส่งเมื่อ</th>' +
      '</tr></thead><tbody id="allBody">' + rows + '</tbody></table></div></div>';
  }

  /* ---------- แท็บรายละเอียดรายห้อง ---------- */
  function programHtml() {
    var p = findProgram(currentProgram);
    if (!p) return '<div class="card"><p class="muted">ไม่พบแผนการเรียน</p></div>';
    var recs = records.filter(function (r) { return r.programId === p.id; }).sort(function (a, b) { return b.total - a.total; });

    var listRows = recs.map(function (r, i) {
      return '<tr class="row-click" data-recid="' + r.id + '">' +
        '<td>' + (i + 1) + '</td><td>' + esc(r.firstName) + ' ' + esc(r.lastName) + '</td>' +
        '<td>' + esc(r.school) + '</td><td>' + r.total + ' / ' + r.totalMax + '</td><td>' + r.percent + '%</td>' +
        '<td class="muted">' + fmtTime(r.ts) + '</td></tr>';
    }).join('');

    var n = recs.length;
    var totals = recs.map(function (r) { return r.total; });
    var sum = totals.reduce(function (a, b) { return a + b; }, 0);
    var mean = n ? sum / n : 0;
    var sorted = totals.slice().sort(function (a, b) { return a - b; });
    var median = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : 0;

    // แจกแจง
    var buckets = { '0-60%': 0, '61-70%': 0, '71-80%': 0, '81-90%': 0, '91-99%': 0, '100%': 0 };
    recs.forEach(function (r) {
      if (r.percent <= 60) buckets['0-60%']++;
      else if (r.percent <= 70) buckets['61-70%']++;
      else if (r.percent <= 80) buckets['71-80%']++;
      else if (r.percent <= 90) buckets['81-90%']++;
      else if (r.percent <= 99) buckets['91-99%']++;
      else buckets['100%']++;
    });
    var distRows = Object.keys(buckets).map(function (k) { return '<tr><td>' + k + '</td><td>' + buckets[k] + ' คน</td></tr>'; }).join('');

    // เปรียบเทียบวิชา
    var subjAgg = {};
    recs.forEach(function (r) {
      (r.subjectScores || []).forEach(function (s) {
        if (!subjAgg[s.key]) subjAgg[s.key] = { name: s.name, maxScore: s.maxScore, mcq: s.mcq, scores: [] };
        subjAgg[s.key].scores.push(s.score);
      });
    });
    var subjRows = Object.keys(subjAgg).map(function (k) {
      var a = subjAgg[k]; var m = a.scores.reduce(function (x, y) { return x + y; }, 0) / a.scores.length;
      return '<tr><td>' + esc(a.name) + '</td><td>' + a.mcq + '</td><td>' + round2(m) + ' / ' + a.maxScore + '</td><td>' + round2((m / a.maxScore) * 100) + '%</td></tr>';
    }).join('');

    return '<div class="card"><div class="flex-between"><h2 style="margin:0">📊 ' + esc(p.code) + ' — ' + esc(p.name) + '</h2>' +
      '<button class="btn outline small" id="btnBackAll">← กลับสรุปทุกห้อง</button></div>' +
      '<div class="kpi mt-2">' +
        '<div class="stat-box"><div class="v">' + n + '</div><div class="l">ผู้เข้าสอบ</div></div>' +
        '<div class="stat-box"><div class="v">' + round2(mean) + '</div><div class="l">คะแนนเฉลี่ย</div></div>' +
        '<div class="stat-box"><div class="v">' + round2(median) + '</div><div class="l">มัธยฐาน</div></div>' +
        '<div class="stat-box"><div class="v">' + (n ? sorted[n - 1] : '—') + '</div><div class="l">สูงสุด</div></div>' +
        '<div class="stat-box"><div class="v">' + (n ? sorted[0] : '—') + '</div><div class="l">ต่ำสุด</div></div>' +
        '<div class="stat-box"><div class="v">' + n + '/' + p.seats + '</div><div class="l">ผู้สอบ/ที่นั่ง (' + round2(n / p.seats * 100) + '%)</div></div>' +
      '</div></div>' +

      '<div class="card"><h3>รายชื่อผู้เข้าสอบ (เรียงคะแนน)</h3><div style="overflow:auto"><table class="table"><thead><tr>' +
      '<th>#</th><th>ชื่อ-นามสกุล</th><th>โรงเรียนเดิม</th><th>คะแนน</th><th>ร้อยละ</th><th>ส่งเมื่อ</th></tr></thead>' +
      '<tbody>' + listRows + '</tbody></table></div></div>' +

      '<div class="card"><h3>การแจกแจงคะแนน</h3><table class="table"><tbody>' + distRows + '</tbody></table></div>' +
      '<div class="card"><h3>เปรียบเทียบคะแนนระหว่างวิชา</h3><table class="table"><thead><tr><th>วิชา</th><th>ข้อ</th><th>คะแนนเฉลี่ย</th><th>ร้อยละเฉลี่ย</th></tr></thead><tbody>' + subjRows + '</tbody></table></div>';
  }

  function findProgram(id) {
    for (var i = 0; i < DIDO.PROGRAMS.length; i++) if (DIDO.PROGRAMS[i].id === id) return DIDO.PROGRAMS[i];
    return null;
  }

  /* ---------- รายละเอียดผู้เข้าสอบ (modal) ---------- */
  function showRecordDetail(recId) {
    var r = records.find(function (x) { return x.id === recId; });
    if (!r) return;
    var subjRows = (r.subjectScores || []).map(function (s) {
      var essayTxt = '';
      if (s.essay) essayTxt = ' · ข้อเขียน ' + s.essay.score + '/' + s.essay.maxScore + ' (เหมือนเฉลย ' + (s.essay.similarity || 0) + '%)';
      return '<tr><td>' + esc(s.name) + '</td><td>' + s.correct + '/' + s.mcq + '</td><td>' + round2(s.score) + '/' + s.maxScore + '</td><td>' + essayTxt + '</td></tr>';
    }).join('');

    var essayTexts = '';
    Object.keys(r.essayAnswers || {}).forEach(function (k) {
      var txt = r.essayAnswers[k];
      if (txt) essayTexts += '<div class="field"><label>ข้อเขียน (' + esc(k) + ')</label><div class="muted" style="white-space:pre-wrap;background:#f6efe9;padding:10px;border-radius:8px">' + esc(txt) + '</div></div>';
    });

    $('#modalBox').innerHTML =
      '<h3>รายละเอียดผู้เข้าสอบ</h3>' +
      '<p><strong>' + esc(r.firstName) + ' ' + esc(r.lastName) + '</strong> · ' + esc(r.school) + '</p>' +
      '<p>' + esc(r.programCode || '') + ' — ' + esc(r.programName || '') + ' · ส่งเมื่อ ' + fmtTime(r.ts) + '</p>' +
      '<div class="score-big">' + r.total + ' / ' + r.totalMax + ' <span class="muted" style="font-size:1.2rem">(' + r.percent + '%)</span></div>' +
      '<p class="lead">' + esc(r.evaluation || '') + '</p>' +
      '<table class="table"><thead><tr><th>วิชา</th><th>ตอบถูก</th><th>คะแนน</th><th>ข้อเขียน</th></tr></thead><tbody>' + subjRows + '</tbody></table>' +
      essayTexts +
      '<div class="flex-between"><button class="btn outline" id="btnClose">ปิด</button></div>';
    $('#modalBackdrop').classList.remove('hidden');
    $('#btnClose').addEventListener('click', closeModal);
  }
  function closeModal() { $('#modalBackdrop').classList.add('hidden'); $('#modalBox').innerHTML = ''; }

  /* ---------- bind events ---------- */
  function bindEvents() {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.addEventListener('click', function () { currentTab = b.getAttribute('data-tab'); currentProgram = null; render(); });
    });
    document.querySelectorAll('[data-pid]').forEach(function (el) {
      el.addEventListener('click', function () { currentProgram = el.getAttribute('data-pid'); currentTab = 'program'; render(); });
    });
    document.querySelectorAll('[data-recid]').forEach(function (el) {
      el.addEventListener('click', function () { showRecordDetail(el.getAttribute('data-recid')); });
    });
    var back = $('#btnBackAll'); if (back) back.addEventListener('click', function () { currentProgram = null; currentTab = 'overview'; render(); });
    var refresh = $('#btnRefresh'); if (refresh) refresh.addEventListener('click', async function () { records = await fetchRecords(pw); loaded = true; render(); });
    var logout = $('#btnLogout'); if (logout) logout.addEventListener('click', function () { pw = ''; loaded = false; sessionStorage.removeItem('dido_staff_pw'); records = []; render(); });
    var search = $('#searchBox');
    if (search) search.addEventListener('input', function () {
      var q = this.value.trim().toLowerCase();
      document.querySelectorAll('#allBody tr').forEach(function (tr) {
        tr.style.display = (tr.textContent.toLowerCase().indexOf(q) >= 0) ? '' : 'none';
      });
    });
    var mbd = $('#modalBackdrop'); if (mbd) mbd.addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  }

  injectLogo();
  render();
})();
