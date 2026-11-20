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

test('admins are told the public address for guest links', async () => {
  const app = createApp({ db, photos: openPhotos({ dir: path.join(dataDir, 'photos') }), admins: [{ name: 'Alaa', password: 'correct horse' }, { name: 'Islam', password: 'second pass' }], publicUrl: 'https://gifts.example.com/' });
  const s = app.listen(0);
  try {
    const at = 'http://127.0.0.1:' + s.address().port;
    assert.equal((await (await fetch(at + '/api/admin/me')).json()).publicUrl, '');
    const r = await (await fetch(at + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Alaa', password: 'correct horse' }) })).json();
    assert.equal(r.publicUrl, 'https://gifts.example.com');
  } finally { s.close(); }
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

test('admins create the users, and each user sees only their own lists', async () => {
  await call('POST', '/api/admin/login', { name: 'Alaa', password: 'correct horse' });
  const alaaCookie = cookie;
  const theirs = (await call('POST', '/api/admin/lists', { name: 'Alaa only' })).body.id;
  const item = (await call('POST', `/api/admin/lists/${theirs}/items`, { name: 'Stroller', photo: JPEG })).body.id;
  const theirSlug = (await call('GET', '/api/admin/lists')).body.lists.find(l => l.id === theirs).slug;
  await call('POST', `/api/l/${theirSlug}/items/${item}/reserve`, { name: 'Nour', mobile: '01011112222' }, { auth: false });
  const resv = (await call('GET', '/api/admin/lists')).body.lists.find(l => l.id === theirs).items[0].reservations[0].id;

  // there is no sign-up: only an admin can create a user
  assert.equal((await call('POST', '/api/admin/signup', { name: 'Mona', password: 'long enough' }, { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/admin/signup', { name: 'Mona', password: 'long enough' })).status, 404);
  assert.equal((await call('POST', '/api/admin/users', { name: 'Mona', password: 'long enough' }, { auth: false })).status, 401);
  assert.equal((await call('GET', '/api/admin/me')).body.isAdmin, true);
  assert.equal((await call('POST', '/api/admin/users', { name: 'x', password: 'long enough' })).status, 400);
  assert.equal((await call('POST', '/api/admin/users', { name: 'Mona', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/admin/users', { name: 'ALAA', password: 'long enough' })).status, 409);
  const mona = await call('POST', '/api/admin/users', { name: 'Mona', password: 'first pass' });
  assert.equal(mona.status, 201);
  assert.equal((await call('POST', '/api/admin/users', { name: 'Reem', password: 'reem pass 1' })).status, 201);
  assert.equal((await call('POST', '/api/admin/users', { name: 'Temp', password: 'long enough' })).status, 201);
  const all = (await call('GET', '/api/admin/users')).body.users;
  assert.deepEqual(all.map(u => [u.name, u.admin]), [['Alaa', true], ['Islam', true], ['Mona', false], ['Reem', false], ['Temp', false]]);
  const temp = all.find(u => u.name === 'Temp').id;
  assert.equal((await call('DELETE', '/api/admin/users/' + all[1].id)).status, 409); // admins stay
  assert.equal((await call('DELETE', '/api/admin/users/' + temp)).status, 200);
  assert.equal((await call('PATCH', '/api/admin/users/' + mona.body.id, { password: 'long enough' })).status, 200);

  cookie = '';
  assert.equal((await call('POST', '/api/admin/login', { name: 'Temp', password: 'long enough' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { name: 'Mona', password: 'first pass' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { name: 'Mona', password: 'long enough' })).status, 200);
  assert.deepEqual((await call('GET', '/api/admin/me')).body, { admin: true, name: 'Mona', theme: 'pink', isAdmin: false, publicUrl: '' });
  // each user picks their own colour, and their guests see it
  assert.equal((await call('PATCH', '/api/admin/me', { theme: 'red; }' })).status, 400);
  assert.equal((await call('PATCH', '/api/admin/me', { theme: 'blue' })).status, 200);
  assert.equal((await call('GET', '/api/admin/me')).body.theme, 'blue');
  const blueList = (await call('POST', '/api/admin/lists', { name: 'Blue list' })).body.id;
  const blueSlug = (await call('GET', '/api/admin/lists')).body.lists.find(l => l.id === blueList).slug;
  assert.equal((await call('GET', '/api/l/' + blueSlug, null, { auth: false })).body.theme, 'blue');
  assert.equal((await call('GET', '/api/l/' + theirSlug, null, { auth: false })).body.theme, 'pink');
  await call('DELETE', '/api/admin/lists/' + blueList);
  // a user can't manage users or look at someone else's lists
  assert.equal((await call('GET', `/api/admin/users/${all[0].id}/lists`)).status, 403);
  assert.equal((await call('GET', '/api/admin/users')).status, 403);
  assert.equal((await call('POST', '/api/admin/users', { name: 'Friend', password: 'long enough' })).status, 403);
  assert.equal((await call('PATCH', '/api/admin/users/' + all[0].id, { password: 'taken over' })).status, 403);
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

  // Mona shares her list with Reem, who can then edit it but not delete it or choose collaborators
  const share = `/api/admin/lists/${mine}/collaborators`;
  assert.equal((await call('POST', share, { name: 'Nobody' })).status, 404);
  assert.equal((await call('POST', share, { name: 'Mona' })).status, 400);
  const added = await call('POST', share, { name: ' reem ' });
  assert.deepEqual([added.status, added.body.name], [201, 'Reem']);
  assert.equal((await call('POST', share, { name: 'Reem' })).status, 201); // adding twice is fine
  assert.equal((await call('POST', `/api/admin/lists/${theirs}/collaborators`, { name: 'Mona' })).status, 404); // not her list
  const monaCookie = cookie;
  cookie = '';
  await call('POST', '/api/admin/login', { name: 'Reem', password: 'reem pass 1' });
  const reemCookie = cookie;
  const shared = (await call('GET', '/api/admin/lists')).body.lists.find(x => x.id === mine);
  assert.deepEqual([shared.mine, shared.owner, shared.collaborators.map(c => c.name)], [false, 'Mona', ['Reem']]);
  assert.equal((await call('PATCH', '/api/admin/lists/' + mine, { name: 'Mona list' })).status, 200);
  const gift = (await call('POST', `/api/admin/lists/${mine}/items`, { name: 'Blanket' })).body.id;
  assert.equal((await call('PATCH', '/api/admin/items/' + gift, { qty: 2 })).status, 200);
  await call('POST', `/api/l/${shared.slug}/items/${gift}/reserve`, { name: 'Hana', mobile: '01033334444' }, { auth: false });
  const hana = (await call('GET', '/api/admin/lists')).body.lists.find(x => x.id === mine).items[0].reservations[0];
  assert.equal(hana.name, 'Hana');
  assert.equal((await call('DELETE', '/api/admin/reservations/' + hana.id)).status, 200);
  assert.equal((await call('DELETE', '/api/admin/items/' + gift)).status, 200);
  assert.equal((await call('DELETE', '/api/admin/lists/' + mine)).status, 404);
  assert.equal((await call('POST', share, { name: 'Islam' })).status, 404);
  const reemId = shared.collaborators[0].id;
  cookie = monaCookie;
  assert.equal((await call('GET', '/api/admin/lists')).body.lists.find(x => x.id === mine).mine, true);
  assert.equal((await call('DELETE', `${share}/${reemId}`)).status, 200);
  cookie = reemCookie;
  assert.equal((await call('PATCH', '/api/admin/lists/' + mine, { name: 'Still mine?' })).status, 404);
  // a collaborator can also leave on their own
  cookie = monaCookie;
  await call('POST', share, { name: 'Reem' });
  cookie = reemCookie;
  assert.equal((await call('DELETE', `${share}/${reemId}`)).status, 200);
  assert.ok(!(await call('GET', '/api/admin/lists')).body.lists.some(x => x.id === mine));
  cookie = alaaCookie;
  // the admin can look at a user's lists
  const seen = await call('GET', `/api/admin/users/${mona.body.id}/lists`);
  assert.deepEqual([seen.status, seen.body.name, seen.body.lists.map(x => x.name)], [200, 'Mona', ['Mona list']]);
  assert.equal((await call('GET', '/api/admin/users/99999/lists')).status, 404);
  // ... and change them: rename, items, reservations, collaborators, delete
  assert.equal((await call('PATCH', '/api/admin/lists/' + mine, { name: 'Mona list', note: 'Fixed by the admin' })).status, 200);
  const fix = (await call('POST', `/api/admin/lists/${mine}/items`, { name: 'Bottle' })).body.id;
  assert.equal((await call('PATCH', '/api/admin/items/' + fix, { qty: 3 })).status, 200);
  await call('POST', `/api/l/${seen.body.lists[0].slug}/items/${fix}/reserve`, { name: 'Laila', mobile: '01055556666' }, { auth: false });
  const after = (await call('GET', `/api/admin/users/${mona.body.id}/lists`)).body.lists[0];
  assert.deepEqual([after.note, after.owner, after.items[0].qty], ['Fixed by the admin', 'Mona', 3]);
  assert.equal((await call('DELETE', '/api/admin/reservations/' + after.items[0].reservations[0].id)).status, 200);
  assert.equal((await call('DELETE', '/api/admin/items/' + fix)).status, 200);
  assert.equal((await call('POST', share, { name: 'Mona' })).status, 400); // she owns it
  assert.equal((await call('POST', share, { name: 'Reem' })).status, 201);
  assert.equal((await call('DELETE', `${share}/${reemId}`)).status, 200);
  const spare = (await call('POST', '/api/admin/lists', { name: 'Spare' })).body.id;
  cookie = monaCookie;
  assert.equal((await call('DELETE', '/api/admin/lists/' + spare)).status, 404);
  const hers = (await call('POST', '/api/admin/lists', { name: 'To remove' })).body.id;
  cookie = alaaCookie;
  assert.equal((await call('DELETE', '/api/admin/lists/' + hers)).status, 200);
  assert.equal((await call('DELETE', '/api/admin/lists/' + spare)).status, 200);
  const l = (await call('GET', '/api/admin/lists')).body.lists.find(x => x.id === theirs);
  assert.deepEqual([l.name, l.items[0].name, l.items[0].reservations.length], ['Alaa only', 'Stroller', 1]);
  assert.ok(!(await call('GET', '/api/admin/lists')).body.lists.some(x => x.id === mine));
});

test('lists from before accounts go to the first ADMIN_USERS account; ADMINS picks who is admin', async () => {
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

  // ADMIN_USERS="Islam:..,Alaa:.." with ADMINS="Islam": Alaa becomes a user and keeps her sign-in and lists
  const { readAdmins } = require('../src/admins');
  const accounts = readAdmins({ ADMIN_USERS: 'Islam:second pass,Alaa:correct horse', ADMINS: ' islam ' });
  assert.deepEqual(accounts.map(a => [a.name, a.admin]), [['Islam', true], ['Alaa', false]]);
  assert.ok(readAdmins({ ADMIN_USERS: 'Islam:second pass,Alaa:correct horse' }).every(a => a.admin));
  await db.query("INSERT INTO lists (slug, name, created_at) VALUES ('oldlist33', 'Older list', 1)");
  const s3 = await new Promise(r => { const s = createApp({ db, photos: openPhotos({ dir: path.join(dataDir, 'photos') }), admins: accounts }).listen(0, () => r(s)); });
  base = 'http://127.0.0.1:' + s3.address().port;
  try {
    assert.equal((await call('POST', '/api/admin/login', { name: 'Alaa', password: 'correct horse' })).body.isAdmin, false);
    const names = (await call('GET', '/api/admin/lists')).body.lists.map(l => l.name);
    assert.ok(names.includes('Old list') && names.includes('Older list') && names.includes('Alaa only'), names.join());
    assert.equal((await call('GET', '/api/admin/users')).status, 403);
    assert.equal((await call('POST', '/api/admin/login', { name: 'Islam', password: 'second pass' })).body.isAdmin, true);
    assert.deepEqual((await call('GET', '/api/admin/users')).body.users.filter(u => u.admin).map(u => u.name), ['Islam']);
  } finally { base = old; s3.close(); }
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

test('the app can ask which version is deployed', async () => {
  const v = await call('GET', '/api/version', null, { auth: false });
  assert.equal(v.status, 200);
  assert.match(v.body.version, /^[a-f0-9]{16}$/);
  assert.equal((await call('GET', '/api/version', null, { auth: false })).body.version, v.body.version);
});

test('the main address goes to the admin sign-in', async () => {
  const r = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin');
  assert.equal((await fetch(base + '/nope')).status, 404);
});
