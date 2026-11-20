const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'photos'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'wishbox.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS lists (
      id         INTEGER PRIMARY KEY,
      slug       TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      id         INTEGER PRIMARY KEY,
      list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      price_egp  REAL,
      quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
      shop_url   TEXT,
      photo      TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS items_list ON items(list_id);
    CREATE TABLE IF NOT EXISTS reservations (
      id           INTEGER PRIMARY KEY,
      item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      guest_name   TEXT NOT NULL,
      guest_mobile TEXT NOT NULL,
      count        INTEGER NOT NULL CHECK (count >= 1),
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reservations_item ON reservations(item_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

module.exports = { openDb };
