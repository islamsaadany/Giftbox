const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64');
let server, base, cookie = '', dataDir;

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
  const app = createApp({ dataDir, adminPassword: 'correct horse' });
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('admin API needs a login', async () => {
  assert.equal((await call('GET', '/api/admin/lists')).status, 401);
  assert.equal((await call('POST', '/api/admin/lists', { name: 'x' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'correct horse' })).status, 200);
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
