/* Local development server. On Vercel the app runs from api/index.js instead. */
const path = require('node:path');
const { createApp } = require('./src/app');
const { openDb } = require('./src/db');
const { openPhotos } = require('./src/photos');
const { readAdmins } = require('./src/admins');

const admins = readAdmins(process.env);

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const db = openDb({ url, dir: path.join(dataDir, 'pg') });
const photos = openPhotos({ blobToken: process.env.BLOB_READ_WRITE_TOKEN, dir: path.join(dataDir, 'photos') });
const port = Number(process.env.PORT) || 3000;

const server = createApp({ db, photos, admins }).listen(port, () =>
  console.log(`Wishbox on http://localhost:${port}  (sign in: /admin, database: ${url ? 'Postgres' : 'local, in ' + dataDir})`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(async () => { await db.close().catch(() => {}); process.exit(0); }));
