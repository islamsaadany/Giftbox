/* Postgres access. With a connection string it uses a real Postgres (Neon, Vercel Postgres, ...);
   without one it runs an embedded Postgres (PGlite) for local development and tests. */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    name_key      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    BIGINT NOT NULL
  );
  ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'pink';
  CREATE TABLE IF NOT EXISTS lists (
    id         SERIAL PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  );
  ALTER TABLE lists ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS lists_user ON lists(user_id);
  -- Each list has its own colour. Lists from when the colour belonged to the user keep the colour their owner had;
  -- new lists are created with a colour, so this only ever touches those older rows.
  ALTER TABLE lists ADD COLUMN IF NOT EXISTS theme TEXT;
  UPDATE lists SET theme = COALESCE((SELECT u.theme FROM users u WHERE u.id = lists.user_id), 'pink') WHERE theme IS NULL;
  CREATE TABLE IF NOT EXISTS list_collaborators (
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (list_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS list_collaborators_user ON list_collaborators(user_id);
  CREATE TABLE IF NOT EXISTS items (
    id         SERIAL PRIMARY KEY,
    list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    price_egp  DOUBLE PRECISION,
    quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
    shop_url   TEXT,
    photo      TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_list ON items(list_id);
  CREATE TABLE IF NOT EXISTS reservations (
    id           SERIAL PRIMARY KEY,
    item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    guest_name   TEXT NOT NULL,
    guest_mobile TEXT NOT NULL,
    count        INTEGER NOT NULL CHECK (count >= 1),
    created_at   BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reservations_item ON reservations(item_id);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at BIGINT NOT NULL
  );
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS admin_name TEXT;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  CREATE TABLE IF NOT EXISTS login_failures (
    ip TEXT NOT NULL,
    at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS login_failures_ip ON login_failures(ip, at);
`;

/* Both drivers are wrapped to the same shape:
     query(sql, params) -> { rows, count }
     tx(async q => ...) -> runs q(sql, params) calls in one transaction */

function pgDb(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 3 });
  const shape = r => ({ rows: r.rows, count: r.rowCount });
  return {
    query: async (sql, params) => shape(await pool.query(sql, params)),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(async (sql, params) => shape(await c.query(sql, params)));
        await c.query('COMMIT');
        return out;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
    init: () => pool.query(SCHEMA),
    close: () => pool.end(),
  };
}

function embeddedDb(dir) {
  const { PGlite } = require('@electric-sql/pglite');
  const db = dir ? new PGlite(dir) : new PGlite();
  const shape = r => ({ rows: r.rows, count: r.affectedRows ?? 0 });
  return {
    query: async (sql, params) => shape(await db.query(sql, params)),
    tx: fn => db.transaction(t => fn(async (sql, params) => shape(await t.query(sql, params)))),
    init: () => db.exec(SCHEMA),
    close: () => db.close(),
  };
}

function openDb({ url, dir } = {}) {
  const db = url ? pgDb(url) : embeddedDb(dir);
  let ready;
  // Create the tables once per process; retry on the next request if it failed
  db.ready = () => (ready ||= Promise.resolve(db.init()).catch(e => { ready = null; throw e; }));
  return db;
}

module.exports = { openDb };
