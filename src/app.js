const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { promisify } = require('node:util');
const path = require('node:path');
const { Readable } = require('node:stream');

const PUBLIC = path.join(__dirname, '..', 'public');
const COOKIE = 'wb_admin';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SLUG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)
const MAX_PHOTO_BYTES = 700 * 1024;
const LOGIN_MAX = 10, LOGIN_WINDOW_MS = 15 * 60 * 1000;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,29}$/u; // 2 to 30 characters
const PASSWORD_MIN = 8, PASSWORD_MAX = 200;
const THEMES = ['pink', 'blue', 'teal', 'green', 'purple', 'orange']; // colours live in public/app.css

const scrypt = promisify(crypto.scrypt);
/* Passwords are stored as "salt:key" (hex), hashed with scrypt */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + (await scrypt(password, salt, 32)).toString('hex');
}
async function checkPassword(password, stored) {
  const [salt, key] = stored.split(':').map(h => Buffer.from(h, 'hex'));
  return crypto.timingSafeEqual(await scrypt(password, salt, 32), key);
}

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

const STOCK_RECHECK_MS = 20 * 60 * 60 * 1000; // the regular check looks at each shop link at most about once a day
const STOCK_BUDGET_MS = 18000, STOCK_ITEM_MS = 9000, STOCK_PARALLEL = 5; // one run stays inside the 30 seconds a request gets

/* db: from ./db (query/tx/ready). photos: from ./photos (save/remove/url).
   linkInfo: reads a shop page (./linkinfo); tests pass their own. linkStock: says whether a shop page still has the product.
   cronSecret: when set, the regular link check (/api/cron/check-links) only runs for callers that send it.
   admins: [{ name, password, admin }] from ADMIN_USERS (see ./admins). Those with admin !== false are
   the only ones who can create users. */
function createApp({ db, photos, admins, trustProxy = 1, publicUrl = '', cronSecret = '', linkInfo = require('./linkinfo').linkInfo, linkStock = require('./linkinfo').linkStock }) {
  // Address guests should use; empty means "whatever address the user is on"
  publicUrl = /^https?:\/\/[^\s/]+/.test(publicUrl) ? publicUrl.replace(/\/+$/, '') : '';
  const adminKeys = new Set((admins || []).filter(a => a.admin !== false).map(a => a.name.toLowerCase()));
  if (!adminKeys.size) throw new Error('at least one admin is required');
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

  /* A fingerprint of the pages, scripts and styles this server hands out. An open app compares it with
     the one it started with, and offers to reload when a new version has been deployed. */
  const version = (() => {
    const h = crypto.createHash('sha256');
    for (const f of fs.readdirSync(PUBLIC).sort()) if (/\.(html|js|css|webmanifest)$/.test(f)) h.update(f).update(fs.readFileSync(path.join(PUBLIC, f)));
    return h.digest('hex').slice(0, 16);
  })();
  app.get('/api/version', (req, res) => res.set('Cache-Control', 'no-store').json({ version }));

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

  /* Accounts from ADMIN_USERS are created once and never overwritten afterwards. Lists from before
     lists had owners go to the first of those accounts that isn't an admin (the person who was making
     lists), or to the first one when all of them are admins. */
  async function seed() {
    const have = new Set((await rows('SELECT name_key FROM users WHERE name_key = ANY($1)', [admins.map(a => a.name.toLowerCase())])).map(r => r.name_key));
    for (const a of admins) {
      if (have.has(a.name.toLowerCase())) continue;
      await db.query('INSERT INTO users (name, name_key, password_hash, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (name_key) DO NOTHING',
        [a.name, a.name.toLowerCase(), await hashPassword(a.password), Date.now()]);
    }
    await db.query('UPDATE lists SET user_id = (SELECT id FROM users WHERE name_key = $1) WHERE user_id IS NULL', [(admins.find(a => a.admin === false) || admins[0]).name.toLowerCase()]);
  }
  let seeded;
  // Make sure the tables and the first accounts exist before any API call
  app.use('/api', async (req, res, next) => {
    await db.ready();
    await (seeded ||= seed().catch(e => { seeded = null; throw e; }));
    next();
  });

  /* ---------- accounts and sessions ---------- */
  const reserveLimit = limiter(40, 60 * 60 * 1000);
  let dummyHash; // checked when the name is unknown, so both cases take the same time

  const cookieToken = req => {
    const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})').exec(req.headers.cookie || '');
    return m && m[1];
  };
  // Returns the signed-in user ({ id, name, theme, admin }), or undefined
  const userOf = async req => {
    const t = cookieToken(req);
    if (!t) return undefined;
    const u = await one('SELECT u.id, u.name, u.theme FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2', [sha(t).toString('hex'), Date.now()]);
    return u && { ...u, admin: adminKeys.has(u.name.toLowerCase()) };
  };
  const cleanName = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
  const newPassword = v => {
    if (typeof v !== 'string' || v.length < PASSWORD_MIN || v.length > PASSWORD_MAX) throw bad('bad_password');
    return v;
  };
  const setCookie = (req, res, value, maxAgeS) =>
    res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${req.secure ? '; Secure' : ''}`);
  async function startSession(req, res, user) {
    const now = Date.now(), token = crypto.randomBytes(32).toString('hex');
    await db.query('DELETE FROM sessions WHERE expires_at < $1', [now]);
    await db.query('INSERT INTO sessions (token_hash, expires_at, user_id) VALUES ($1, $2, $3)', [sha(token).toString('hex'), now + SESSION_MS, user.id]);
    setCookie(req, res, token, SESSION_MS / 1000);
  }

  app.post('/api/admin/login', async (req, res) => {
    const ip = String(req.ip || 'unknown'), now = Date.now();
    // Failed tries are counted in the database so the limit holds across server instances
    const f = await one('SELECT COUNT(*)::int AS n FROM login_failures WHERE ip = $1 AND at > $2', [ip, now - LOGIN_WINDOW_MS]);
    if (f.n >= LOGIN_MAX) throw new HttpError(429, 'too_many_attempts');
    const given = typeof req.body?.password === 'string' ? req.body.password.slice(0, PASSWORD_MAX) : '';
    const key = cleanName(req.body?.name).toLowerCase();
    const user = await one('SELECT id, name, theme, password_hash FROM users WHERE name_key = $1', [key]);
    const right = await checkPassword(given, user ? user.password_hash : (dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex'))));
    if (!user || !right) {
      await db.query('INSERT INTO login_failures (ip, at) VALUES ($1, $2)', [ip, now]);
      throw new HttpError(401, 'wrong_login');
    }
    await db.query('DELETE FROM login_failures WHERE ip = $1 OR at < $2', [ip, now - LOGIN_WINDOW_MS]);
    await startSession(req, res, user);
    res.json({ ok: true, name: user.name, isAdmin: adminKeys.has(key), publicUrl });
  });

  app.post('/api/admin/logout', async (req, res) => {
    const t = cookieToken(req);
    if (t) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(t).toString('hex')]);
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', async (req, res) => {
    const user = await userOf(req);
    res.set('Cache-Control', 'no-store').json({ admin: !!user, name: user ? user.name : null, isAdmin: !!user?.admin, publicUrl: user ? publicUrl : '' });
  });

  /* Everything below is limited to lists the signed-in user owns or was added to as a collaborator.
     Collaborators can change the list and its items; only the owner deletes it or chooses collaborators.
     Admins can do all of it on every user's lists. */
  // SQL condition on lists row "l": the user in parameter $n owns it or collaborates on it
  const can = n => `(l.user_id = $${n} OR EXISTS (SELECT 1 FROM list_collaborators c WHERE c.list_id = l.id AND c.user_id = $${n}))`;
  // may: lists the signed-in user can change (owner, collaborator or admin). owns: owner or admin.
  const all = n => `$${n}::int IS NOT NULL`; // true, and keeps the parameter in use
  const may = (n, req) => (req.user.admin ? all(n) : can(n));
  const owns = (n, req) => (req.user.admin ? all(n) : `l.user_id = $${n}`);
  const admin = express.Router();
  admin.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    req.user = await userOf(req);
    if (!req.user) throw new HttpError(401, 'not_signed_in');
    next();
  });

  /* The item form asks what a shop page says about a gift: its picture, price and name.
     linkInfo (./linkinfo) does the fetching and refuses private addresses. */
  const linkLimit = limiter(60, 60 * 60 * 1000);
  admin.post('/link-info', async (req, res) => {
    const key = 'u' + req.user.id;
    if (linkLimit.over(key)) throw new HttpError(429, 'too_many_attempts');
    const link = text(req.body?.url, 2000, 'bad_link', true);
    linkLimit.hit(key);
    try { res.json(await linkInfo(link)); }
    catch (e) {
      if (e.code === 'bad_link') throw bad('bad_link');
      if (e.code !== 'unreachable' && e.code !== 'too_big') console.error('link info failed', e);
      throw new HttpError(422, 'unreachable');
    }
  });

  /* ---------- shop links: is the gift still in stock? ----------
     Looks at the shop link of gifts guests can still reserve, the longest-unchecked first, and stores what the
     shop says. A page that doesn't say (or can't be read) leaves the last known answer as it is.
     One run takes as many as fit in its time; the next run carries on with the rest. */
  async function checkLinks({ listId = null, olderThanMs = STOCK_RECHECK_MS, budgetMs = STOCK_BUDGET_MS } = {}) {
    const started = Date.now();
    const todo = await rows(`SELECT i.id, i.shop_url FROM items i
      WHERE i.shop_url IS NOT NULL AND ($1::int IS NULL OR i.list_id = $1) AND (i.stock_checked_at IS NULL OR i.stock_checked_at <= $2)
        AND i.quantity > COALESCE((SELECT SUM(count) FROM reservations r WHERE r.item_id = i.id), 0)
      ORDER BY i.stock_checked_at NULLS FIRST, i.id LIMIT 300`, [listId, started - olderThanMs]);
    let next = 0, checked = 0, flagged = 0;
    const worker = async () => {
      while (next < todo.length && Date.now() - started < budgetMs) {
        const it = todo[next++];
        let timer;
        const stock = await Promise.race([
          Promise.resolve().then(() => linkStock(it.shop_url)).catch(() => null),
          new Promise(r => { timer = setTimeout(r, STOCK_ITEM_MS, null); }),
        ]);
        clearTimeout(timer);
        // Only if the link is still the one that was checked
        await db.query('UPDATE items SET stock = COALESCE($1::text, stock), stock_checked_at = $2 WHERE id = $3 AND shop_url = $4', [stock, Date.now(), it.id, it.shop_url]);
        checked++;
        if (stock === 'out' || stock === 'gone') flagged++;
      }
    };
    await Promise.all(Array.from({ length: STOCK_PARALLEL }, worker));
    return { checked, flagged, waiting: todo.length - next };
  }
  app.checkLinks = checkLinks;

  // Called once a day by the host (see "crons" in vercel.json). Vercel sends CRON_SECRET as a bearer token when it is set.
  app.get('/api/cron/check-links', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (cronSecret && !crypto.timingSafeEqual(sha(String(req.headers.authorization || '')), sha('Bearer ' + cronSecret))) throw new HttpError(401, 'not_allowed');
    res.json(await checkLinks());
  });

  // "Check shop links now" for one list
  const checkLimit = limiter(10, 60 * 60 * 1000);
  admin.post('/lists/:id/check-links', async (req, res) => {
    const listId = idParam(req.params.id), key = 'u' + req.user.id;
    if (!(await one(`SELECT 1 AS ok FROM lists l WHERE l.id = $1 AND ${may(2, req)}`, [listId, req.user.id]))) throw new HttpError(404, 'not_found');
    if (checkLimit.over(key)) throw new HttpError(429, 'too_many_attempts');
    checkLimit.hit(key);
    res.json(await checkLinks({ listId, olderThanMs: 0 }));
  });

  // The lists a user owns or collaborates on, with their items and reservations
  async function listsOf(userId) {
    const [lists, items, resv, collabs] = await Promise.all([
      rows(`SELECT l.id, l.slug, l.name, l.note, l.theme, l.user_id, o.name AS owner FROM lists l LEFT JOIN users o ON o.id = l.user_id WHERE ${can(1)} ORDER BY l.created_at, l.id`, [userId]),
      rows(`SELECT i.id, i.list_id, i.name, i.price_egp, i.quantity, i.shop_url, i.photo, i.stock FROM items i JOIN lists l ON l.id = i.list_id WHERE ${can(1)} ORDER BY i.id DESC`, [userId]),
      rows(`SELECT r.id, r.item_id, r.guest_name, r.guest_mobile, r.count, r.created_at FROM reservations r
            JOIN items i ON i.id = r.item_id JOIN lists l ON l.id = i.list_id WHERE ${can(1)} ORDER BY r.created_at, r.id`, [userId]),
      rows(`SELECT c.list_id, u.id, u.name FROM list_collaborators c JOIN users u ON u.id = c.user_id JOIN lists l ON l.id = c.list_id WHERE ${can(1)} ORDER BY u.name_key`, [userId]),
    ]);
    const byItem = new Map();
    for (const r of resv) {
      if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
      byItem.get(r.item_id).push({ id: r.id, name: r.guest_name, mobile: r.guest_mobile, count: r.count, at: Number(r.created_at) });
    }
    return lists.map(l => ({
      id: l.id, slug: l.slug, name: l.name, note: l.note, theme: l.theme || 'pink', owner: l.owner || '', mine: l.user_id === userId,
      collaborators: collabs.filter(c => c.list_id === l.id).map(c => ({ id: c.id, name: c.name })),
      items: items.filter(i => i.list_id === l.id).map(i => ({
        id: i.id, name: i.name, price: i.price_egp, qty: i.quantity, link: i.shop_url || '', photo: photos.url(i.photo),
        stock: i.shop_url && (i.stock === 'out' || i.stock === 'gone') ? i.stock : '', // '' = nothing to do about the link
        reservations: byItem.get(i.id) || [],
      })),
    }));
  }
  admin.get('/lists', async (req, res) => res.json({ lists: await listsOf(req.user.id) }));

  admin.post('/lists', async (req, res) => {
    const name = text(req.body?.name, 60, 'bad_name', true), note = text(req.body?.note, 160, 'bad_note');
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await one('INSERT INTO lists (slug, name, note, created_at, user_id, theme) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (slug) DO NOTHING RETURNING id',
        [newSlug(), name, note, Date.now(), req.user.id, 'pink']);
      if (r) return res.status(201).json({ id: r.id });
    }
    throw new Error('could not make a unique slug');
  });

  admin.patch('/lists/:id', async (req, res) => {
    const name = text(req.body?.name, 60, 'bad_name', true), note = text(req.body?.note, 160, 'bad_note');
    const r = await db.query(`UPDATE lists l SET name = $1, note = $2 WHERE l.id = $3 AND ${may(4, req)}`, [name, note, idParam(req.params.id), req.user.id]);
    if (!r.count) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });

  // The list's colour, used on its admin page and on the guest page. Anyone who can edit the list can change it.
  admin.patch('/lists/:id/theme', async (req, res) => {
    if (!THEMES.includes(req.body?.theme)) throw bad('bad_theme');
    const r = await db.query(`UPDATE lists l SET theme = $1 WHERE l.id = $2 AND ${may(3, req)}`, [req.body.theme, idParam(req.params.id), req.user.id]);
    if (!r.count) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });

  admin.delete('/lists/:id', async (req, res) => {
    const id = idParam(req.params.id);
    if (!(await one(`SELECT 1 AS ok FROM lists l WHERE l.id = $1 AND ${owns(2, req)}`, [id, req.user.id]))) throw new HttpError(404, 'not_found');
    const pics = await rows('SELECT photo FROM items WHERE list_id = $1 AND photo IS NOT NULL', [id]);
    const r = await db.query(`DELETE FROM lists l WHERE l.id = $1 AND ${owns(2, req)}`, [id, req.user.id]);
    if (!r.count) throw new HttpError(404, 'not_found');
    await Promise.all(pics.map(p => dropPhoto(p.photo)));
    res.json({ ok: true });
  });

  // The owner (or an admin) adds another user to the list by username
  admin.post('/lists/:id/collaborators', async (req, res) => {
    const listId = idParam(req.params.id);
    const list = await one(`SELECT l.user_id FROM lists l WHERE l.id = $1 AND ${owns(2, req)}`, [listId, req.user.id]);
    if (!list) throw new HttpError(404, 'not_found');
    const u = await one('SELECT id, name FROM users WHERE name_key = $1', [cleanName(req.body?.name).toLowerCase()]);
    if (!u) throw new HttpError(404, 'no_such_user');
    if (u.id === list.user_id) throw bad('is_owner');
    await db.query('INSERT INTO list_collaborators (list_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [listId, u.id]);
    res.status(201).json({ id: u.id, name: u.name });
  });

  // The owner removes a collaborator, or a collaborator leaves the list
  admin.delete('/lists/:id/collaborators/:userId', async (req, res) => {
    const listId = idParam(req.params.id), userId = idParam(req.params.userId);
    const r = await db.query(`DELETE FROM list_collaborators c USING lists l WHERE c.list_id = $1 AND c.user_id = $2 AND l.id = c.list_id
                              AND (${owns(3, req)} OR c.user_id = $3)`, [listId, userId, req.user.id]);
    if (!r.count) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });

  admin.post('/lists/:id/items', async (req, res) => {
    const listId = idParam(req.params.id);
    if (!(await one(`SELECT 1 AS ok FROM lists l WHERE l.id = $1 AND ${may(2, req)}`, [listId, req.user.id]))) throw new HttpError(404, 'not_found');
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
        const it = (await q(`SELECT i.photo, i.shop_url FROM items i JOIN lists l ON l.id = i.list_id WHERE i.id = $1 AND ${may(2, req)} FOR UPDATE OF i`, [id, req.user.id])).rows[0];
        if (!it) throw new HttpError(404, 'not_found');
        // A new link hasn't been checked yet: forget what the old one said
        if (f.shop_url !== undefined && f.shop_url !== it.shop_url) { f.stock = null; f.stock_checked_at = null; }
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
    const it = await one(`DELETE FROM items i USING lists l WHERE i.id = $1 AND l.id = i.list_id AND ${may(2, req)} RETURNING i.photo`, [idParam(req.params.id), req.user.id]);
    if (!it) throw new HttpError(404, 'not_found');
    await dropPhoto(it.photo);
    res.json({ ok: true });
  });

  admin.delete('/reservations/:id', async (req, res) => {
    const r = await db.query(`DELETE FROM reservations r USING items i, lists l WHERE r.id = $1 AND i.id = r.item_id AND l.id = i.list_id AND ${may(2, req)}`, [idParam(req.params.id), req.user.id]);
    if (!r.count) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  });

  /* ---------- users: only the admins (ADMIN_USERS) create accounts; there is no sign-up ---------- */
  const users = express.Router();
  users.use((req, res, next) => { if (!req.user.admin) throw new HttpError(403, 'not_allowed'); next(); });

  users.get('/', async (req, res) => {
    const list = await rows(`SELECT u.id, u.name, (SELECT COUNT(*)::int FROM lists l WHERE l.user_id = u.id) AS lists
                             FROM users u ORDER BY u.created_at, u.id`);
    res.json({ users: list.map(u => ({ ...u, admin: adminKeys.has(u.name.toLowerCase()) })) });
  });

  users.post('/', async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!NAME_RE.test(name)) throw bad('bad_name');
    const password = newPassword(req.body?.password);
    const u = await one('INSERT INTO users (name, name_key, password_hash, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (name_key) DO NOTHING RETURNING id',
      [name, name.toLowerCase(), await hashPassword(password), Date.now()]);
    if (!u) throw new HttpError(409, 'name_taken');
    res.status(201).json({ id: u.id });
  });

  // An admin opens a user's lists; the list, item and reservation calls above then let them change those too
  users.get('/:id/lists', async (req, res) => {
    const u = await one('SELECT id, name FROM users WHERE id = $1', [idParam(req.params.id)]);
    if (!u) throw new HttpError(404, 'not_found');
    res.json({ name: u.name, lists: await listsOf(u.id) });
  });

  // A new password signs the user out everywhere (except the admin changing their own)
  users.patch('/:id', async (req, res) => {
    const id = idParam(req.params.id), password = newPassword(req.body?.password);
    const r = await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(password), id]);
    if (!r.count) throw new HttpError(404, 'not_found');
    if (id !== req.user.id) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    res.json({ ok: true });
  });

  // Removes the user with their lists, items and reservations. Admins are removed from ADMIN_USERS first.
  users.delete('/:id', async (req, res) => {
    const id = idParam(req.params.id);
    const u = await one('SELECT name FROM users WHERE id = $1', [id]);
    if (!u) throw new HttpError(404, 'not_found');
    if (adminKeys.has(u.name.toLowerCase())) throw new HttpError(409, 'is_admin');
    const pics = await rows('SELECT i.photo FROM items i JOIN lists l ON l.id = i.list_id WHERE l.user_id = $1 AND i.photo IS NOT NULL', [id]);
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    await Promise.all(pics.map(p => dropPhoto(p.photo)));
    res.json({ ok: true });
  });

  admin.use('/users', users);
  app.use('/api/admin', admin);

  /* ---------- guest API: never returns reservations, names or mobiles ---------- */
  const slugOk = s => /^[a-z0-9]{4,16}$/.test(s);

  app.get('/api/l/:slug', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const l = slugOk(req.params.slug) && (await one('SELECT l.id, l.name, l.note, l.theme FROM lists l WHERE l.slug = $1', [req.params.slug]));
    if (!l) throw new HttpError(404, 'not_found');
    const items = await rows(`
      SELECT i.id, i.name, i.price_egp, i.quantity, i.shop_url, i.photo,
             (i.quantity - COALESCE((SELECT SUM(count) FROM reservations r WHERE r.item_id = i.id), 0))::int AS pieces_left
      FROM items i WHERE i.list_id = $1 ORDER BY i.id DESC`, [l.id]);
    res.json({
      name: l.name, note: l.note, theme: l.theme || 'pink',
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
  // The main address goes to the sign-in. (No public/index.html, so Vercel doesn't serve a static page here.)
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
