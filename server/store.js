import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path, now = Date.now()) {
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
    // Keep the four-column devices table compatible with previous releases.
    // A side table also lets an old INSERT OR IGNORE refresh activity on rollback.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS device_activity (
          device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
          last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS device_activity_seen ON device_activity(last_seen_at, device_id);
        CREATE INDEX IF NOT EXISTS pairs_b ON pairs(b);
        CREATE TRIGGER IF NOT EXISTS device_legacy_activity BEFORE INSERT ON devices
        BEGIN
          UPDATE device_activity SET last_seen_at = MAX(last_seen_at, unixepoch() * 1000) WHERE device_id = NEW.id;
        END;
      `);
      this.db.prepare('INSERT OR IGNORE INTO device_activity SELECT id, ? FROM devices').run(now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
    this.deviceCount = this.db.prepare('SELECT COUNT(*) AS count FROM devices').get().count;
  }

  device(id) {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  }

  register(id, key, name, now) {
    this.db.exec('BEGIN IMMEDIATE');
    let added;
    try {
      added = this.db.prepare('INSERT OR IGNORE INTO devices (id, public_key, name, created_at) VALUES (?, ?, ?, ?)').run(id, key, name, now).changes;
      this.touch([id], now, true);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.deviceCount += added;
    return this.device(id);
  }

  touch(ids, now, withinTransaction = false) {
    const values = [...ids];
    if (!values.length) {
      return;
    }
    const statement = this.db.prepare('INSERT INTO device_activity VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at');
    if (!withinTransaction) {
      this.db.exec('BEGIN IMMEDIATE');
    }
    try {
      for (const id of values) {
        statement.run(id, now);
      }
      if (!withinTransaction) {
        this.db.exec('COMMIT');
      }
    } catch (error) {
      if (!withinTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw error;
    }
  }

  cleanup(before, protectedIds, limit = 500) {
    const candidates = this.db.prepare(`SELECT device_id FROM device_activity
      WHERE last_seen_at < ?
        AND NOT EXISTS (SELECT 1 FROM pairs WHERE a = device_id)
        AND NOT EXISTS (SELECT 1 FROM pairs WHERE b = device_id)
      ORDER BY last_seen_at, device_id LIMIT ?`).all(before, limit);
    let removed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.db.prepare(`DELETE FROM devices WHERE id = ?
        AND EXISTS (SELECT 1 FROM device_activity WHERE device_id = devices.id AND last_seen_at < ?)
        AND NOT EXISTS (SELECT 1 FROM pairs WHERE a = devices.id OR b = devices.id)`);
      for (const { device_id: id } of candidates) {
        if (!protectedIds.has(id)) {
          removed += statement.run(id, before).changes;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.deviceCount -= removed;
    return { candidates: candidates.length, removed };
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
