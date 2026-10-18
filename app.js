/* =====================================================================
   ระบบข้อสอบสอบเข้า ม.4 โรงเรียนดีโด้วิทยาลัย — ตรรกะแอปพลิเคชัน
   ===================================================================== */
(function () {
  'use strict';

  var DIDO = window.DIDO;
  var DB_KEY = 'dido_exam_records_v1';
  var DRAFT_KEY = 'dido_exam_draft_v1';

  /* ---------------- State ---------------- */
  var S = {
    screen: 'register',
    user: null,            // { firstName, lastName, school }
    program: null,         // object from DIDO.PROGRAMS
    flat: [],              // แบนรายการข้อสอบทั้งหมด [{gi, subjectKey, subjectName, num, q, opts, ans, exp, part, listen, lang}]
    answers: {},           // gi -> option index
    essayAnswers: {},      // subjectKey -> text
    listeningPlays: {},    // gi -> count
    current: 0,            // gi ปัจจุบัน
    deadline: null,        // timestamp
    timerId: null,
    result: null,          // ผลการตรวจหลังส่ง
    answerKeyGranted: false,
    dashboardGranted: false,
  };

  /* ---------------- Utilities ---------------- */
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtTime(ms) {
    ms = Math.max(0, ms);
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(h) + ':' + p(m) + ':' + p(sec);
  }
  function hasThai(str) { return /[\u0e00-\u0e7f]/.test(str || ''); }
  function round2(n) { return Math.round(n * 100) / 100; }

  /* ---------------- การตรวจข้อเขียนอัตโนมัติ (เทียบความเหมือนกับเฉลย) ---------------- */
  function normalizeText(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[^\u0e00-\u0e7f a-z0-9+\-*/()^=.,<>]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function bigramSet(s) {
    var set = {};
    for (var i = 0; i < s.length - 1; i++) set[s.substr(i, 2)] = true;
    return set;
  }
  function ngramJaccard(a, b) {
    var A = bigramSet(a), B = bigramSet(b);
    var inter = 0, union = 0;
    for (var k in A) { union++; if (B[k]) inter++; }
    for (var k2 in B) { if (!A[k2]) union++; }
    return union ? inter / union : 0;
  }
  // ให้คะแนนข้อเขียน: coverage(คำสำคัญ) 55% + ความคล้าย n-gram 45%
  function gradeEssay(text, essay) {
    var t = normalizeText(text);
    if (!t) return { score: 0, similarity: 0, coverage: 0, sim: 0, hit: 0, totalKeywords: (essay.keywords || []).length };
    var ref = normalizeText(essay.answer || '');
    var kws = essay.keywords || [];
    var hit = 0;
    for (var i = 0; i < kws.length; i++) {
      if (t.indexOf(normalizeText(kws[i])) !== -1) hit++;
    }
    var coverage = kws.length ? hit / kws.length : 0;
    var sim = ref ? ngramJaccard(t, ref) : 0;
    var similarity = Math.min(1, 0.55 * coverage + 0.45 * sim);
    return {
      score: Math.round(similarity * essay.maxScore),
      similarity: similarity,
      coverage: coverage, sim: sim, hit: hit, totalKeywords: kws.length,
    };
  }

  /* ---------------- กระจายตำแหน่งคำตอบ (สลับตัวเลือกแบบกำหนดได้) ---------------- */
  function hashCode(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  // สลับตัวเลือกเพื่อให้คำตอบถูกกระจาย ไม่กระจุกที่ข้อแรก
  function shuffleOpts(qtext, opts, ans) {
    if (!opts || opts.length < 2) return { opts: opts, ans: ans };
    var rnd = mulberry32(hashCode(String(qtext) + '::' + ans));
    var idx = [];
    for (var i = 0; i < opts.length; i++) idx.push(i);
    for (var j = opts.length - 1; j > 0; j--) {
      var k = Math.floor(rnd() * (j + 1));
      var tmp = idx[j]; idx[j] = idx[k]; idx[k] = tmp;
    }
    var newOpts = idx.map(function (x) { return opts[x]; });
    var newAns = idx.indexOf(ans);
    return { opts: newOpts, ans: newAns < 0 ? 0 : newAns };
  }

  function loadRecords() {
    try { return JSON.parse(localStorage.getItem(DB_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function saveRecords(list) {
    localStorage.setItem(DB_KEY, JSON.stringify(list));
  }
  // บันทึกผลสอบไปยังเซิร์ฟเวอร์กลาง (กรณีเปิดผ่าน http://) — fallback เก็บในเครื่องถ้าเปิดแบบ file://
  function syncRecordToServer(rec) {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    try {
      fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rec),
      }).catch(function () {});
    } catch (e) {}
  }

  /* ---------------- German Shepherd logo ---------------- */
  function injectLogo() {
    var svg =
      '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="German Shepherd">' +
      '<circle cx="60" cy="60" r="57" fill="#3e2723"/>' +
      '<circle cx="60" cy="60" r="53" fill="#efebe9"/>' +
      // ears
      '<path d="M32 26 L40 8 L54 20 Z" fill="#5d4037"/>' +
      '<path d="M88 26 L80 8 L66 20 Z" fill="#5d4037"/>' +
      '<path d="M36 24 L41 12 L50 21 Z" fill="#c8a24b"/>' +
      '<path d="M84 24 L79 12 L70 21 Z" fill="#c8a24b"/>' +
      // head
      '<path d="M60 18 C76 18 88 30 88 48 C88 66 78 80 60 80 C42 80 32 66 32 48 C32 30 44 18 60 18 Z" fill="#a1887f"/>' +
      // muzzle
      '<path d="M60 56 C70 56 77 63 77 72 C77 80 70 86 60 86 C50 86 43 80 43 72 C43 63 50 56 60 56 Z" fill="#8d6e63"/>' +
      '<ellipse cx="60" cy="80" rx="8" ry="5" fill="#1b1b1b"/>' +
      // eyes
      '<ellipse cx="46" cy="46" rx="4.5" ry="5.5" fill="#2b2320"/>' +
      '<ellipse cx="74" cy="46" rx="4.5" ry="5.5" fill="#2b2320"/>' +
      '<circle cx="47.5" cy="44.5" r="1.6" fill="#fff"/>' +
      '<circle cx="75.5" cy="44.5" r="1.6" fill="#fff"/>' +
      // forehead blaze
      '<path d="M56 20 L60 30 L64 20 C62 24 58 24 56 20 Z" fill="#c8a24b"/>' +
      '</svg>';
    var el = $('#siteLogo'); if (el) el.innerHTML = svg;
  }

  /* ---------------- ตรวจสอบความครบของธนาคารข้อสอบ ---------------- */
  function bankIssues() {
    var issues = [];
    DIDO.PROGRAMS.forEach(function (p) {
      p.subjects.forEach(function (s) {
        if (s.essay && !DIDO.ESSAYS[s.key]) issues.push(p.code + ':' + s.name + ' ขาด Essay prompt');
        if (!s.mcq) return;
        var bank = (DIDO.QUESTIONS || {})[s.key];
        if (!bank) issues.push(p.code + ':' + s.name + ' (' + s.key + ') ไม่มีธนาคารข้อสอบ');
        else if (bank.length < s.mcq) issues.push(p.code + ':' + s.name + ' มี ' + bank.length + ' ข้อ แต่ต้องการ ' + s.mcq);
      });
    });
    return issues;
  }

  /* ---------------- Router ---------------- */
  function render() {
    var app = $('#app');
    var timerBar = $('#timerBar');
    timerBar.classList.toggle('hidden', S.screen !== 'exam');
    if (S.screen === 'exam') renderTimerBar();

    switch (S.screen) {
      case 'register': renderRegister(app); break;
      case 'curriculum': renderCurriculum(app); break;
      case 'curriculum-detail': renderCurriculumDetail(app); break;
      case 'select': renderSelect(app); break;
      case 'pre-exam': renderPreExam(app); break;
      case 'exam': renderExam(app); break;
      case 'review': renderReview(app); break;
      case 'result': renderResult(app); break;
      case 'dashboard': renderDashboard(app); break;
      default: renderRegister(app);
    }
    window.scrollTo(0, 0);
  }

  function goto(screen) { S.screen = screen; render(); }

  /* ================= 1. หน้าแรก + กรอกข้อมูล ================= */
  function renderRegister(app) {
    app.innerHTML =
      '<div class="card text-center">' +
        '<h2>ยินดีต้อนรับเข้าสู่ระบบข้อสอบออนไลน์</h2>' +
        '<p class="lead">' + esc(DIDO.SCHOOL_NAME) + '</p>' +
        '<p class="lead" style="font-weight:700">' + esc(DIDO.EXAM_TITLE) + '</p>' +
        '<div style="font-size:3.2rem;margin:8px 0">🐕🦺</div>' +
        '<p class="muted">สัญลักษณ์ประจำระบบข้อสอบ : สุนัขพันธุ์ German Shepherd</p>' +
      '</div>' +

      '<div class="card">' +
        '<h2>กรอกข้อมูลผู้เข้าสอบ</h2>' +
        '<p class="muted">กรุณากรอกข้อมูลเป็นภาษาไทยให้ครบถ้วนก่อนเข้าสู่ระบบเลือกสอบ</p>' +
        '<div class="field"><label>1. ชื่อจริง</label>' +
          '<input id="fName" type="text" placeholder="ชื่อจริง (ภาษาไทย)" /></div>' +
        '<div class="field"><label>2. นามสกุล</label>' +
          '<input id="fLast" type="text" placeholder="นามสกุล (ภาษาไทย)" /></div>' +
        '<div class="field"><label>3. โรงเรียนเดิมที่กำลังศึกษาอยู่</label>' +
          '<input id="fSchool" type="text" placeholder="ชื่อโรงเรียน (ภาษาไทย)" /></div>' +
        '<div class="error-text" id="regErr"></div>' +
        '<button class="btn primary block" id="btnReg">ถัดไป : ข้อมูลหลักสูตรแผนการเรียน</button>' +
      '</div>';

    $('#btnReg').addEventListener('click', function () {
      var fn = $('#fName').value.trim();
      var ln = $('#fLast').value.trim();
      var sc = $('#fSchool').value.trim();
      var errs = [];
      if (!fn) errs.push('กรุณากรอกชื่อจริง');
      else if (!hasThai(fn)) errs.push('ชื่อจริงต้องเป็นภาษาไทย');
      if (!ln) errs.push('กรุณากรอกนามสกุล');
      else if (!hasThai(ln)) errs.push('นามสกุลต้องเป็นภาษาไทย');
      if (!sc) errs.push('กรุณากรอกชื่อโรงเรียนเดิม');
      else if (!hasThai(sc)) errs.push('ชื่อโรงเรียนต้องเป็นภาษาไทย');
      if (errs.length) { $('#regErr').textContent = '⚠ ' + errs.join(' · '); return; }
      S.user = { firstName: fn, lastName: ln, school: sc };
      $('#regErr').textContent = '';
      goto('curriculum');
    });
  }

  /* ================= 2. หน้ารวมหลักสูตร ================= */
  function renderCurriculum(app) {
    var cards = DIDO.PROGRAMS.map(function (p) {
      var badge = p.category === 'special'
        ? '<span class="badge special">ห้องเรียนพิเศษ · รับ ' + p.seats + ' คน</span>'
        : '<span class="badge regular">ห้องเรียนธรรมดา · รับ ' + p.seats + ' คน</span>';
      return '<div class="program-card" data-id="' + p.id + '">' +
        '<div class="code">' + esc(p.code) + '</div>' +
        '<div class="name">' + esc(p.name) + '</div>' +
        '<div class="meta">' + badge +
        '<span class="badge">' + p.time + ' นาที</span>' +
        '<span class="badge gold">' + p.totalScore + ' คะแนน</span></div>' +
      '</div>';
    }).join('');

    app.innerHTML =
      '<div class="card flex-between">' +
        '<div><h2 style="margin:0">ข้อมูลแผนการเรียนทั้งหมด</h2>' +
        '<p class="muted">สวัสดี ' + esc(S.user.firstName) + ' ' + esc(S.user.lastName) +
        ' · ' + esc(S.user.school) + ' — กดเลือกแผนการเรียนเพื่อดูรายละเอียด</p></div>' +
        '<button class="btn primary" id="btnToSelect">ข้ามไปหน้าเลือกสอบ →</button>' +
      '</div>' +
      '<div class="notice">หลักสูตรแต่ละแผนการเรียนเป็นหลักสูตรตัวอย่าง (จัดทำขึ้นเพื่อการสาธิตระบบ) — กดเลือกแผนการเรียนเพื่อดูรายละเอียดรายภาคเรียน ม.4–ม.6</div>' +
      '<div class="section-title"><span class="dot"></span><h2>หมวด A : ห้องเรียนพิเศษ</h2></div>' +
      '<div class="grid">' + DIDO.PROGRAMS.filter(function(p){return p.category==='special';}).map(function(p){return programCardHtml(p);}).join('') + '</div>' +
      '<div class="section-title"><span class="dot"></span><h2>หมวด B : ห้องเรียนธรรมดา</h2></div>' +
      '<div class="grid">' + DIDO.PROGRAMS.filter(function(p){return p.category==='regular';}).map(function(p){return programCardHtml(p);}).join('') + '</div>';

    document.querySelectorAll('.program-card').forEach(function (el) {
      el.addEventListener('click', function () {
        S.program = findProgram(el.getAttribute('data-id'));
        goto('curriculum-detail');
      });
    });
    $('#btnToSelect').addEventListener('click', function () { goto('select'); });
  }

  function programCardHtml(p) {
    var badge = p.category === 'special'
      ? '<span class="badge special">พิเศษ</span>' : '<span class="badge regular">ธรรมดา</span>';
    return '<div class="program-card" data-id="' + p.id + '">' +
      '<div class="code">' + esc(p.code) + '</div>' +
      '<div class="name">' + esc(p.name) + '</div>' +
      '<div class="meta">' + badge +
      '<span class="badge">รับ ' + p.seats + '</span>' +
      '<span class="badge">' + p.time + ' นาที</span>' +
      '<span class="badge gold">' + p.totalScore + ' คะแนน</span></div>' +
    '</div>';
  }

  function findProgram(id) {
    for (var i = 0; i < DIDO.PROGRAMS.length; i++) if (DIDO.PROGRAMS[i].id === id) return DIDO.PROGRAMS[i];
    return null;
  }

  /* ================= 3. รายละเอียดแผนการเรียน ================= */
  function renderCurriculumDetail(app) {
    var p = S.program;
    var cur = (DIDO.CURRICULA || {})[p.id] || {};
    var semRows = DIDO.SEMESTERS.map(function (s) {
      return '<tr><td>' + esc(s.label) + '</td>' +
        '<td>' + esc(cur[s.key] || '—') + '</td></tr>';
    }).join('');

    var subjRows = p.subjects.map(function (s) {
      var text = s.mcq + ' ข้อปรนัย' + (s.essay ? ' + ข้อเขียน ' + s.essay + ' ข้อ' : '') +
        ' · คะแนนเต็ม ' + s.maxScore + (s.levelNote ? ' · ' + s.levelNote : '');
      return '<tr><td>' + esc(s.name) + '</td><td>' + esc(text) + '</td></tr>';
    }).join('');

    app.innerHTML =
      '<div class="card">' +
        '<div class="flex-between"><h2 style="margin:0">' + esc(p.code) + ' — ' + esc(p.name) + '</h2>' +
        '<span class="badge ' + (p.category === 'special' ? 'special' : 'regular') + '">' +
          (p.category === 'special' ? 'ห้องเรียนพิเศษ' : 'ห้องเรียนธรรมดา') + ' · รับ ' + p.seats + ' คน</span></div>' +
        '<p class="lead">' + esc(p.desc) + '</p>' +
        '<p><strong>จุดเน้น :</strong> ' + esc(p.focus) + '</p>' +
      '</div>' +

      '<div class="card">' +
        '<h2>หลักสูตร ม.4 – ม.6 (6 ภาคเรียน)</h2>' +
        '<table class="table"><thead><tr><th style="width:200px">ภาคเรียน</th><th>รายละเอียดหลักสูตร</th></tr></thead>' +
        '<tbody>' + semRows + '</tbody></table>' +
      '</div>' +

      '<div class="card">' +
        '<h2>รายละเอียดการสอบ</h2>' +
        '<p><span class="badge">เวลาสอบ ' + p.time + ' นาที</span> ' +
        '<span class="badge gold">คะแนนเต็มรวม ' + p.totalScore + ' คะแนน</span></p>' +
        '<table class="table"><thead><tr><th>วิชา</th><th>รายละเอียดข้อสอบ</th></tr></thead>' +
        '<tbody>' + subjRows + '</tbody></table>' +
        (p.note ? '<p class="muted mt-2">' + esc(p.note) + '</p>' : '') +
      '</div>' +

      '<div class="flex-between">' +
        '<button class="btn outline" id="btnBack">← กลับหน้ารวมแผนการเรียน</button>' +
        '<button class="btn primary" id="btnGoSelect">เข้าสู่หน้าเลือกสอบ →</button>' +
      '</div>';

    $('#btnBack').addEventListener('click', function () { goto('curriculum'); });
    $('#btnGoSelect').addEventListener('click', function () { goto('select'); });
  }

  /* ================= 4. หน้าเลือกสอบ ================= */
  function renderSelect(app) {
    var sp = DIDO.PROGRAMS.filter(function(p){return p.category==='special';});
    var rg = DIDO.PROGRAMS.filter(function(p){return p.category==='regular';});

    app.innerHTML =
      '<div class="card">' +
        '<h2>เลือกแผนการเรียนที่ต้องการสอบ</h2>' +
        '<p class="muted">ผู้เข้าสอบ : ' + esc(S.user.firstName) + ' ' + esc(S.user.lastName) + ' · ' + esc(S.user.school) + '</p>' +
        '<div class="notice" id="draftNotice" style="display:none"></div>' +
      '</div>' +

      '<div class="section-title"><span class="dot"></span><h2>หมวด A : ห้องเรียนพิเศษ (รับ 30 คน/แผน)</h2></div>' +
      '<div class="grid">' + sp.map(programCardHtml).join('') + '</div>' +

      '<div class="section-title"><span class="dot"></span><h2>หมวด B : ห้องเรียนธรรมดา (รับ 40 คน/แผน)</h2></div>' +
      '<div class="grid">' + rg.map(programCardHtml).join('') + '</div>' +

      '<div class="card text-center">' +
        '<p>ต้องการดูรายชื่อ คะแนน และสถิติของผู้เข้าสอบ?</p>' +
        '<button class="btn gold" id="btnDashboard">🔐 แดชบอร์ดรายชื่อและคะแนน</button>' +
      '</div>';

    document.querySelectorAll('.program-card').forEach(function (el) {
      el.addEventListener('click', function () {
        S.program = findProgram(el.getAttribute('data-id'));
        goto('pre-exam');
      });
    });
    $('#btnDashboard').addEventListener('click', function () { askDashboardPassword(); });

    // draft resume
    var draft = loadDraft();
    if (draft && draft.programId && !isDraftExpired(draft)) {
      var p = findProgram(draft.programId);
      if (p) {
        $('#draftNotice').style.display = 'block';
        $('#draftNotice').innerHTML =
          'คุณมีข้อสอบค้างอยู่ : <strong>' + esc(p.code) + '</strong> (' + esc(p.name) + ') ' +
          '<button class="btn small primary" id="btnResume">ทำข้อสอบต่อ</button> ' +
          '<button class="btn small outline" id="btnDiscard">ยกเลิกข้อสอบเดิม</button>';
        $('#btnResume').addEventListener('click', function () { resumeDraft(draft, p); });
        $('#btnDiscard').addEventListener('click', function () { localStorage.removeItem(DRAFT_KEY); $('#draftNotice').style.display='none'; });
      }
    }
  }

  /* ================= 5. รายละเอียดก่อนเริ่มสอบ ================= */
  function renderPreExam(app) {
    var p = S.program;
    var subjRows = p.subjects.map(function (s) {
      var det = s.mcq + ' ข้อปรนัย' + (s.essay ? ' + ข้อเขียน ' + s.essay + ' ข้อ' : '') +
        ' · คะแนนเต็ม ' + s.maxScore + (s.levelNote ? ' · ' + s.levelNote : '');
      return '<tr><td>' + esc(s.name) + '</td><td>' + esc(det) + '</td></tr>';
    }).join('');

    app.innerHTML =
      '<div class="card">' +
        '<h2>รายละเอียดก่อนเริ่มสอบ</h2>' +
        '<p class="lead">' + esc(p.code) + ' — ' + esc(p.name) + '</p>' +
        '<p><span class="badge">เวลาสอบ ' + p.time + ' นาที</span> ' +
        '<span class="badge gold">คะแนนเต็ม ' + p.totalScore + ' คะแนน</span> ' +
        '<span class="badge ' + (p.category==='special'?'special':'regular') + '">รับ ' + p.seats + ' คน</span></p>' +
      '</div>' +
      '<div class="card">' +
        '<h2>วิชาที่สอบ</h2>' +
        '<table class="table"><thead><tr><th>วิชา</th><th>จำนวนข้อ / คะแนน</th></tr></thead><tbody>' + subjRows + '</tbody></table>' +
        (p.note ? '<p class="muted mt-2">' + esc(p.note) + '</p>' : '') +
        '<div class="notice">เมื่อกด "เริ่มสอบ" ระบบจะจับเวลา และเมื่อหมดเวลาจะส่งคำตอบที่บันทึกไว้โดยอัตโนมัติ</div>' +
      '</div>' +
      '<div class="flex-between">' +
        '<button class="btn outline" id="btnBackSel">← กลับหน้าเลือกสอบ</button>' +
        '<button class="btn primary" id="btnStart">เริ่มทำข้อสอบ ▶</button>' +
      '</div>';

    $('#btnBackSel').addEventListener('click', function () { goto('select'); });
    $('#btnStart').addEventListener('click', function () { startExam(); });
  }

  /* ================= 6. หน้าทำข้อสอบ ================= */
  function startExam() {
    buildFlatQuestions();
    S.answers = {};
    S.essayAnswers = {};
    S.listeningPlays = {};
    S.current = 0;
    S.deadline = Date.now() + S.program.time * 60 * 1000;
    S.result = null;
    S.answerKeyGranted = false;
    S.screen = 'exam';
    saveDraft();
    startTimer();
    render();
  }

  function buildFlatQuestions() {
    var flat = [];
    var p = S.program;
    p.subjects.forEach(function (s) {
      if (!s.mcq) return; // ข้ามเฉพาะวิชาที่เป็นข้อเขียนล้วน (ไม่มีปรนัย)
      var bank = (DIDO.QUESTIONS || {})[s.key] || [];
      for (var i = 0; i < s.mcq; i++) {
        var q = bank[i] || { q: '(ข้อสอบยังไม่พร้อม: ข้อ ' + (i + 1) + ')', opts: ['—', '—', '—', '—'], ans: 0, exp: '' };
        var rawOpts = q.o || q.opts || [];
        var rawAns = (q.a !== undefined ? q.a : q.ans) || 0;
        var so = shuffleOpts(q.q, rawOpts, rawAns);
        flat.push({
          gi: flat.length,
          subjectKey: s.key,
          subjectName: s.name,
          lang: s.lang,
          parts: !!s.parts,
          num: i + 1,
          subjTotal: s.mcq,
          q: q.q,
          opts: so.opts,
          ans: so.ans,
          exp: q.e || q.exp || '',
          part: q.p || q.part || null,
          listen: q.l || q.listen || null,
        });
      }
    });
    S.flat = flat;
  }

  function startTimer() {
    clearInterval(S.timerId);
    S.timerId = setInterval(function () {
      var remain = S.deadline - Date.now();
      if (S.screen === 'exam') {
        if (remain <= 0) {
          clearInterval(S.timerId);
          autoSubmit();
          return;
        }
        var el = $('#timerText'); if (el) el.textContent = fmtTime(remain);
        var bar = $('#timerText');
        if (bar) {
          bar.classList.toggle('warn', remain < 5 * 60 * 1000 && remain >= 60 * 1000);
          bar.classList.toggle('critical', remain < 60 * 1000);
        }
        var ac = $('#answeredCount');
        if (ac) ac.textContent = 'ตอบแล้ว ' + Object.keys(S.answers).length + ' / ' + S.flat.length + ' ข้อ';
        saveDraft();
      }
    }, 1000);
  }

  function renderTimerBar() {
    var remain = S.deadline - Date.now();
    $('#timerText').textContent = fmtTime(remain);
    var answered = Object.keys(S.answers).length;
    $('#answeredCount').textContent = 'ตอบแล้ว ' + answered + ' / ' + S.flat.length + ' ข้อ';
    var bar = $('#timerText');
    bar.classList.toggle('warn', remain < 5 * 60 * 1000 && remain >= 60 * 1000);
    bar.classList.toggle('critical', remain < 60 * 1000);
  }

  function renderExam(app) {
    var p = S.program;
    var q = S.flat[S.current];
    var hasEssay = p.subjects.some(function (s) { return s.essay; });

    // subject tabs (แสดงจำนวนข้อต่อวิชา)
    var tabs = '';
    var firstIndexPerSubject = {};
    S.flat.forEach(function (f) { if (!(f.subjectKey in firstIndexPerSubject)) firstIndexPerSubject[f.subjectKey] = f.gi; });
    p.subjects.forEach(function (s) {
      if (!s.mcq) return;
      var active = q.subjectKey === s.key ? ' active' : '';
      tabs += '<button class="subject-tab' + active + '" data-gi="' + firstIndexPerSubject[s.key] + '">' + esc(s.name) + ' (' + s.mcq + ' ข้อ)</button>';
    });

    var partLabel = (q.parts && q.part) ? '<div class="q-subject">พาร์ท: ' + esc(q.part) + '</div>' : '';
    var listenBlock = q.listen ? renderListenButton(q) : '';

    var optionsHtml = (q.opts || []).map(function (opt, i) {
      var sel = S.answers[q.gi] === i ? ' selected' : '';
      return '<div class="option' + sel + '" data-opt="' + i + '">' +
        '<span class="key">' + 'ABCD'[i] + '.</span>' +
        '<span class="txt">' + esc(opt) + '</span></div>';
    }).join('');

    app.innerHTML =
      '<div class="exam-layout">' +
        '<div>' +
          '<div class="subject-tabs">' + tabs + '</div>' +
          '<div class="question-box">' +
            '<div class="q-num">วิชา ' + esc(q.subjectName) + ' (' + q.subjTotal + ' ข้อ) · ข้อ ' + q.num + ' / ' + q.subjTotal + '</div>' +
            '<div class="muted" style="font-size:.85rem">รวมทุกวิชา: ข้อที่ ' + (S.current + 1) + ' จากทั้งหมด ' + S.flat.length + ' ข้อ</div>' +
            partLabel +
            '<div class="q-text">' + esc(q.q) + '</div>' +
            listenBlock +
            '<div id="options">' + optionsHtml + '</div>' +
            '<div class="flex-between mt-2">' +
              '<button class="btn outline small" id="btnPrev" ' + (S.current===0?'disabled':'') + '>← ก่อนหน้า</button>' +
              '<button class="btn small gold" id="btnNext">ถัดไป →</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="card">' +
            '<h3>นำทางข้อสอบ</h3>' +
            '<div class="palette" id="palette">' + paletteHtml() + '</div>' +
            '<p class="muted mt-2">🟫 = ตอบแล้ว · ⬜ = ยังไม่ตอบ</p>' +
          '</div>' +
          (hasEssay ? '<div class="card"><h3>ข้อเขียน</h3><p class="muted">ข้อเขียนจะอยู่ในส่วนตรวจทานก่อนส่ง</p></div>' : '') +
          '<div class="card">' +
            '<button class="btn primary block" id="btnToReview">ตรวจทานคำตอบ / ส่งข้อสอบ</button>' +
            '<button class="btn outline block mt-2" id="btnExitExam">ออกจากการสอบ (ไม่ส่งข้อสอบ)</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    // options click
    document.querySelectorAll('#options .option').forEach(function (el) {
      el.addEventListener('click', function () {
        S.answers[q.gi] = parseInt(el.getAttribute('data-opt'), 10);
        saveDraft();
        renderExam(app); // re-render to update selection
      });
    });
    // palette
    document.querySelectorAll('#palette .cell').forEach(function (el) {
      el.addEventListener('click', function () {
        S.current = parseInt(el.getAttribute('data-gi'), 10);
        renderExam(app);
      });
    });
    // tabs
    document.querySelectorAll('.subject-tab').forEach(function (el) {
      el.addEventListener('click', function () {
        S.current = parseInt(el.getAttribute('data-gi'), 10);
        renderExam(app);
      });
    });
    $('#btnPrev').addEventListener('click', function () { if (S.current > 0) { S.current--; renderExam(app); } });
    $('#btnNext').addEventListener('click', function () { if (S.current < S.flat.length - 1) { S.current++; renderExam(app); } });
    $('#btnToReview').addEventListener('click', function () { goto('review'); });
    $('#btnExitExam').addEventListener('click', function () {
      if (confirm('ต้องการออกจากการสอบนี้โดยไม่ส่งข้อสอบใช่หรือไม่? (คำตอบที่ทำไว้จะไม่ถูกบันทึก)')) {
        abandonExam();
      }
    });
    if (q.listen) bindListenButton(q);
  }

  function abandonExam() {
    clearInterval(S.timerId);
    localStorage.removeItem(DRAFT_KEY);
    S.screen = 'select';
    S.program = null;
    S.flat = [];
    S.answers = {};
    S.essayAnswers = {};
    S.listeningPlays = {};
    S.current = 0;
    S.deadline = null;
    S.result = null;
    render();
  }

  function paletteHtml() {
    var html = '';
    var curSubj = null;
    S.flat.forEach(function (f) {
      if (f.subjectName !== curSubj) {
        curSubj = f.subjectName;
        html += '<div class="palette-subject">' + esc(f.subjectName) + ' (' + f.subjTotal + ' ข้อ)</div>';
      }
      var cls = 'cell';
      if (S.answers[f.gi] !== undefined) cls += ' answered';
      if (f.gi === S.current) cls += ' current';
      html += '<div class="' + cls + '" data-gi="' + f.gi + '">' + f.num + '</div>';
    });
    return html;
  }

  /* ----- Listening (TTS, เล่นได้ไม่เกิน 2 ครั้ง) ----- */
  function renderListenButton(q) {
    var plays = S.listeningPlays[q.gi] || 0;
    var disabled = plays >= 2;
    return '<div class="notice">' +
      '<strong>🎧 Listening</strong> — ฟังเสียงแล้วเลือกคำตอบ (เล่นได้ไม่เกิน 2 ครั้ง · เล่นไปแล้ว ' + plays + '/2)' +
      '<div class="mt-2"><button class="btn gold small" id="btnListen" ' + (disabled ? 'disabled' : '') + '>' +
      (plays >= 2 ? 'เล่นครบ 2 ครั้งแล้ว' : '▶ เล่นเสียง (' + (plays + 1) + '/2)') + '</button></div>' +
      '</div>';
  }
  function bindListenButton(q) {
    var btn = $('#btnListen');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var plays = S.listeningPlays[q.gi] || 0;
      if (plays >= 2) return;
      S.listeningPlays[q.gi] = plays + 1;
      speak(q.listen, q.lang);
      renderExam($('#app'));
    });
  }
  function speak(text, lang) {
    if (!('speechSynthesis' in window)) { alert('เบราว์เซอร์นี้ไม่รองรับการเล่นเสียง (Web Speech API)'); return; }
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    var map = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', th: 'th-TH' };
    u.lang = map[lang] || 'en-US';
    u.rate = 0.92;
    window.speechSynthesis.speak(u);
  }

  /* ================= 7. ตรวจทาน + ส่ง ================= */
  function renderReview(app) {
    var p = S.program;
    var answered = Object.keys(S.answers).length;
    var rows = '';
    var currentSubject = null;
    S.flat.forEach(function (f) {
      if (f.subjectName !== currentSubject) {
        currentSubject = f.subjectName;
        rows += '<tr><td colspan="3" style="background:#f3ece6;font-weight:700">' + esc(f.subjectName) + '</td></tr>';
      }
      var st = S.answers[f.gi] !== undefined ? 'ตอบแล้ว' : 'ยังไม่ตอบ';
      rows += '<tr><td>' + (f.gi + 1) + '</td><td class="' + (S.answers[f.gi] !== undefined ? '' : 'muted') + '">' + st + '</td>' +
        '<td><button class="btn small outline" data-gi="' + f.gi + '">ไปข้อนี้</button></td></tr>';
    });

    // essays
    var essayHtml = '';
    p.subjects.forEach(function (s) {
      if (!s.essay) return;
      var e = DIDO.ESSAYS[s.key];
      if (!e) return;
      essayHtml += '<div class="field"><label>' + esc(e.title) + ' (' + e.maxScore + ' คะแนน)</label>' +
        '<p class="muted" style="white-space:pre-wrap">' + esc(e.prompt) + '</p>' +
        '<textarea id="essay_' + esc(s.key.replace(/[^a-zA-Z0-9]/g,'_')) + '" rows="6" placeholder="พิมพ์คำตอบข้อเขียนที่นี่">' +
        esc(S.essayAnswers[s.key] || '') + '</textarea></div>';
    });

    app.innerHTML =
      '<div class="card">' +
        '<h2>ตรวจทานคำตอบก่อนส่ง</h2>' +
        '<p>ตอบแล้ว <strong>' + answered + '</strong> / ' + S.flat.length + ' ข้อ · ยังไม่ตอบ <strong>' + (S.flat.length - answered) + '</strong> ข้อ</p>' +
        '<div class="notice warn">ยังไม่มีการเปิดเผยเฉลยหรือคะแนน — คุณยังสามารถย้อนกลับไปแก้ไขคำตอบได้จนกว่าจะส่งข้อสอบหรือหมดเวลา</div>' +
      '</div>';

    if (essayHtml) {
      app.innerHTML += '<div class="card"><h2>ข้อเขียน (Essay)</h2>' + essayHtml + '</div>';
    }

    app.innerHTML +=
      '<div class="card"><h2>รายการข้อสอบ</h2><div style="max-height:420px;overflow:auto">' +
      '<table class="table"><thead><tr><th style="width:70px">ข้อ</th><th>สถานะ</th><th style="width:110px"></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
      '<div class="flex-between">' +
        '<button class="btn outline" id="btnBackExam">← กลับไปแก้ไขข้อสอบ</button>' +
        '<button class="btn danger" id="btnSubmit">ส่งข้อสอบ</button>' +
      '</div>';

    document.querySelectorAll('button[data-gi]').forEach(function (el) {
      el.addEventListener('click', function () { S.current = parseInt(el.getAttribute('data-gi'), 10); goto('exam'); });
    });
    $('#btnBackExam').addEventListener('click', function () { goto('exam'); });
    $('#btnSubmit').addEventListener('click', function () {
      p.subjects.forEach(function (s) {
        if (!s.essay) return;
        var el = document.getElementById('essay_' + s.key.replace(/[^a-zA-Z0-9]/g,'_'));
        if (el) S.essayAnswers[s.key] = el.value;
      });
      submitExam();
    });
  }

  /* ================= ส่งข้อสอบ + ตรวจ ================= */
  function submitExam(auto) {
    clearInterval(S.timerId);
    S.result = scoreExam();
    var rec = buildRecord();
    var list = loadRecords();
    list.push(rec);
    saveRecords(list);
    syncRecordToServer(rec); // บันทึกไปยังเซิร์ฟเวอร์กลาง (ออนไลน์)
    localStorage.removeItem(DRAFT_KEY);
    S.screen = 'result';
    render();
  }
  function autoSubmit() { submitExam(true); }

  function perQuestionScore(subject) {
    if (subject.essay) return { mcqPer: subject.mcq ? (subject.maxScore * (1 - subject.essayWeight)) / subject.mcq : 0, essayMax: subject.maxScore * subject.essayWeight };
    return { mcqPer: subject.maxScore / subject.mcq, essayMax: 0 };
  }

  function scoreExam() {
    var p = S.program;
    var subjectScores = [];
    p.subjects.forEach(function (s) {
      if (s.essay) {
        // essay-only (OIP essay) หรือ essay ประกอบ (DGS)
        var e = DIDO.ESSAYS[s.key];
        var essayMax = s.maxScore * (s.essayWeight === 1 ? 1 : s.essayWeight || 1);
        var mcqPer = s.mcq ? (s.maxScore * (1 - (s.essayWeight || 0))) / s.mcq : 0;
        var correct = 0;
        if (s.mcq) {
          S.flat.forEach(function (f) { if (f.subjectKey === s.key && S.answers[f.gi] === f.ans) correct++; });
        }
        var mcqScore = correct * mcqPer;
        // ตรวจข้อเขียนอัตโนมัติโดยเทียบความเหมือนกับคำตอบต้นแบบ
        var grade = gradeEssay(S.essayAnswers[s.key] || '', e);
        var essay = {
          text: S.essayAnswers[s.key] || '', status: 'graded', score: grade.score,
          maxScore: essayMax, similarity: round2(grade.similarity * 100),
          coverage: round2(grade.coverage * 100), sim: round2(grade.sim * 100),
          hit: grade.hit, totalKeywords: grade.totalKeywords,
        };
        subjectScores.push({
          key: s.key, name: s.name, mcq: s.mcq, correct: correct,
          mcqScore: mcqScore, essay: essay, score: mcqScore + grade.score, maxScore: s.maxScore,
        });
      } else {
        var c2 = 0;
        S.flat.forEach(function (f) { if (f.subjectKey === s.key && S.answers[f.gi] === f.ans) c2++; });
        var per = s.maxScore / s.mcq;
        var sc = c2 * per;
        subjectScores.push({ key: s.key, name: s.name, mcq: s.mcq, correct: c2, mcqScore: sc, essay: null, score: sc, maxScore: s.maxScore });
      }
    });

    var total, totalMax = p.totalScore;
    if (p.compositeType === 'equal-weight') {
      // GEP: 3 วิชาน้ำหนักเท่ากัน ปัดเศษเฉพาะคะแนนรวมสุดท้าย
      var pcts = subjectScores.map(function (s) { return (s.correct / s.mcq) * 100; });
      total = Math.round((pcts[0] + pcts[1] + pcts[2]) / 3);
    } else {
      var sum = 0;
      subjectScores.forEach(function (s) { sum += s.score; });
      total = sum;
    }

    var percent = totalMax ? (total / totalMax) * 100 : 0;
    var evalText = evaluate(percent);

    return { subjectScores: subjectScores, total: round2(total), totalMax: totalMax, percent: round2(percent), evaluation: evalText, composite: p.compositeType };
  }

  function evaluate(percent) {
    var msgs = DIDO.RESULT_MESSAGES;
    for (var i = 0; i < msgs.length; i++) {
      if (percent >= msgs[i].min && percent <= msgs[i].max) return msgs[i].text;
    }
    return msgs[0].text;
  }

  function buildRecord() {
    var p = S.program;
    return {
      id: 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString(),
      firstName: S.user.firstName, lastName: S.user.lastName, school: S.user.school,
      programId: p.id, programCode: p.code, programName: p.name, category: p.category, seats: p.seats,
      answers: S.answers,
      essayAnswers: S.essayAnswers,
      subjectScores: S.result.subjectScores,
      total: S.result.total, totalMax: S.result.totalMax, percent: S.result.percent,
      evaluation: S.result.evaluation,
    };
  }

  /* ================= 8. หน้าผลสอบ ================= */
  function renderResult(app) {
    var r = S.result; var p = S.program;
    var subjRows = r.subjectScores.map(function (s) {
      var essayText = '';
      if (s.essay) {
        essayText = 'ข้อเขียน ' + s.essay.score + '/' + s.essay.maxScore +
          ' <span class="muted">(เหมือนเฉลย ' + s.essay.similarity + '%)</span>';
      }
      return '<tr><td>' + esc(s.name) + '</td><td>' + s.correct + ' / ' + s.mcq + '</td>' +
        '<td>' + round2(s.score) + '</td><td>' + s.maxScore + '</td><td>' + essayText + '</td></tr>';
    }).join('');

    app.innerHTML =
      '<div class="card text-center">' +
        '<h2>ผลการสอบ</h2>' +
        '<p class="muted">' + esc(S.user.firstName) + ' ' + esc(S.user.lastName) + ' · ' + esc(S.user.school) + '</p>' +
        '<p class="lead">' + esc(p.code) + ' — ' + esc(p.name) + '</p>' +
        '<div class="score-big">' + round2(r.total) + ' / ' + r.totalMax + '</div>' +
        '<div class="score-sub">คิดเป็นร้อยละ ' + r.percent + '%</div>' +
      '</div>' +

      '<div class="card">' +
        '<h2>การแปลผลคะแนน</h2>' +
        '<p class="lead">' + esc(r.evaluation) + '</p>' +
        '<p class="muted">' + esc(DIDO.RESULT_DISCLAIMER) + '</p>' +
        '<div class="notice">ข้อเขียน (Essay) ถูกตรวจให้คะแนนอัตโนมัติโดยเทียบความเหมือนกับคำตอบต้นแบบ (ครอบคลุมคำสำคัญ + ความคล้ายของข้อความ)</div>' +
      '</div>' +

      '<div class="card">' +
        '<h2>คะแนนรายวิชา</h2>' +
        '<table class="table"><thead><tr><th>วิชา</th><th>ตอบถูก</th><th>คะแนน</th><th>คะแนนเต็ม</th><th>ข้อเขียน</th></tr></thead>' +
        '<tbody>' + subjRows + '</tbody></table>' +
      '</div>' +

      '<div class="flex-between">' +
        '<button class="btn outline" id="btnHome">กลับหน้าแรก</button>' +
        '<button class="btn gold" id="btnAnswerKey">🔐 เปิดดูเฉลย (ต้องใช้รหัสผ่าน)</button>' +
      '</div>';

    $('#btnHome').addEventListener('click', function () { resetFlow(); goto('register'); });
    $('#btnAnswerKey').addEventListener('click', function () { askAnswerPassword(); });
  }

  function resetFlow() {
    S.user = null; S.program = null; S.flat = []; S.answers = {}; S.essayAnswers = {};
    S.listeningPlays = {}; S.current = 0; S.deadline = null; S.result = null;
    S.answerKeyGranted = false; S.dashboardGranted = false;
  }

  /* ================= 9. เฉลย (รหัสผ่าน dido123) ================= */
  function askAnswerPassword() {
    openModal(
      '<h3>🔐 เปิดดูเฉลย</h3>' +
      '<p class="muted">กรุณากรอกรหัสผ่านเพื่อเปิดดูเฉลยของแผนการเรียนที่เลือกสอบ</p>' +
      '<div class="field"><input id="pwInput" type="password" placeholder="รหัสผ่าน" /></div>' +
      '<div class="error-text" id="pwErr"></div>' +
      '<div class="flex-between"><button class="btn outline" id="pwCancel">ยกเลิก</button>' +
      '<button class="btn primary" id="pwOk">ยืนยัน</button></div>'
    );
    $('#pwCancel').addEventListener('click', closeModal);
    $('#pwOk').addEventListener('click', function () {
      var v = $('#pwInput').value;
      if (v === DIDO.ANSWER_PASSWORD) { closeModal(); S.answerKeyGranted = true; renderAnswerKey(); }
      else $('#pwErr').textContent = '⚠ รหัสผ่านไม่ถูกต้อง';
    });
    $('#pwInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#pwOk').click(); });
  }

  function renderAnswerKey() {
    var p = S.program;
    var flat = S.flat.length ? S.flat : rebuildFlatForAnswerKey();
    var rows = '';
    flat.forEach(function (f) {
      var chosen = S.answers[f.gi];
      var correct = f.ans;
      var isCorrect = chosen === correct;
      var mark = chosen === undefined ? '<span class="muted">ไม่ได้ตอบ</span>'
        : (isCorrect ? '<span class="ans-correct">✔ ถูก</span>' : '<span class="ans-wrong">✘ ผิด</span>');
      var yourAns = chosen === undefined ? '—' : 'ABCD'[chosen];
      rows += '<tr>' +
        '<td>' + (f.gi + 1) + ' (' + esc(f.subjectName) + (f.part ? ' · ' + esc(f.part) : '') + ')</td>' +
        '<td>' + esc(f.q) + (f.listen ? '<div class="muted">🎧 Listening: ' + esc(f.listen) + '</div>' : '') + '</td>' +
        '<td>' + esc(f.opts[correct]) + '</td>' +
        '<td>' + yourAns + '</td>' +
        '<td>' + mark + '</td>' +
        '<td>' + esc(f.exp || '—') + '</td>' +
      '</tr>';
    });

    var essayRows = '';
    p.subjects.forEach(function (s) {
      if (!s.essay) return;
      var e = DIDO.ESSAYS[s.key];
      var g = S.result ? S.result.subjectScores.filter(function (x) { return x.key === s.key; })[0] : null;
      var scoreInfo = '';
      if (g && g.essay) {
        scoreInfo = '<div class="mt-2">คะแนนข้อเขียนของคุณ: <strong>' + g.essay.score + '/' + g.essay.maxScore +
          '</strong> · ความเหมือนกับเฉลย ' + g.essay.similarity + '% ' +
          '(คำสำคัญที่พบ ' + g.essay.hit + '/' + g.essay.totalKeywords + ' · ความคล้ายข้อความ ' + g.essay.sim + '%)</div>';
      }
      essayRows += '<tr><td colspan="2"><strong>' + esc(e.title) + '</strong><br>' +
        '<div class="muted" style="white-space:pre-wrap">' + esc(e.prompt) + '</div>' +
        '<div class="mt-2"><strong>คำตอบต้นแบบ (เฉลย):</strong><div style="white-space:pre-wrap">' + esc(e.answer || '') + '</div></div>' +
        '<div class="muted mt-2">เกณฑ์ตรวจ: ' + esc(e.rubric) + '</div>' +
        scoreInfo + '</td></tr>';
    });

    var app = $('#app');
    app.innerHTML =
      '<div class="card"><h2>🔐 เฉลยข้อสอบ — ' + esc(p.code) + ' (' + esc(p.name) + ')</h2>' +
      '<p class="muted">แสดงคำตอบที่ถูกต้อง คำตอบที่เลือก คะแนนรายข้อ และคำอธิบายเฉลย</p></div>' +
      '<div class="card"><div style="overflow:auto"><table class="table"><thead><tr>' +
      '<th style="min-width:120px">ข้อ</th><th>โจทย์</th><th>คำตอบที่ถูก</th><th>คุณตอบ</th><th>ผล</th><th>เฉลย</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
      (essayRows ? '<div class="card"><h2>เฉลยข้อเขียน (เกณฑ์ตรวจ)</h2><table class="table"><tbody>' + essayRows + '</tbody></table></div>' : '') +
      '<div class="flex-between"><button class="btn outline" id="btnBackResult">← กลับหน้าผลสอบ</button></div>';
    $('#btnBackResult').addEventListener('click', function () { goto('result'); });
  }

  function rebuildFlatForAnswerKey() {
    // ถ้า S.flat ว่าง (เช่น หลัง refresh) ให้สร้างใหม่จาก program
    var saved = S.program; var tmp = S.flat; S.flat = [];
    buildFlatQuestions(); var f = S.flat; S.flat = tmp;
    return f;
  }

  /* ================= 10. แดชบอร์ด (รหัสผ่าน 456461) ================= */
  function askDashboardPassword() {
    openModal(
      '<h3>🔐 แดชบอร์ดรายชื่อและคะแนน</h3>' +
      '<p class="muted">ส่วนนี้แสดงข้อมูลส่วนบุคคล ต้องใช้รหัสผ่าน (ตรวจสอบสิทธิ์)</p>' +
      '<div class="field"><input id="pwInput" type="password" placeholder="รหัสผ่าน" /></div>' +
      '<div class="error-text" id="pwErr"></div>' +
      '<div class="flex-between"><button class="btn outline" id="pwCancel">ยกเลิก</button>' +
      '<button class="btn primary" id="pwOk">ยืนยัน</button></div>'
    );
    $('#pwCancel').addEventListener('click', closeModal);
    $('#pwOk').addEventListener('click', function () {
      var v = $('#pwInput').value;
      if (v === DIDO.DASHBOARD_PASSWORD) { closeModal(); S.dashboardGranted = true; goto('dashboard'); }
      else $('#pwErr').textContent = '⚠ รหัสผ่านไม่ถูกต้อง';
    });
    $('#pwInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#pwOk').click(); });
  }

  function renderDashboard(app) {
    var records = loadRecords();
    var programs = DIDO.PROGRAMS;
    var sel = '<select id="progSel" style="padding:9px 12px;border-radius:8px;border:1.5px solid #d7ccc8;font-size:1rem">' +
      programs.map(function (p) {
        return '<option value="' + p.id + '">' + esc(p.code) + ' — ' + esc(p.name) + '</option>';
      }).join('') + '</select>';

    app.innerHTML =
      '<div class="card"><h2>🔐 แดชบอร์ดรายชื่อ คะแนน และสถิติ</h2>' +
      '<p class="muted">เฉพาะผู้ที่ผ่านการกรอกรหัสผ่าน · ข้อมูลถูกบันทึกในเครื่องนี้ (localStorage) ' +
      '— ยังไม่มีฐานข้อมูลส่วนกลาง/เซิร์ฟเวอร์ร่วมระหว่างเครื่อง</p>' +
      '<div class="flex-between"><div><label class="muted">แผนการเรียน : </label>' + sel + '</div>' +
      '<button class="btn outline small" id="btnExport">⬇ ส่งออกข้อมูล (JSON)</button>' +
      '<button class="btn outline small" id="btnBackSel2">← กลับหน้าเลือกสอบ</button></div></div>' +
      '<div id="dashBody"></div>';

    function draw() {
      var pid = $('#progSel').value;
      renderDashboardBody(pid, records);
    }
    $('#progSel').addEventListener('change', draw);
    $('#btnExport').addEventListener('click', exportRecords);
    $('#btnBackSel2').addEventListener('click', function () { goto('select'); });
    draw();
  }

  function renderDashboardBody(pid, records) {
    var p = findProgram(pid);
    var body = $('#dashBody');
    if (!p) { body.innerHTML = '<p class="muted">ไม่พบแผนการเรียน</p>'; return; }

    var recs = records.filter(function (r) { return r.programId === pid; }).sort(function (a, b) { return b.total - a.total; });

    if (!recs.length) {
      body.innerHTML = '<div class="card text-center"><p class="muted">ยังไม่มีผู้เข้าสอบในแผนการเรียนนี้</p></div>';
      return;
    }

    var totals = recs.map(function (r) { return r.total; });
    var n = totals.length;
    var sum = totals.reduce(function (a, b) { return a + b; }, 0);
    var mean = sum / n;
    var sorted = totals.slice().sort(function (a, b) { return a - b; });
    var median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    var max = sorted[n - 1], min = sorted[0];

    // การแจกแจงคะแนนเป็นช่วง
    var buckets = { '0-60%': 0, '61-70%': 0, '71-80%': 0, '81-90%': 0, '91-99%': 0, '100%': 0 };
    recs.forEach(function (r) {
      var pc = r.percent;
      if (pc <= 60) buckets['0-60%']++;
      else if (pc <= 70) buckets['61-70%']++;
      else if (pc <= 80) buckets['71-80%']++;
      else if (pc <= 90) buckets['81-90%']++;
      else if (pc <= 99) buckets['91-99%']++;
      else buckets['100%']++;
    });
    var distRows = Object.keys(buckets).map(function (k) {
      return '<tr><td>' + k + '</td><td>' + buckets[k] + ' คน</td></tr>';
    }).join('');

    // รายชื่อ + คะแนน
    var listRows = recs.map(function (r, i) {
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(r.firstName) + ' ' + esc(r.lastName) + '</td>' +
        '<td>' + esc(r.school) + '</td><td>' + r.total + ' / ' + r.totalMax + '</td><td>' + r.percent + '%</td>' +
        '<td class="muted">' + new Date(r.ts).toLocaleString('th-TH') + '</td></tr>';
    }).join('');

    // สรุปเปรียบเทียบคะแนนระหว่างวิชา
    var subjAgg = {};
    recs.forEach(function (r) {
      (r.subjectScores || []).forEach(function (s) {
        if (!subjAgg[s.key]) subjAgg[s.key] = { name: s.name, maxScore: s.maxScore, scores: [], corrects: [], mcq: s.mcq };
        subjAgg[s.key].scores.push(s.score);
        subjAgg[s.key].corrects.push(s.correct);
      });
    });
    var subjRows = Object.keys(subjAgg).map(function (k) {
      var a = subjAgg[k];
      var ss = a.scores; var cs = a.corrects;
      var m = ss.reduce(function (x, y) { return x + y; }, 0) / ss.length;
      var cm = cs.reduce(function (x, y) { return x + y; }, 0) / cs.length;
      return '<tr><td>' + esc(a.name) + '</td><td>' + round2(cm) + ' / ' + a.mcq + '</td>' +
        '<td>' + round2(m) + '</td><td>' + a.maxScore + '</td><td>' + round2((m / a.maxScore) * 100) + '%</td></tr>';
    }).join('');

    var competition = n + ' / ' + p.seats + ' คน (' + round2((n / p.seats) * 100) + '% ของที่นั่ง)';

    body.innerHTML =
      '<div class="card"><h3>ภาพรวม — ' + esc(p.code) + ' (' + esc(p.name) + ')</h3>' +
      '<div class="stat-grid">' +
        '<div class="stat-box"><div class="v">' + n + '</div><div class="l">จำนวนผู้เข้าสอบ</div></div>' +
        '<div class="stat-box"><div class="v">' + round2(mean) + '</div><div class="l">คะแนนเฉลี่ย</div></div>' +
        '<div class="stat-box"><div class="v">' + round2(median) + '</div><div class="l">มัธยฐาน</div></div>' +
        '<div class="stat-box"><div class="v">' + round2(max) + '</div><div class="l">สูงสุด</div></div>' +
        '<div class="stat-box"><div class="v">' + round2(min) + '</div><div class="l">ต่ำสุด</div></div>' +
        '<div class="stat-box"><div class="v">' + competition + '</div><div class="l">อัตราการแข่งขัน (ผู้สอบ/ที่นั่ง)</div></div>' +
      '</div></div>' +

      '<div class="card"><h3>รายชื่อผู้เข้าสอบ (เรียงคะแนนจากมากไปน้อย)</h3>' +
      '<div style="overflow:auto"><table class="table"><thead><tr><th>อันดับ</th><th>ชื่อ-นามสกุล</th><th>โรงเรียนเดิม</th><th>คะแนน</th><th>ร้อยละ</th><th>ส่งเมื่อ</th></tr></thead>' +
      '<tbody>' + listRows + '</tbody></table></div></div>' +

      '<div class="card"><h3>การแจกแจงคะแนนเป็นช่วง</h3><table class="table"><tbody>' + distRows + '</tbody></table></div>' +

      '<div class="card"><h3>สรุปเปรียบเทียบคะแนนระหว่างวิชา</h3>' +
      '<table class="table"><thead><tr><th>วิชา</th><th>ตอบถูกเฉลี่ย</th><th>คะแนนเฉลี่ย</th><th>คะแนนเต็ม</th><th>ร้อยละเฉลี่ย</th></tr></thead>' +
      '<tbody>' + subjRows + '</tbody></table></div>';
  }

  function exportRecords() {
    var data = JSON.stringify(loadRecords(), null, 2);
    var blob = new Blob([data], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dido_exam_records.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ================= Modal ================= */
  function openModal(html) {
    $('#modalBox').innerHTML = html;
    $('#modalBackdrop').classList.remove('hidden');
  }
  function closeModal() { $('#modalBackdrop').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
  $('#modalBackdrop').addEventListener('click', function (e) { if (e.target === this) closeModal(); });

  /* ================= Draft (บันทึกชั่วคราวระหว่างสอบ) ================= */
  function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) { return null; } }
  function saveDraft() {
    if (S.screen !== 'exam' || !S.program) return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      programId: S.program.id, answers: S.answers, essayAnswers: S.essayAnswers,
      listeningPlays: S.listeningPlays, current: S.current, deadline: S.deadline,
      user: S.user,
    }));
  }
  function isDraftExpired(d) { return d.deadline && Date.now() > d.deadline + 60 * 1000; }
  function resumeDraft(draft, p) {
    S.program = p; S.user = draft.user || S.user;
    buildFlatQuestions();
    S.answers = draft.answers || {}; S.essayAnswers = draft.essayAnswers || {};
    S.listeningPlays = draft.listeningPlays || {};
    S.current = draft.current || 0;
    S.deadline = draft.deadline || (Date.now() + p.time * 60 * 1000);
    S.result = null; S.answerKeyGranted = false;
    S.screen = 'exam';
    startTimer();
    render();
  }

  /* ================= Boot ================= */
  function boot() {
    injectLogo();
    // ตรวจสอบความครบของธนาคารข้อสอบ
    var issues = bankIssues();
    if (issues.length) {
      console.warn('[DIDO] ปัญหาธนาคารข้อสอบ:', issues);
    }
    // ปุ่มตรวจทานที่แถบจับเวลา (แสดงเฉพาะระหว่างสอบ)
    var topReview = document.getElementById('btnReviewTop');
    if (topReview) {
      topReview.addEventListener('click', function () {
        if (S.screen === 'exam') goto('review');
      });
    }
    render();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
