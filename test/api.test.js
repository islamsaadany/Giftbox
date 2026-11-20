const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');
const { openPhotos } = require('../src/photos');

const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64');
let server, base, cookie = '', dataDir, db;

async function call(method, url, body, { auth = true } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wishbox-'));
  db = openDb({ url: process.env.TEST_DATABASE_URL }); // set it to run against a real Postgres
  const app = createApp({ db, photos: openPhotos({ dir: path.join(dataDir, 'photos') }), admins: [{ name: 'Alaa', password: 'correct horse' }, { name: 'Islam', password: 'second pass' }] });
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); await db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('admin API needs a login', async () => {
  assert.equal((await call('GET', '/api/admin/lists')).status, 401);
  assert.equal((await call('POST', '/api/admin/lists', { name: 'x' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { name: 'Alaa', password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { name: 'Alaa', password: 'second pass' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { name: 'Nobody', password: 'correct horse' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { name: ' islam ', password: 'second pass' })).status, 200);
  assert.equal((await call('GET', '/api/admin/me')).body.name, 'Islam');
  assert.equal((await call('POST', '/api/admin/login', { name: 'Alaa', password: 'correct horse' })).status, 200);
  assert.equal((await call('GET', '/api/admin/me')).body.name, 'Alaa');
  assert.equal((await call('GET', '/api/admin/lists')).status, 200);
});

let slug, diapers, monitor;
test('lists and items', async () => {
  const l = await call('POST', '/api/admin/lists', { name: 'Baby list', note: 'For the little one.' });
  assert.equal(l.status, 201);
  assert.equal((await call('POST', `/api/admin/lists/${l.body.id}/items`, { name: '' })).status, 400);
  assert.equal((await call('POST', `/api/admin/lists/${l.body.id}/items`, { name: 'x', link: 'javascript:alert(1)' })).status, 400);
  diapers = (await call('POST', `/api/admin/lists/${l.body.id}/items`, { name: 'Diapers', price: 480, qty: 10, link: 'https://shop.example/d', photo: JPEG })).body.id;
  monitor = (await call('POST', `/api/admin/lists/${l.body.id}/items`, { name: 'Monitor', price: 4200 })).body.id;
  const lists = (await call('GET', '/api/admin/lists')).body.lists;
  slug = lists[0].slug;
  assert.match(slug, /^[a-z0-9]{8}$/);
  const photo = lists[0].items.find(i => i.id === diapers).photo;
  assert.equal((await fetch(base + photo)).status, 200);
});

test('guests see available items only, and no reservation details', async () => {
  assert.equal((await call('GET', '/api/l/zzzzzzzz', null, { auth: false })).status, 404);
  assert.equal((await call('POST', `/api/l/${slug}/items/${monitor}/reserve`, { name: 'Sara', mobile: 'abc' }, { auth: false })).status, 400);
  assert.equal((await call('POST', `/api/l/${slug}/items/${monitor}/reserve`, { name: 'Sara Ahmed', mobile: '0101 234 5678' }, { auth: false })).status, 201);
  assert.equal((await call('POST', `/api/l/${slug}/items/${diapers}/reserve`, { name: 'Omar', mobile: '01198765432', count: 3 }, { auth: false })).status, 201);

  const g = await call('GET', '/api/l/' + slug, null, { auth: false });
  assert.deepEqual(g.body.items.map(i => i.name), ['Diapers']);
  assert.equal(g.body.items[0].left, 7);
  const raw = JSON.stringify(g.body);
  for (const secret of ['Sara', 'Omar', '0101', '0119', 'reservations', 'qty']) assert.ok(!raw.includes(secret), secret);
});

test('cannot reserve more than is left', async () => {
  const over = await call('POST', `/api/l/${slug}/items/${diapers}/reserve`, { name: 'Mona', mobile: '01000000000', count: 8 }, { auth: false });
  assert.equal(over.status, 409);
  assert.equal(over.body.left, 7);
  const gone = await call('POST', `/api/l/${slug}/items/${monitor}/reserve`, { name: 'Mona', mobile: '01000000000' }, { auth: false });
  assert.equal(gone.status, 409);
  assert.equal(gone.body.left, 0);
  // an item can't be reserved through another list's link
  const other = (await call('POST', '/api/admin/lists', { name: 'Birthday' })).body.id;
  const otherSlug = (await call('GET', '/api/admin/lists')).body.lists.find(l => l.id === other).slug;
  assert.equal((await call('POST', `/api/l/${otherSlug}/items/${diapers}/reserve`, { name: 'Mona', mobile: '01000000000' }, { auth: false })).status, 404);
});

test('admin sees reservations, cannot go below reserved, can release', async () => {
  let items = (await call('GET', '/api/admin/lists')).body.lists[0].items;
  const d = items.find(i => i.id === diapers);
  assert.deepEqual(d.reservations.map(r => [r.name, r.mobile, r.count]), [['Omar', '01198765432', 3]]);
  const low = await call('PATCH', '/api/admin/items/' + diapers, { qty: 2 });
  assert.equal(low.status, 409);
  assert.equal(low.body.reserved, 3);
  assert.equal((await call('PATCH', '/api/admin/items/' + diapers, { qty: 5, photo: null })).status, 200);
  assert.equal(fs.readdirSync(path.join(dataDir, 'photos')).length, 0);

  const m = items.find(i => i.id === monitor);
  assert.equal((await call('DELETE', '/api/admin/reservations/' + m.reservations[0].id)).status, 200);
  const g = await call('GET', '/api/l/' + slug, null, { auth: false });
  assert.deepEqual(g.body.items.map(i => [i.name, i.left]).sort(), [['Diapers', 2], ['Monitor', 1]]);
});

test('deleting a list removes its link; logout ends the session', async () => {
  const id = (await call('GET', '/api/admin/lists')).body.lists[0].id;
  assert.equal((await call('DELETE', '/api/admin/lists/' + id)).status, 200);
  assert.equal((await call('GET', '/api/l/' + slug, null, { auth: false })).status, 404);
  const old = cookie;
  await call('POST', '/api/admin/logout', {});
  cookie = old;
  assert.equal((await call('GET', '/api/admin/lists')).status, 401);
});

test('anyone can create an account, and sees only their own lists', async () => {
  await call('POST', '/api/admin/login', { name: 'Alaa', password: 'correct horse' });
  const alaaCookie = cookie;
  const theirs = (await call('POST', '/api/admin/lists', { name: 'Alaa only' })).body.id;
  const item = (await call('POST', `/api/admin/lists/${theirs}/items`, { name: 'Stroller', photo: JPEG })).body.id;
  const theirSlug = (await call('GET', '/api/admin/lists')).body.lists.find(l => l.id === theirs).slug;
  await call('POST', `/api/l/${theirSlug}/items/${item}/reserve`, { name: 'Nour', mobile: '01011112222' }, { auth: false });
  const resv = (await call('GET', '/api/admin/lists')).body.lists.find(l => l.id === theirs).items[0].reservations[0].id;

  cookie = '';
  assert.equal((await call('POST', '/api/admin/signup', { name: 'x', password: 'long enough' })).status, 400);
  assert.equal((await call('POST', '/api/admin/signup', { name: 'Mona', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/admin/signup', { name: 'ALAA', password: 'long enough' })).status, 409);
  const up = await call('POST', '/api/admin/signup', { name: 'Mona', password: 'long enough' });
  assert.equal(up.status, 201);
  assert.equal((await call('GET', '/api/admin/me')).body.name, 'Mona');
  assert.deepEqual((await call('GET', '/api/admin/lists')).body.lists, []);

  // Mona can't read or change anything of Alaa's
  assert.equal((await call('PATCH', '/api/admin/lists/' + theirs, { name: 'Mine now' })).status, 404);
  assert.equal((await call('POST', `/api/admin/lists/${theirs}/items`, { name: 'Sneaky' })).status, 404);
  assert.equal((await call('PATCH', '/api/admin/items/' + item, { name: 'Sneaky' })).status, 404);
  assert.equal((await call('DELETE', '/api/admin/items/' + item)).status, 404);
  assert.equal((await call('DELETE', '/api/admin/reservations/' + resv)).status, 404);
  assert.equal((await call('DELETE', '/api/admin/lists/' + theirs)).status, 404);

  const mine = (await call('POST', '/api/admin/lists', { name: 'Mona list' })).body.id;
  assert.deepEqual((await call('GET', '/api/admin/lists')).body.lists.map(l => l.id), [mine]);
  await call('POST', '/api/admin/logout', {});
  assert.equal((await call('POST', '/api/admin/login', { name: 'mona', password: 'long enough' })).status, 200);
  assert.deepEqual((await call('GET', '/api/admin/lists')).body.lists.map(l => l.name), ['Mona list']);

  cookie = alaaCookie;
  const l = (await call('GET', '/api/admin/lists')).body.lists.find(x => x.id === theirs);
  assert.deepEqual([l.name, l.items[0].name, l.items[0].reservations.length], ['Alaa only', 'Stroller', 1]);
  assert.ok(!(await call('GET', '/api/admin/lists')).body.lists.some(x => x.id === mine));
});

test('lists from before accounts go to the first ADMIN_USERS account', async () => {
  await db.query("INSERT INTO lists (slug, name, created_at) VALUES ('oldlist22', 'Old list', 1)");
  const app2 = createApp({ db, photos: openPhotos({ dir: path.join(dataDir, 'photos') }), admins: [{ name: 'Alaa', password: 'changed in env' }, { name: 'Islam', password: 'second pass' }] });
  const s2 = await new Promise(r => { const s = app2.listen(0, () => r(s)); });
  const old = base; base = 'http://127.0.0.1:' + s2.address().port;
  try {
    // the stored password wins over a later change in ADMIN_USERS
    assert.equal((await call('POST', '/api/admin/login', { name: 'Alaa', password: 'correct horse' })).status, 200);
    assert.ok((await call('GET', '/api/admin/lists')).body.lists.some(l => l.name === 'Old list'));
    await call('POST', '/api/admin/login', { name: 'Islam', password: 'second pass' });
    assert.ok(!(await call('GET', '/api/admin/lists')).body.lists.some(l => l.name === 'Old list'));
  } finally { base = old; s2.close(); }
});

test('two guests racing for the last piece: only one wins', async () => {
  await call('POST', '/api/admin/login', { name: 'Alaa', password: 'correct horse' });
  const l = (await call('POST', '/api/admin/lists', { name: 'Race' })).body.id;
  const it = (await call('POST', `/api/admin/lists/${l}/items`, { name: 'Bathtub' })).body.id;
  const s = (await call('GET', '/api/admin/lists')).body.lists.find(x => x.id === l).slug;
  const tries = await Promise.all([1, 2, 3, 4].map(n => call('POST', `/api/l/${s}/items/${it}/reserve`, { name: 'Guest ' + n, mobile: '0100000000' + n }, { auth: false })));
  assert.deepEqual(tries.map(t => t.status).sort(), [201, 409, 409, 409]);
});

test('too many wrong passwords locks sign-in for a while', async () => {
  for (let i = 0; i < 10; i++) await call('POST', '/api/admin/login', { name: 'Alaa', password: 'guess' + i });
  assert.equal((await call('POST', '/api/admin/login', { name: 'Alaa', password: 'correct horse' })).status, 429);
});

test('the main address goes to the admin sign-in', async () => {
  const r = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin');
  assert.equal((await fetch(base + '/nope')).status, 404);
});
