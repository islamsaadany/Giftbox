const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');

const PUBLIC = path.join(__dirname, '..', 'public');
const COOKIE = 'wb_admin';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SLUG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)
const MAX_PHOTO_BYTES = 700 * 1024;

const sha = s => crypto.createHash('sha256').update(s).digest();
const newSlug = () => Array.from({ length: 8 }, () => SLUG_CHARS[crypto.randomInt(SLUG_CHARS.length)]).join('');

class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.body = { error: code, ...extra }; }
}
const bad = (code, extra) => new HttpError(400, code, extra);

/* Small in-memory limiter: at most `max` hits per `windowMs` for each key. */
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return {
    over(key) { const v = hits.get(key); return !!v && v.reset > Date.now() && v.n >= max; },
    hit(key) {
      const now = Date.now(); let v = hits.get(key);
      if (!v || v.reset < now) { v = { n: 0, reset: now + windowMs }; hits.set(key, v); }
      v.n++;
    },
    clear(key) { hits.delete(key); },
  };
}

function createApp({ dataDir, adminPassword, trustProxy = 1 }) {
  if (!adminPassword) throw new Error('adminPassword is required');
  const db = openDb(dataDir);
  const photoDir = path.join(dataDir, 'photos');
  const app = express();
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // Shops must not learn the list link when a guest follows "Shop"
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '1500kb' }));

  /* ---------- helpers ---------- */
  const q = sql => db.prepare(sql);
  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const text = (v, max, code, required) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (required && !s) throw bad(code);
    if (s.length > max) throw bad(code);
    return s;
  };
  const idParam = v => { if (!/^\d{1,15}$/.test(v)) throw new HttpError(404, 'not_found'); return Number(v); };

  function savePhoto(dataUrl) {
    const m = typeof dataUrl === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
    if (!m) throw bad('bad_photo');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > MAX_PHOTO_BYTES) throw bad('photo_too_big');
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw bad('bad_photo');
    const name = crypto.randomBytes(12).toString('hex') + '.jpg';
    fs.writeFileSync(path.join(photoDir, name), buf);
    return name;
  }
  const dropPhoto = name => { if (name && /^[a-f0-9]+\.jpg$/.test(name)) fs.rmSync(path.join(photoDir, name), { force: true }); };
  const photoUrl = name => (name ? '/photos/' + name : null);

  function itemFields(b, { partial }) {
    const out = {};
    if (!partial || b.name !== undefined) out.name = text(b.name, 80, 'bad_name', true);
    if (!partial || b.price !== undefined) {
      if (b.price === null || b.price === undefined || b.price === '') out.price_egp = null;
      else {
        const p = Number(b.price);
        if (!Number.isFinite(p) || p < 0 || p > 1e9) throw bad('bad_price');
        out.price_egp = p;
      }
    }
    if (!partial || b.qty !== undefined) {
      const n = b.qty === undefined ? 1 : Number(b.qty);
      if (!Number.isInteger(n) || n < 1 || n > 999) throw bad('bad_qty');
      out.quantity = n;
    }
    if (!partial || b.link !== undefined) {
      const link = text(b.link, 2000, 'bad_link');
      if (link) {
        let u; try { u = new URL(link); } catch { throw bad('bad_link'); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('bad_link');
      }
      out.shop_url = link || null;
    }
    return out;
  }

  /* ---------- admin session ---------- */
  const pwHash = sha(adminPassword);
  const loginLimit = limiter(10, 15 * 60 * 1000);
  const reserveLimit = limiter(40, 60 * 60 * 1000);

  const cookieToken = req => {
    const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})').exec(req.headers.cookie || '');
    return m && m[1];
  };
  const isAdmin = req => {
    const t = cookieToken(req);
    if (!t) return false;
    return !!q('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha(t).toString('hex'), Date.now());
  };
  const setCookie = (req, res, value, maxAgeS) =>
    res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${req.secure ? '; Secure' : ''}`);

  app.post('/api/admin/login', (req, res) => {
    if (loginLimit.over(req.ip)) throw new HttpError(429, 'too_many_attempts');
    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!crypto.timingSafeEqual(sha(given), pwHash)) {
      loginLimit.hit(req.ip);
      throw new HttpError(401, 'wrong_password');
    }
    loginLimit.clear(req.ip);
    q('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    q('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(sha(token).toString('hex'), Date.now() + SESSION_MS);
    setCookie(req, res, token, SESSION_MS / 1000);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    const t = cookieToken(req);
    if (t) q('DELETE FROM sessions WHERE token_hash = ?').run(sha(t).toString('hex'));
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  const admin = express.Router();
  admin.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!isAdmin(req)) throw new HttpError(401, 'not_signed_in');
    next();
  });

  admin.get('/lists', (req, res) => {
    const lists = q('SELECT id, slug, name, note FROM lists ORDER BY created_at, id').all();
    const items = q('SELECT id, list_id, name, price_egp, quantity, shop_url, photo FROM items ORDER BY id DESC').all();
    const resv = q('SELECT id, item_id, guest_name, guest_mobile, count, created_at FROM reservations ORDER BY created_at, id').all();
    const byItem = new Map();
    for (const r of resv) {
      if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
      byItem.get(r.item_id).push({ id: r.id, name: r.guest_name, mobile: r.guest_mobile, count: r.count, at: r.created_at });
    }
    res.json({
      lists: lists.map(l => ({
        ...l,
        items: items.filter(i => i.list_id === l.id).map(i => ({
          id: i.id, name: i.name, price: i.price_egp, qty: i.quantity, link: i.shop_url || '', photo: photoUrl(i.photo),
          reservations: byItem.get(i.id) || [],
        })),
      })),
    });
  });

  admin.post('/lists', (req, res) => {
    const name = text(req.body?.name, 60, 'bad_name', true), note = text(req.body?.note, 160, 'bad_note');
    for (let attempt = 0; ; attempt++) {
      try {
        const r = q('INSERT INTO lists (slug, name, note, created_at) VALUES (?, ?, ?, ?)').run(newSlug(), name, note, Date.now());
        return res.status(201).json({ id: Number(r.lastInsertRowid) });
      } catch (e) { if (attempt >= 4 || !/UNIQUE/.test(String(e.message))) throw e; }
    }
  });

  admin.patch('/lists/:id', (req, res) => {
    const name = text(req.body?.name, 60, 'bad_name', true), note = text(req.body?.note, 160, 'bad_note');
    const r = q('UPDATE lists SET name = ?, note = ? WHERE id = ?').run(name, note, idParam(req.params.id));
    if (!r.changes) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });

  admin.delete('/lists/:id', (req, res) => {
    const id = idParam(req.params.id);
    const photos = q('SELECT photo FROM items WHERE list_id = ? AND photo IS NOT NULL').all(id);
    const r = q('DELETE FROM lists WHERE id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'not_found');
    photos.forEach(p => dropPhoto(p.photo));
    res.json({ ok: true });
  });

  admin.post('/lists/:id/items', (req, res) => {
    const listId = idParam(req.params.id);
    if (!q('SELECT 1 FROM lists WHERE id = ?').get(listId)) throw new HttpError(404, 'not_found');
    const f = itemFields(req.body || {}, { partial: false });
    const photo = req.body?.photo ? savePhoto(req.body.photo) : null;
    const r = q('INSERT INTO items (list_id, name, price_egp, quantity, shop_url, photo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(listId, f.name, f.price_egp, f.quantity, f.shop_url, photo, Date.now());
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  // photo: omitted = keep, null = remove, data URL = replace
  admin.patch('/items/:id', (req, res) => {
    const id = idParam(req.params.id), b = req.body || {};
    const f = itemFields(b, { partial: true });
    const newPhoto = typeof b.photo === 'string' ? savePhoto(b.photo) : undefined;
    let oldPhoto;
    try {
      tx(() => {
        const it = q('SELECT photo, (SELECT COALESCE(SUM(count), 0) FROM reservations WHERE item_id = items.id) AS reserved FROM items WHERE id = ?').get(id);
        if (!it) throw new HttpError(404, 'not_found');
        if (f.quantity !== undefined && f.quantity < it.reserved) throw new HttpError(409, 'qty_below_reserved', { reserved: it.reserved });
        if (newPhoto !== undefined || b.photo === null) { f.photo = newPhoto ?? null; oldPhoto = it.photo; }
        const cols = Object.keys(f);
        if (cols.length) q(`UPDATE items SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map(c => f[c]), id);
      });
    } catch (e) { dropPhoto(newPhoto); throw e; }
    dropPhoto(oldPhoto);
    res.json({ ok: true });
  });

  admin.delete('/items/:id', (req, res) => {
    const id = idParam(req.params.id);
    const it = q('SELECT photo FROM items WHERE id = ?').get(id);
    if (!it) throw new HttpError(404, 'not_found');
    q('DELETE FROM items WHERE id = ?').run(id);
    dropPhoto(it.photo);
    res.json({ ok: true });
  });

  admin.delete('/reservations/:id', (req, res) => {
    const r = q('DELETE FROM reservations WHERE id = ?').run(idParam(req.params.id));
    if (!r.changes) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });

  app.get('/api/admin/me', (req, res) => res.set('Cache-Control', 'no-store').json({ admin: isAdmin(req) }));
  app.use('/api/admin', admin);

  /* ---------- guest API: never returns reservations, names or mobiles ---------- */
  const slugOk = s => /^[a-z0-9]{4,16}$/.test(s);

  app.get('/api/l/:slug', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const l = slugOk(req.params.slug) && q('SELECT id, name, note FROM lists WHERE slug = ?').get(req.params.slug);
    if (!l) throw new HttpError(404, 'not_found');
    const items = q(`
      SELECT i.id, i.name, i.price_egp, i.quantity, i.shop_url, i.photo,
             i.quantity - COALESCE((SELECT SUM(count) FROM reservations r WHERE r.item_id = i.id), 0) AS left
      FROM items i WHERE i.list_id = ? ORDER BY i.id DESC`).all(l.id);
    res.json({
      name: l.name, note: l.note,
      total: items.length,
      items: items.filter(i => i.left > 0).map(i => ({
        id: i.id, name: i.name, price: i.price_egp, link: i.shop_url || '', photo: photoUrl(i.photo),
        left: i.left, each: i.quantity > 1,
      })),
    });
  });

  app.post('/api/l/:slug/items/:id/reserve', (req, res) => {
    if (reserveLimit.over(req.ip)) throw new HttpError(429, 'too_many_attempts');
    if (!slugOk(req.params.slug)) throw new HttpError(404, 'not_found');
    const id = idParam(req.params.id);
    const name = text(req.body?.name, 60, 'bad_name', true);
    const mobileRaw = typeof req.body?.mobile === 'string' ? req.body.mobile.trim() : '';
    if (!/^\+?[0-9 ]{8,17}$/.test(mobileRaw)) throw bad('bad_mobile');
    const count = req.body?.count === undefined ? 1 : Number(req.body.count);
    if (!Number.isInteger(count) || count < 1 || count > 999) throw bad('bad_count');

    // Re-check what's left inside the transaction so two guests can't take the same last pieces
    tx(() => {
      const it = q(`
        SELECT i.quantity - COALESCE((SELECT SUM(count) FROM reservations r WHERE r.item_id = i.id), 0) AS left
        FROM items i JOIN lists l ON l.id = i.list_id WHERE i.id = ? AND l.slug = ?`).get(id, req.params.slug);
      if (!it) throw new HttpError(404, 'not_found');
      if (it.left < count) throw new HttpError(409, 'not_enough', { left: Math.max(0, it.left) });
      q('INSERT INTO reservations (item_id, guest_name, guest_mobile, count, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, mobileRaw.replace(/\s+/g, ''), count, Date.now());
    });
    reserveLimit.hit(req.ip);
    res.status(201).json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  /* ---------- pages and files ---------- */
  const page = name => (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, name));
  app.get('/l/:slug', page('guest.html'));
  app.get('/admin', page('admin.html'));
  app.get('/', page('index.html'));
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use('/photos', express.static(photoDir, { index: false, immutable: true, maxAge: '365d', fallthrough: false }));
  app.use(express.static(PUBLIC, { index: false, extensions: false, setHeaders: res => res.set('Cache-Control', 'no-cache') }));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, 'index.html')));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'photo_too_big' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.status === 404 ? 'not_found' : 'bad_request' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
