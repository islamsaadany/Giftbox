/* Photo storage. With a Vercel Blob token photos go to Blob storage; otherwise to a local folder.
   save() returns a reference kept in items.photo; url() turns it into what the browser loads. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const randomName = () => crypto.randomBytes(12).toString('hex') + '.jpg';

function blobPhotos(token) {
  const { put, del } = require('@vercel/blob');
  return {
    async save(buf) {
      const r = await put('photos/' + randomName(), buf, {
        access: 'public', contentType: 'image/jpeg', addRandomSuffix: false, cacheControlMaxAge: 31536000, token,
      });
      return r.url;
    },
    async remove(ref) { if (ref && /^https:\/\//.test(ref)) await del(ref, { token }).catch(e => console.error('photo delete failed', e.message)); },
    url: ref => ref || null,
  };
}

function diskPhotos(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    async save(buf) { const name = randomName(); await fs.promises.writeFile(path.join(dir, name), buf); return name; },
    async remove(ref) { if (ref && /^[a-f0-9]+\.jpg$/.test(ref)) await fs.promises.rm(path.join(dir, ref), { force: true }); },
    url: ref => (ref ? '/photos/' + ref : null),
  };
}

const openPhotos = ({ blobToken, dir }) => (blobToken ? blobPhotos(blobToken) : diskPhotos(dir));

module.exports = { openPhotos };
