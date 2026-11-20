const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { Readable } = require('node:stream');

const PUBLIC = path.join(__dirname, '..', 'public');
const COOKIE = 'wb_admin';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SLUG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)
const MAX_PHOTO_BYTES = 700 * 1024;
const LOGIN_MAX = 10, LOGIN_WINDOW_MS = 15 * 60 * 1000;

const sha = s => crypto.createHash('sha256').update(s).digest();
const newSlug = () => Array.from({ length: 8 }, () => SLUG_CHARS[crypto.randomInt(SLUG_CHARS.length)]).join('');

class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.body = { error: code, ...extra }; }
}
const bad = (code, extra) => new HttpError(400, code, extra);

/* Small in-memory limiter: at most `max` hits per `windowMs` for each key (best effort per server instance). */
function limiter(max, windowMs) {
  const hits = new Map();
  return {
    over(key) { const v = hits.get(key); return !!v && v.reset > Date.now() && v.n >= max; },
    hit(key) {
      const now = Date.now();
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      let v = hits.get(key);
      if (!v || v.reset < now) { v = { n: 0, reset: now + windowMs }; hits.set(key, v); }
      v.n++;
    },
  };
}

/* db: from ./db (query/tx/ready). photos: from ./photos (save/remove/url). */
function createApp({ db, photos, admins, trustProxy = 1 }) {
  if (!admins?.length) throw new Error('at least one admin is required');
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
        "default-src 'self'; img-src 'self' data: blob: https://*.public.blob.vercel-storage.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
        "script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '1500kb' }));

  /* ---------- helpers ---------- */
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await rows(sql, params))[0];

  const text = (v, max, code, required) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (required && !s) throw bad(code);
    if (s.length > max) throw bad(code);
    return s;
  };
  const idParam = v => { if (!/^\d{1,9}$/.test(v)) throw new HttpError(404, 'not_found'); return Number(v); };

  async function savePhoto(dataUrl) {
    const m = typeof dataUrl === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
    if (!m) throw bad('bad_photo');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > MAX_PHOTO_BYTES) throw bad('photo_too_big');
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw bad('bad_photo');
    try { return await photos.save(buf); }
    catch (e) {
      // Only admins reach this, so it's safe (and useful) to say what the photo storage answered
      console.error('photo upload failed', e);
      throw new HttpError(502, 'photo_store_failed', { detail: String(e.message || e).slice(0, 300) });
    }
  }
  const dropPhoto = ref => (ref ? photos.remove(ref).catch(e => console.error('photo delete failed', e.message)) : undefined);

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

  // Make sure the tables exist before any API call
  app.use('/api', async (req, res, next) => { await db.ready(); next(); });

  /* ---------- admin session ---------- */
  const accounts = new Map(admins.map(a => [a.name.toLowerCase(), { name: a.name, hash: sha(a.password) }]));
  const noAccount = { hash: crypto.randomBytes(32) };
  const reserveLimit = limiter(40, 60 * 60 * 1000);

  const cookieToken = req => {
    const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})').exec(req.headers.cookie || '');
    return m && m[1];
  };
  // Returns the signed-in admin's name, or null. Removing someone from the admin list ends their sessions.
  const adminOf = async req => {
    const t = cookieToken(req);
    if (!t) return null;
    const s = await one('SELECT admin_name FROM sessions WHERE token_hash = $1 AND expires_at > $2', [sha(t).toString('hex'), Date.now()]);
    return s && accounts.get(String(s.admin_name).toLowerCase())?.name || null;
  };
  const setCookie = (req, res, value, maxAgeS) =>
    res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${req.secure ? '; Secure' : ''}`);

  app.post('/api/admin/login', async (req, res) => {
    const ip = String(req.ip || 'unknown'), now = Date.now();
    // Failed tries are counted in the database so the limit holds across server instances
    const f = await one('SELECT COUNT(*)::int AS n FROM login_failures WHERE ip = $1 AND at > $2', [ip, now - LOGIN_WINDOW_MS]);
    if (f.n >= LOGIN_MAX) throw new HttpError(429, 'too_many_attempts');
    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    const who = accounts.get(typeof req.body?.name === 'string' ? req.body.name.trim().toLowerCase() : '');
    if (!crypto.timingSafeEqual(sha(given), (who || noAccount).hash) || !who) {
      await db.query('INSERT INTO login_failures (ip, at) VALUES ($1, $2)', [ip, now]);
      throw new HttpError(401, 'wrong_login');
    }
    await db.query('DELETE FROM login_failures WHERE ip = $1 OR at < $2', [ip, now - LOGIN_WINDOW_MS]);
    await db.query('DELETE FROM sessions WHERE expires_at < $1', [now]);
    const token = crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO sessions (token_hash, expires_at, admin_name) VALUES ($1, $2, $3)', [sha(token).toString('hex'), now + SESSION_MS, who.name]);
    setCookie(req, res, token, SESSION_MS / 1000);
    res.json({ ok: true, name: who.name });
  });

  app.post('/api/admin/logout', async (req, res) => {
    const t = cookieToken(req);
    if (t) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(t).toString('hex')]);
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', async (req, res) => {
    const name = await adminOf(req);
    res.set('Cache-Control', 'no-store').json({ admin: !!name, name });
  });

  const admin = express.Router();
  admin.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!(await adminOf(req))) throw new HttpError(401, 'not_signed_in');
    next();
  });

  admin.get('/lists', async (req, res) => {
    const [lists, items, resv] = await Promise.all([
      rows('SELECT id, slug, name, note FROM lists ORDER BY created_at, id'),
      rows('SELECT id, list_id, name, price_egp, quantity, shop_url, photo FROM items ORDER BY id DESC'),
      rows('SELECT id, item_id, guest_name, guest_mobile, count, created_at FROM reservations ORDER BY created_at, id'),
    ]);
    const byItem = new Map();
    for (const r of resv) {
      if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
      byItem.get(r.item_id).push({ id: r.id, name: r.guest_name, mobile: r.guest_mobile, count: r.count, at: Number(r.created_at) });
    }
    res.json({
      lists: lists.map(l => ({
        ...l,
        items: items.filter(i => i.list_id === l.id).map(i => ({
          id: i.id, name: i.name, price: i.price_egp, qty: i.quantity, link: i.shop_url || '', photo: photos.url(i.photo),
          reservations: byItem.get(i.id) || [],
        })),
      })),
    });
  });

  admin.post('/lists', async (req, res) => {
    const name = text(req.body?.name, 60, 'bad_name', true), note = text(req.body?.note, 160, 'bad_note');
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await one('INSERT INTO lists (slug, name, note, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING RETURNING id',
        [newSlug(), name, note, Date.now()]);
      if (r) return res.status(201).json({ id: r.id });
    }
    throw new Error('could not make a unique slug');
  });

  admin.patch('/lists/:id', async (req, res) => {
    const name = text(req.body?.name, 60, 'bad_name', true), note = text(req.body?.note, 160, 'bad_note');
    const r = await db.query('UPDATE lists SET name = $1, note = $2 WHERE id = $3', [name, note, idParam(req.params.id)]);
    if (!r.count) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });

  admin.delete('/lists/:id', async (req, res) => {
    const id = idParam(req.params.id);
    const pics = await rows('SELECT photo FROM items WHERE list_id = $1 AND photo IS NOT NULL', [id]);
    const r = await db.query('DELETE FROM lists WHERE id = $1', [id]);
    if (!r.count) throw new HttpError(404, 'not_found');
    await Promise.all(pics.map(p => dropPhoto(p.photo)));
    res.json({ ok: true });
  });

  admin.post('/lists/:id/items', async (req, res) => {
    const listId = idParam(req.params.id);
    if (!(await one('SELECT 1 AS ok FROM lists WHERE id = $1', [listId]))) throw new HttpError(404, 'not_found');
    const f = itemFields(req.body || {}, { partial: false });
    const photo = req.body?.photo ? await savePhoto(req.body.photo) : null;
    try {
      const r = await one('INSERT INTO items (list_id, name, price_egp, quantity, shop_url, photo, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [listId, f.name, f.price_egp, f.quantity, f.shop_url, photo, Date.now()]);
      res.status(201).json({ id: r.id });
    } catch (e) { await dropPhoto(photo); throw e; }
  });

  // photo: omitted = keep, null = remove, data URL = replace
  admin.patch('/items/:id', async (req, res) => {
    const id = idParam(req.params.id), b = req.body || {};
    const f = itemFields(b, { partial: true });
    const newPhoto = typeof b.photo === 'string' ? await savePhoto(b.photo) : undefined;
    let oldPhoto;
    try {
      await db.tx(async q => {
        const it = (await q('SELECT photo FROM items WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!it) throw new HttpError(404, 'not_found');
        const reserved = (await q('SELECT COALESCE(SUM(count), 0)::int AS n FROM reservations WHERE item_id = $1', [id])).rows[0].n;
        if (f.quantity !== undefined && f.quantity < reserved) throw new HttpError(409, 'qty_below_reserved', { reserved });
        if (newPhoto !== undefined || b.photo === null) { f.photo = newPhoto ?? null; oldPhoto = it.photo; }
        const cols = Object.keys(f);
        if (cols.length) await q(`UPDATE items SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`, [...cols.map(c => f[c]), id]);
      });
    } catch (e) { await dropPhoto(newPhoto); throw e; }
    await dropPhoto(oldPhoto);
    res.json({ ok: true });
  });

  admin.delete('/items/:id', async (req, res) => {
    const it = await one('DELETE FROM items WHERE id = $1 RETURNING photo', [idParam(req.params.id)]);
    if (!it) throw new HttpError(404, 'not_found');
    await dropPhoto(it.photo);
    res.json({ ok: true });
  });

  admin.delete('/reservations/:id', async (req, res) => {
    const r = await db.query('DELETE FROM reservations WHERE id = $1', [idParam(req.params.id)]);
    if (!r.count) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });

  app.use('/api/admin', admin);

  /* ---------- guest API: never returns reservations, names or mobiles ---------- */
  const slugOk = s => /^[a-z0-9]{4,16}$/.test(s);

  app.get('/api/l/:slug', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const l = slugOk(req.params.slug) && (await one('SELECT id, name, note FROM lists WHERE slug = $1', [req.params.slug]));
    if (!l) throw new HttpError(404, 'not_found');
    const items = await rows(`
      SELECT i.id, i.name, i.price_egp, i.quantity, i.shop_url, i.photo,
             (i.quantity - COALESCE((SELECT SUM(count) FROM reservations r WHERE r.item_id = i.id), 0))::int AS pieces_left
      FROM items i WHERE i.list_id = $1 ORDER BY i.id DESC`, [l.id]);
    res.json({
      name: l.name, note: l.note,
      total: items.length,
      items: items.filter(i => i.pieces_left > 0).map(i => ({
        id: i.id, name: i.name, price: i.price_egp, link: i.shop_url || '', photo: photos.url(i.photo),
        left: i.pieces_left, each: i.quantity > 1,
      })),
    });
  });

  app.post('/api/l/:slug/items/:id/reserve', async (req, res) => {
    if (reserveLimit.over(req.ip)) throw new HttpError(429, 'too_many_attempts');
    if (!slugOk(req.params.slug)) throw new HttpError(404, 'not_found');
    const id = idParam(req.params.id);
    const name = text(req.body?.name, 60, 'bad_name', true);
    const mobileRaw = typeof req.body?.mobile === 'string' ? req.body.mobile.trim() : '';
    if (!/^\+?[0-9 ]{8,17}$/.test(mobileRaw)) throw bad('bad_mobile');
    const count = req.body?.count === undefined ? 1 : Number(req.body.count);
    if (!Number.isInteger(count) || count < 1 || count > 999) throw bad('bad_count');

    // Lock the item and re-check what's left inside the transaction so two guests can't take the same last pieces
    await db.tx(async q => {
      const it = (await q('SELECT i.quantity FROM items i JOIN lists l ON l.id = i.list_id WHERE i.id = $1 AND l.slug = $2 FOR UPDATE OF i', [id, req.params.slug])).rows[0];
      if (!it) throw new HttpError(404, 'not_found');
      const reserved = (await q('SELECT COALESCE(SUM(count), 0)::int AS n FROM reservations WHERE item_id = $1', [id])).rows[0].n;
      const left = it.quantity - reserved;
      if (left < count) throw new HttpError(409, 'not_enough', { left: Math.max(0, left) });
      await q('INSERT INTO reservations (item_id, guest_name, guest_mobile, count, created_at) VALUES ($1, $2, $3, $4, $5)',
        [id, name, mobileRaw.replace(/\s+/g, ''), count, Date.now()]);
    });
    reserveLimit.hit(req.ip);
    res.status(201).json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  /* ---------- pages and files ---------- */
  const page = name => (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, name));
  app.get('/l/:slug', page('guest.html'));
  app.get('/admin', page('admin.html'));
  // The main address goes to the admin sign-in. (No public/index.html, so Vercel doesn't serve a static page here.)
  app.get('/', (req, res) => res.redirect(302, '/admin'));
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  if (photos.read) app.get('/photos/:name', async (req, res) => {
    const f = /^[a-f0-9]{24}\.jpg$/.test(req.params.name) && (await photos.read(req.params.name));
    if (!f) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
    if (f.size) res.set('Content-Length', String(f.size));
    Readable.fromWeb(f.stream).on('error', () => res.destroy()).pipe(res);
  });
  if (photos.dir) app.use('/photos', express.static(photos.dir, { index: false, immutable: true, maxAge: '365d', fallthrough: false }));
  app.use(express.static(PUBLIC, { index: false, extensions: false, setHeaders: res => res.set('Cache-Control', 'no-cache') }));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, 'notfound.html')));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'photo_too_big' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.status === 404 ? 'not_found' : 'bad_request' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}

module.exports = { createApp };
