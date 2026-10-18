import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, public_key TEXT NOT NULL,
        name TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairs (
        a TEXT NOT NULL REFERENCES devices(id), b TEXT NOT NULL REFERENCES devices(id),
        last_used INTEGER NOT NULL, PRIMARY KEY(a,b), CHECK(a < b)
      );
    `);
  }

  device(id) {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  }

  register(id, key, name, now) {
    this.db.prepare('INSERT OR IGNORE INTO devices VALUES (?, ?, ?, ?)').run(id, key, name, now);
    return this.device(id);
  }

  rename(id, name) {
    this.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, id);
  }

  pair(a, b, now) {
    [a, b] = [a, b].sort();
    this.db.prepare('INSERT INTO pairs VALUES (?, ?, ?) ON CONFLICT(a,b) DO UPDATE SET last_used = excluded.last_used').run(a, b, now);
  }

  relationship(a, b) {
    [a, b] = [a, b].sort();
    return this.db.prepare('SELECT * FROM pairs WHERE a = ? AND b = ?').get(a, b);
  }

  removePair(a, b) {
    [a, b] = [a, b].sort();
    this.db.prepare('DELETE FROM pairs WHERE a = ? AND b = ?').run(a, b);
  }

  peers(id) {
    return this.db.prepare(`SELECT d.id, d.name, p.last_used AS lastUsed
      FROM pairs p JOIN devices d ON d.id = CASE WHEN p.a = ? THEN p.b ELSE p.a END
      WHERE (p.a = ? OR p.b = ?) ORDER BY d.created_at, d.id`).all(id, id, id);
  }

  close() {
    this.db.close();
  }
}
