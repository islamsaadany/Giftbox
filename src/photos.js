/* Photo storage. With a Vercel Blob token photos go to Blob storage; otherwise to a local folder.
   save() returns a reference kept in items.photo; url() turns it into what the browser loads. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const randomName = () => crypto.randomBytes(12).toString('hex') + '.jpg';

/* A Blob store is created as either public or private, and an upload must match it.
   We try public first and fall back to private, remembering what worked.
   Public photos are loaded straight from Blob; private ones are served by this app at /photos/<name>. */
function blobPhotos(token) {
  const { put, del, get } = require('@vercel/blob');
  let mode = null; // 'public' | 'private', once known
  const upload = (name, buf, access) => put('photos/' + name, buf, {
    access, contentType: 'image/jpeg', addRandomSuffix: false, cacheControlMaxAge: 31536000, token,
  });
  return {
    async save(buf) {
      const name = randomName();
      let firstError;
      for (const access of mode ? [mode] : ['public', 'private']) {
        try {
          const r = await upload(name, buf, access);
          mode = access;
          return access === 'public' ? r.url : 'private:' + name;
        } catch (e) { firstError ||= e; }
      }
      throw firstError;
    },
    async remove(ref) {
      if (!ref) return;
      const target = ref.startsWith('private:') ? 'photos/' + ref.slice(8) : ref;
      await del(target, { token }).catch(e => console.error('photo delete failed', e.message));
    },
    url: ref => (!ref ? null : ref.startsWith('private:') ? '/photos/' + ref.slice(8) : ref),
    // For private stores: returns { stream, size } or null
    async read(name) {
      const r = await get('photos/' + name, { access: 'private', token });
      return r && r.statusCode === 200 ? { stream: r.stream, size: r.blob.size } : null;
    },
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
