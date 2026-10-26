'use strict';
// SQLite storage backend using Node's built-in node:sqlite (Node 22.5 or later; no package needed).
// Node prints an ExperimentalWarning the first time node:sqlite loads.
//
//   "storage": { "backends": [{ "type": "module", "path": "./storage/examples/sqlite.js", "file": ".cache/opspulse.db" }] }
//
// `file` is relative to the config file's directory.

const path = require('path');
const fs = require('fs');

function createStorage(options) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.resolve(options.baseDir || process.cwd(), options.file || '.cache/opspulse.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');

  // Statements are prepared from `db` on each call so the backend keeps `db` referenced; a database
  // nobody references is garbage-collected, which finalizes its statements.
  return {
    name: `sqlite ${options.file || '.cache/opspulse.db'}`,
    db,
    async get(key) {
      const row = db.prepare('SELECT value FROM documents WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : null;
    },
    async set(key, value) {
      db.prepare('INSERT INTO documents (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(key, JSON.stringify(value), new Date().toISOString());
    },
    async delete(key) {
      db.prepare('DELETE FROM documents WHERE key = ?').run(key);
    },
  };
}

module.exports = { createStorage };
