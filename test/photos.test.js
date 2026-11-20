/* Blob photo storage against a stand-in for @vercel/blob that behaves like a public or a private store. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function withFakeBlob(storeAccess, fn) {
  const files = new Map();
  const fake = {
    async put(pathname, buf, o) {
      if (o.access !== storeAccess) throw new Error(`Cannot use ${o.access} access on a ${storeAccess} store`);
      files.set(pathname, buf);
      return { url: 'https://abc.' + storeAccess + '.blob.vercel-storage.com/' + pathname };
    },
    async del(target) { files.delete(target.replace(/^https:\/\/[^/]+\//, '')); },
    async get(pathname) {
      const b = files.get(pathname);
      return b ? { statusCode: 200, stream: new Blob([b]).stream(), blob: { size: b.length } } : null;
    },
  };
  const real = Module._load;
  Module._load = (req, ...rest) => (req === '@vercel/blob' ? fake : real(req, ...rest));
  delete require.cache[require.resolve('../src/photos')];
  const photos = require('../src/photos').openPhotos({ blobToken: 'x' });
  Module._load = real;
  return fn(photos, files);
}

test('public store: photo URL points straight at Blob', () => withFakeBlob('public', async (photos, files) => {
  const ref = await photos.save(Buffer.from('jpg'));
  assert.match(photos.url(ref), /^https:\/\/abc\.public\.blob\.vercel-storage\.com\/photos\/[a-f0-9]{24}\.jpg$/);
  await photos.remove(ref);
  assert.equal(files.size, 0);
}));

test('private store: falls back, and the app serves the photo', () => withFakeBlob('private', async (photos, files) => {
  const ref = await photos.save(Buffer.from('jpg'));
  const url = photos.url(ref);
  assert.match(url, /^\/photos\/[a-f0-9]{24}\.jpg$/);
  const f = await photos.read(url.split('/')[2]);
  assert.equal(await new Response(f.stream).text(), 'jpg');
  assert.equal(await photos.read('0'.repeat(24) + '.jpg'), null);
  await photos.remove(ref);
  assert.equal(files.size, 0);
}));
