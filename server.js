// Бэкенд генерации для МультСтудии:
//  1) /upload-ref  — принимает фото персонажа, отдаёт публичный URL (для kontext-референса)
//  2) /generate    — проксирует Pollinations (flux / kontext) с ретраями,
//                    отдаёт картинку тем же источником (canvas-safe, без CORS-проблем).
// Node 18+: fetch встроен. Ключ Pollinations (POLLINATIONS_KEY) — необязателен,
// с ним лимит меньше и без вотермарки (бесплатная регистрация на auth.pollinations.ai).

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = process.env.POLLINATIONS_KEY || '';
const REFDIR = path.join(os.tmpdir(), 'refs');
fs.mkdirSync(REFDIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '4mb' }));
const upload = multer({ dest: REFDIR, limits: { fileSize: 12 * 1024 * 1024 } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => res.json({ ok: true, service: 'cartoon-gen-backend', key: KEY ? 'set' : 'anonymous' }));

// раздаём загруженные фото-референсы
app.use('/ref', express.static(REFDIR));

function publicBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return proto + '://' + req.headers['host'];
}

// загрузка фото персонажа -> публичный URL
app.post('/upload-ref', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no image' });
  const ext = (req.file.mimetype || '').includes('png') ? '.png'
            : (req.file.mimetype || '').includes('webp') ? '.webp' : '.jpg';
  const newName = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(REFDIR, newName));
  res.json({ url: publicBase(req) + '/ref/' + newName });
});

// генерация картинки (flux или kontext по референсу)
app.post('/generate', async (req, res) => {
  try {
    const { prompt, seed, model, ref, width, height } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'no prompt' });
    let url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?nologo=true&seed=' + (seed || 0);
    if (model === 'kontext' && ref) {
      url += '&model=kontext&image=' + encodeURIComponent(ref);
    } else {
      url += '&model=flux&width=' + (width || 768) + '&height=' + (height || 768);
    }
    if (KEY) url += '&token=' + encodeURIComponent(KEY);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, KEY ? { headers: { Authorization: 'Bearer ' + KEY } } : {});
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
          res.set('Cache-Control', 'no-store');
          return res.send(buf);
        }
        if (r.status === 429) await sleep(KEY ? 5500 : 15500); // уважаем лимит
        else await sleep(1500);
      } catch (e) { await sleep(1500); }
    }
    res.status(502).json({ error: 'generation failed after retries' });
  } catch (e) {
    console.error('generate error:', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// image-to-video: оживляем кадр (нужен POLLINATIONS_KEY с Pollen-кредитами)
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'seedance';
app.post('/animate', async (req, res) => {
  try {
    if (!KEY) return res.status(400).json({ error: 'Для видео нужен POLLINATIONS_KEY' });
    const { frameUrl, prompt, duration, aspectRatio, model } = req.body || {};
    const mdl = model || VIDEO_MODEL;
    const dur = Math.min(Math.max(parseInt(duration) || 5, 2), 8);
    const ar = aspectRatio || '16:9';
    let url = 'https://gen.pollinations.ai/image/' +
      encodeURIComponent(prompt || 'the character comes to life, subtle natural motion, animated') +
      '?model=' + encodeURIComponent(mdl) + '&duration=' + dur + '&aspectRatio=' + encodeURIComponent(ar);
    if (frameUrl) url += '&image=' + encodeURIComponent(frameUrl);

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 240000);
    let r;
    try { r = await fetch(url, { headers: { Authorization: 'Bearer ' + KEY }, signal: ctrl.signal }); }
    finally { clearTimeout(to); }

    const ct = (r.headers.get('content-type') || '');
    if (!r.ok) { const tx = await r.text().catch(() => ''); return res.status(502).json({ error: 'video ' + r.status, detail: tx.slice(0, 400) }); }

    if (ct.includes('video') || ct.includes('octet-stream') || ct.includes('mp4')) {
      const buf = Buffer.from(await r.arrayBuffer());
      res.set('Content-Type', 'video/mp4'); res.set('Cache-Control', 'no-store');
      return res.send(buf);
    }
    // иначе — вероятно JSON/текст со ссылкой на видео
    const txt = await r.text();
    let vurl = '';
    try { const j = JSON.parse(txt); vurl = j.url || (j.data && j.data[0] && (j.data[0].url || j.data[0].video)) || j.output || ''; }
    catch (e) { if (/^https?:\/\/\S+$/.test(txt.trim())) vurl = txt.trim(); }
    if (!vurl) return res.status(502).json({ error: 'нет ссылки на видео', detail: txt.slice(0, 400) });
    const vr = await fetch(vurl);
    const buf = Buffer.from(await vr.arrayBuffer());
    res.set('Content-Type', vr.headers.get('content-type') || 'video/mp4'); res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    console.error('animate error:', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('cartoon-gen-backend on :' + PORT));
