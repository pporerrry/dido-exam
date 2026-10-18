/* =====================================================================
   เซิร์ฟเวอร์กลางของระบบข้อสอบสอบเข้า ม.4 โรงเรียนดีโด้วิทยาลัย
   - ให้บริการเว็บทำข้อสอบ (index.html) และเว็บเจ้าหน้าที่ (staff.html)
   - เก็บผลสอบ: ถ้ามี DATABASE_URL (เช่น บน Render) → ใช้ PostgreSQL
     ถ้าไม่มี → ใช้ไฟล์ data/records.json (ใช้กับเครื่องตัวเอง)
   - รหัสผ่านแดชบอร์ดตรวจสอบฝั่งเซิร์ฟเวอร์
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const DOMAIN = 'dido-wittayalai-test'; // โดเมนท้องถิ่น (ต้องมี entry ในไฟล์ hosts)
const PORT = process.env.PORT || 80;   // Render จะกำหนด PORT มาให้เอง
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'records.json');
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || '456461';

// --- ฐานข้อมูล PostgreSQL (ใช้เมื่ออยู่บนโฮสต์ เช่น Render) ---
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}
function loadRecordsFile() {
  ensureData();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return []; }
}
function saveRecordsFile(list) {
  ensureData();
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

async function loadRecords() {
  if (pool) {
    const r = await pool.query('SELECT data FROM records ORDER BY created_at ASC');
    return r.rows.map(function (row) { return row.data; });
  }
  return loadRecordsFile();
}

async function addRecord(rec) {
  if (pool) {
    await pool.query('INSERT INTO records (id, data) VALUES ($1, $2)', [rec.id, rec]);
  } else {
    const list = loadRecordsFile();
    list.push(rec);
    saveRecordsFile(list);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  if (rel === '') rel = 'index.html';
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found: ' + rel);
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (req.method === 'POST' && p === '/api/records') {
      const body = await readBody(req);
      let rec;
      try { rec = JSON.parse(body); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      if (!rec || !rec.programId || !rec.firstName) return sendJson(res, 400, { ok: false, error: 'invalid record' });
      rec.id = rec.id || ('rec_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'));
      await addRecord(rec);
      return sendJson(res, 200, { ok: true, id: rec.id });
    }

    if (req.method === 'GET' && (p === '/api/admin/records' || p === '/api/admin/stats')) {
      const pw = u.searchParams.get('pw') || '';
      if (pw !== STAFF_PASSWORD) return sendJson(res, 401, { ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
      const list = await loadRecords();
      return sendJson(res, 200, { ok: true, total: list.length, records: list });
    }

    serveStatic(req, res, p);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

function lanIPs() {
  var ips = [];
  var ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    ifs[name].forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    });
  });
  return ips;
}

function startListen(port) {
  server.once('error', function (err) {
    if (err.code === 'EACCES' && port === 80) {
      console.log('(!) พอร์ต 80 ต้องใช้สิทธิ์ผู้ดูแล (Admin) จึงเปลี่ยนไปใช้พอร์ต 3000 แทน');
      startListen(3000);
    } else {
      console.error('เกิดข้อผิดพลาดในการเปิดเซิร์ฟเวอร์: ' + (err && err.message));
    }
  });
  server.listen(port, function () {
    console.log('==============================================');
    console.log('  ระบบข้อสอบสอบเข้า ม.4 — เซิร์ฟเวอร์ทำงานแล้ว');
    console.log('  เก็บข้อมูล: ' + (pool ? 'PostgreSQL (โฮสต์)' : 'ไฟล์ data/records.json (เครื่องนี้)'));
    console.log('  [เครื่องนี้]   เว็บทำข้อสอบ : http://' + DOMAIN + (port === 80 ? '' : ':' + port) + '/');
    console.log('  [เครื่องนี้]   เว็บเจ้าหน้าที่: http://' + DOMAIN + (port === 80 ? '' : ':' + port) + '/staff.html');
    lanIPs().forEach(function (ip) {
      console.log('  [โทรศัพท์]    เว็บทำข้อสอบ : http://' + ip + (port === 80 ? '' : ':' + port) + '/');
    });
    console.log('  รหัสผ่านเจ้าหน้าที่: ' + STAFF_PASSWORD);
    console.log('==============================================');
  });
}

// ถ้าใช้ PostgreSQL ให้สร้างตารางอัตโนมัติก่อนเปิดให้บริการ
(async function init() {
  if (pool) {
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      console.log('[DB] พร้อมใช้งาน PostgreSQL');
    } catch (e) {
      console.error('[DB] สร้างตารางไม่สำเร็จ: ' + e.message);
    }
  }
  startListen(PORT);
})();
