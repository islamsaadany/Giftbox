const path = require('node:path');
const { createApp } = require('./src/app');

const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword || adminPassword.length < 8) {
  console.error('Set ADMIN_PASSWORD (at least 8 characters) before starting Wishbox.');
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const port = Number(process.env.PORT) || 3000;
const app = createApp({ dataDir, adminPassword });

const server = app.listen(port, () => console.log(`Wishbox on http://localhost:${port}  (admin: /admin, data: ${dataDir})`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => { app.locals.db.close(); process.exit(0); }));
