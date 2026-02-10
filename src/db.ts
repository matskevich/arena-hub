import Database from 'better-sqlite3';
import { Event, Token, AuditEntry } from './types.js';

let db: Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_room_id ON events(room, id);

CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '*',
  rate_burst INTEGER NOT NULL DEFAULT 10,
  rate_hour INTEGER NOT NULL DEFAULT 1000,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
);
`;

export function initDb(path: string): Database.Database {
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('db not initialized');
  return db;
}

// --- Events ---

export function insertEvent(room: string, author: string, kind: string, payload: string, tokenId: number): Event {
  const stmt = getDb().prepare(
    'INSERT INTO events (room, author, kind, payload, token_id) VALUES (?, ?, ?, ?, ?)'
  );
  const result = stmt.run(room, author, kind, payload, tokenId);
  return getDb().prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid) as Event;
}

export function getEventsSince(sinceId: number, rooms?: string[]): Event[] {
  if (rooms && rooms.length > 0) {
    const placeholders = rooms.map(() => '?').join(',');
    return getDb().prepare(
      `SELECT * FROM events WHERE id > ? AND room IN (${placeholders}) ORDER BY id ASC`
    ).all(sinceId, ...rooms) as Event[];
  }
  return getDb().prepare(
    'SELECT * FROM events WHERE id > ? ORDER BY id ASC'
  ).all(sinceId) as Event[];
}

// --- Tokens ---

export function insertToken(name: string, hash: string, scopes: string, rateBurst: number, rateHour: number, expiresAt: string | null): Token {
  const stmt = getDb().prepare(
    'INSERT INTO tokens (name, hash, scopes, rate_burst, rate_hour, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(name, hash, scopes, rateBurst, rateHour, expiresAt);
  return getDb().prepare('SELECT * FROM tokens WHERE id = ?').get(result.lastInsertRowid) as Token;
}

export function findTokenByHash(hash: string): Token | undefined {
  return getDb().prepare('SELECT * FROM tokens WHERE hash = ?').get(hash) as Token | undefined;
}

export function revokeToken(id: number): void {
  getDb().prepare(
    "UPDATE tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%f','now') WHERE id = ?"
  ).run(id);
}

export function listTokens(): Token[] {
  return getDb().prepare('SELECT * FROM tokens ORDER BY id ASC').all() as Token[];
}

export function getToken(id: number): Token | undefined {
  return getDb().prepare('SELECT * FROM tokens WHERE id = ?').get(id) as Token | undefined;
}

// --- Audit ---

export function auditLog(action: string, detail?: string): void {
  getDb().prepare('INSERT INTO audit_log (action, detail) VALUES (?, ?)').run(action, detail ?? null);
}

export function getAuditLog(limit = 100): AuditEntry[] {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as AuditEntry[];
}
