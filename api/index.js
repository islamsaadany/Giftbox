/* Vercel entry: every non-static request is routed here (see vercel.json). */
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');
const { openPhotos } = require('../src/photos');

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
const adminPassword = process.env.ADMIN_PASSWORD;

const missing = [
  !url && 'a Postgres database (DATABASE_URL)',
  !blobToken && 'a Blob store (BLOB_READ_WRITE_TOKEN)',
  !(adminPassword && adminPassword.length >= 8) && 'ADMIN_PASSWORD (at least 8 characters)',
].filter(Boolean);

module.exports = missing.length
  ? (req, res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Wishbox is not set up yet. In the Vercel project, add: ' + missing.join('; ') + '. Then redeploy.');
    }
  : createApp({ db: openDb({ url }), photos: openPhotos({ blobToken }), adminPassword, trustProxy: true });
