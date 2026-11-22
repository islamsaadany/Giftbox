/* Reads a shop page for the item form: its main picture, price and title. Also reads whether the shop
   still has the product (linkStock), for the regular check of every gift's shop link.
   The address comes from a signed-in user, so the fetch is fenced in: http(s) on the usual ports only,
   never to a private or local address (checked on the address actually connected to, on every redirect),
   with a time limit and size limits. */
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

const MAX_HTML = 1500 * 1024;      // enough to reach the tags we read; the rest of the page is dropped
const MAX_IMAGE = 3 * 1024 * 1024; // the picture goes back to the browser, which shrinks it before saving
const TIMEOUT_MS = 8000, MAX_REDIRECTS = 4;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; link-preview/1.0)',
  'Accept-Language': 'en,ar;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) blocked.addSubnet(a, p, 'ipv6');
function isPrivate(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  return !family || blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

class LinkError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }

/* One GET without following redirects. Resolves { status, headers, body } with the body cut at maxBytes
   (cut: true), or rejects with a LinkError when overflow is "fail". */
function get(url, { maxBytes, overflow, accept, allowPrivate }) {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new LinkError('bad_link'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate) {
      if (url.port || url.username || url.password) return reject(new LinkError('bad_link'));
      if (net.isIP(host) && isPrivate(host)) return reject(new LinkError('bad_link'));
    }
    // Checked at connection time, so a name can't pass the check and then resolve to a private address
    const lookup = (name, opts, cb) => dns.lookup(name, { ...opts, all: true }, (err, list) => {
      if (err) return cb(err);
      if (!allowPrivate && list.some(a => isPrivate(a.address))) return cb(new LinkError('bad_link'));
      opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
    });
    const req = (url.protocol === 'https:' ? https : http).get(url, { headers: { ...HEADERS, Accept: accept }, lookup, timeout: TIMEOUT_MS }, res => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks = []; let size = 0, done = false;
      const finish = cut => { if (done) return; done = true; clearTimeout(timer); req.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), cut }); };
      stream.on('data', c => {
        if (done) return;
        size += c.length;
        if (size > maxBytes) {
          if (overflow === 'fail') { done = true; clearTimeout(timer); req.destroy(); return reject(new LinkError('too_big')); }
          chunks.push(c.subarray(0, c.length - (size - maxBytes)));
          return finish(true);
        }
        chunks.push(c);
      });
      stream.on('end', () => finish(false));
      stream.on('error', () => (chunks.length ? finish(true) : fail()));
    });
    const fail = e => { clearTimeout(timer); reject(e instanceof LinkError ? e : new LinkError('unreachable')); };
    const timer = setTimeout(() => req.destroy(new LinkError('unreachable')), TIMEOUT_MS);
    req.on('timeout', () => req.destroy(new LinkError('unreachable')));
    req.on('error', fail);
  });
}

async function fetchFollowing(start, opts) {
  let url = start;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await get(url, opts);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      try { url = new URL(r.headers.location, url); } catch { throw new LinkError('unreachable'); }
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new LinkError('unreachable', r.status);
    return { ...r, url };
  }
  throw new LinkError('unreachable');
}

/* ---------- reading the page ---------- */
const unescape = s => s.replace(/&(amp|quot|#39|#x27|apos|lt|gt|#x2F|#47);/gi, (m, e) => ({ amp: '&', quot: '"', '#39': "'", '#x27': "'", apos: "'", lt: '<', gt: '>', '#x2f': '/', '#47': '/' }[e.toLowerCase()]));

// <meta property|name|itemprop="key" content="..."> in either attribute order; first match wins
function metas(html) {
  const out = new Map();
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attr = n => { const m = new RegExp('\\b' + n + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag); return m ? unescape(m[1] ?? m[2] ?? m[3] ?? '').trim() : ''; };
    const key = (attr('property') || attr('name') || attr('itemprop')).toLowerCase(), content = attr('content');
    if (key && content && !out.has(key)) out.set(key, content);
  }
  return out;
}

// schema.org Product data, which most shops include for search engines
function products(html) {
  const found = [];
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    const type = [].concat(v['@type'] || []).map(String);
    if (type.some(t => /^(Product|ProductGroup)$/i.test(t))) found.push(v);
    walk(v['@graph']); walk(v.mainEntity); walk(v.hasVariant);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* shops publish broken JSON often enough */ }
  }
  return found;
}

// "1,299.00", "1.299,00", "EGP 480" -> a number, or null
function toPrice(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= 1e9 ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) s = dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (comma >= 0) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  else if ((s.match(/\./g) || []).length > 1 || /^\d{1,3}\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : null;
}

function readPage(html, base) {
  const meta = metas(html), prods = products(html);
  const first = v => (Array.isArray(v) ? v[0] : v);
  let image = meta.get('og:image:secure_url') || meta.get('og:image') || meta.get('og:image:url') || meta.get('twitter:image') || meta.get('twitter:image:src') || '';
  let price = toPrice(meta.get('product:price:amount') ?? meta.get('og:price:amount') ?? meta.get('product:sale_price:amount'));
  let currency = meta.get('product:price:currency') || meta.get('og:price:currency') || '';
  let title = meta.get('og:title') || '';
  for (const p of prods) {
    if (!image) { const im = first(p.image); image = typeof im === 'string' ? im : (im && (im.url || im.contentUrl)) || ''; }
    if (!title && typeof p.name === 'string') title = p.name;
    if (price === null) {
      const o = first(p.offers);
      if (o && typeof o === 'object') {
        price = toPrice(o.price ?? o.lowPrice ?? first(o.priceSpecification)?.price);
        if (price !== null && !currency) currency = String(o.priceCurrency || first(o.priceSpecification)?.priceCurrency || '');
      }
    }
  }
  if (price === null) { price = toPrice(meta.get('price')); if (price !== null && !currency) currency = meta.get('pricecurrency') || ''; }
  if (!image) { const m = /<link\b[^>]*rel\s*=\s*["']?image_src["']?[^>]*>/i.exec(html); const h = m && /href\s*=\s*["']([^"']+)/i.exec(m[0]); if (h) image = unescape(h[1]); }
  if (!title) { const m = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html); if (m) title = unescape(m[1]); }
  let imageUrl = null;
  if (image) { try { const u = new URL(image, base); if (u.protocol === 'http:' || u.protocol === 'https:') imageUrl = u; } catch { /* no usable picture */ } }
  return { imageUrl, price, currency: currency.trim().toUpperCase().slice(0, 3), title: title.replace(/\s+/g, ' ').trim().slice(0, 80) };
}

/* ---------- is it still in stock? ---------- */
const OUT = new Set(['outofstock', 'soldout', 'discontinued', 'oos']);
const IN = new Set(['instock', 'limitedavailability', 'onlineonly', 'instoreonly', 'preorder', 'presale', 'backorder', 'availablefororder']);
// "https://schema.org/OutOfStock", "out of stock", "OutOfStock" -> "out"; an in-stock value -> "in"; anything else -> null
function availability(v) {
  if (typeof v !== 'string') return null;
  const k = v.trim().split(/[/#]/).pop().toLowerCase().replace(/[^a-z]/g, '');
  return OUT.has(k) ? 'out' : IN.has(k) ? 'in' : null;
}
// Several offers (sizes, sellers): the product is out only when none of them has it
const verdict = list => { const known = list.map(availability).filter(Boolean); return known.includes('in') ? 'in' : known.includes('out') ? 'out' : null; };

/* What the page publishes about availability: "in", "out", or null when it doesn't say.
   Read from schema.org product data first (the first product that says anything, with its variants),
   then the Open Graph product tags, then microdata. */
function stockOf(html) {
  const offersOf = p => {
    const out = [];
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (o.availability !== undefined) out.push(typeof o.availability === 'object' ? o.availability?.['@id'] : o.availability);
      walk(o.offers);
    };
    walk(p.offers);
    for (const v of [].concat(p.hasVariant || [])) if (v && typeof v === 'object') out.push(...offersOf(v));
    return out;
  };
  for (const p of products(html)) { const v = verdict(offersOf(p)); if (v) return v; }
  const meta = metas(html);
  const fromMeta = verdict([meta.get('product:availability'), meta.get('og:availability')]);
  if (fromMeta) return fromMeta;
  for (const tag of html.match(/<(?:link|meta)\b[^>]*\bitemprop\s*=\s*["']?availability\b[^>]*>/gi) || []) {
    const m = /\b(?:href|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const v = m && availability(m[1] ?? m[2] ?? m[3]);
    if (v) return v;
  }
  return null;
}

/* Returns "in", "out", "gone" (the shop answers that the page no longer exists), or null when the page
   doesn't say or can't be read (many shops block automated requests). Never throws. */
async function linkStock(link, { allowPrivate = false } = {}) {
  try {
    const page = await fetchFollowing(new URL(link), { maxBytes: MAX_HTML, overflow: 'cut', accept: 'text/html,application/xhtml+xml,*/*;q=0.5', allowPrivate });
    return isImage(page.headers) ? null : stockOf(page.body.toString('utf8'));
  } catch (e) { return e.status === 404 || e.status === 410 ? 'gone' : null; }
}

const isImage = h => /^image\/(jpeg|png|webp|gif|avif)\b/i.test(String(h['content-type'] || ''));
const dataUrl = r => `data:${String(r.headers['content-type']).split(';')[0].trim().toLowerCase()};base64,${r.body.toString('base64')}`;

/* Returns { image (data URL or null), price (number or null), currency, title }. Throws a LinkError
   ("bad_link", "unreachable") when the page can't be read at all. allowPrivate is for tests only. */
async function linkInfo(link, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(link); } catch { throw new LinkError('bad_link'); }
  const page = await fetchFollowing(url, { maxBytes: MAX_IMAGE, overflow: 'cut', accept: 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5', allowPrivate });
  // The link is the picture itself
  if (isImage(page.headers)) return { image: page.cut ? null : dataUrl(page), price: null, currency: '', title: '' };
  const info = readPage(page.body.subarray(0, MAX_HTML).toString('utf8'), page.url);
  let image = null;
  if (info.imageUrl) {
    try {
      const pic = await fetchFollowing(info.imageUrl, { maxBytes: MAX_IMAGE, overflow: 'fail', accept: 'image/avif,image/webp,image/*,*/*;q=0.5', allowPrivate });
      if (isImage(pic.headers) && pic.body.length) image = dataUrl(pic);
    } catch { /* the price and title are still worth returning */ }
  }
  return { image, price: info.price, currency: info.currency, title: info.title };
}

module.exports = { linkInfo, linkStock, stockOf, LinkError, isPrivate, toPrice, readPage };
