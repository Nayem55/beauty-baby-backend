import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const databasePath = path.resolve(process.env.DATABASE_PATH || 'data/beauty-baby.sqlite');
mkdirSync(path.dirname(databasePath), { recursive: true });
export const db = new DatabaseSync(databasePath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id));
CREATE UNIQUE INDEX IF NOT EXISTS product_slug ON records(json_extract(data,'$.slug')) WHERE kind='products';
CREATE UNIQUE INDEX IF NOT EXISTS product_sku ON records(json_extract(data,'$.sku')) WHERE kind='products';
CREATE UNIQUE INDEX IF NOT EXISTS user_email ON records(json_extract(data,'$.email')) WHERE kind='users';
CREATE UNIQUE INDEX IF NOT EXISTS coupon_code ON records(json_extract(data,'$.code')) WHERE kind='coupons';
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, order_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL);
PRAGMA user_version=1;`);
export const uid = () => randomUUID();
export const all = kind => db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(r => JSON.parse(r.data));
export const get = (kind, id) => { const r = db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id); return r ? JSON.parse(r.data) : undefined; };
export function put(kind, value) { const v = { ...value, id: value.id || uid(), updatedAt: new Date().toISOString(), createdAt: value.createdAt || new Date().toISOString() }; db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,v.id,JSON.stringify(v)); return v; }
export const remove = (kind,id) => db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);
export function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } }
export function audit(user, action, detail) { put('audit', { actor: user?.email || 'system', action, detail }); }
export const settings = () => get('settings','store');
