/* Vercel entry: every non-static request is routed here (see vercel.json). */
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');
const { openPhotos } = require('../src/photos');
const { readAdmins } = require('../src/admins');

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
const admins = readAdmins(process.env);

const missing = [
  !url && 'a Postgres database (DATABASE_URL)',
  !blobToken && 'a Blob store (BLOB_READ_WRITE_TOKEN)',
  !admins.length && 'ADMIN_USERS (for example: Alaa:password)',
].filter(Boolean);

module.exports = missing.length
  ? (req, res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Wishbox is not set up yet. In the Vercel project, add: ' + missing.join('; ') + '. Then redeploy.');
    }
  : createApp({ db: openDb({ url }), photos: openPhotos({ blobToken }), admins, trustProxy: true });
