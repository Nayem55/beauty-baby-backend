import { MongoClient } from 'mongodb';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/beauty-baby';
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
const databaseName = new URL(uri).pathname.slice(1) || 'beauty-baby';
export const db = client.db(databaseName);
export const databasePath = path.resolve(process.env.DATABASE_PATH || 'data/beauty-baby.sqlite');
export const uid = () => randomUUID();

const systemCollections = new Set(['sessions', 'idempotency', 'rate_limits']);
const records = new Map();
const sessions = new Map();
const idempotency = new Map();
const rateLimits = new Map();
let pending = [];
let flushChain = Promise.resolve();

const clone = value => structuredClone(value);
const memory = kind => {
  if (!records.has(kind)) records.set(kind, new Map());
  return records.get(kind);
};
const queue = (name, operation) => pending.push({ name, operation });
const stripId = ({ _id, ...value }) => value;

async function hasStoreData() {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections) {
    if (!systemCollections.has(name) && name !== 'records' && await db.collection(name).estimatedDocumentCount()) return true;
  }
  return false;
}

async function migrateLegacyRecords() {
  const legacy = db.collection('records');
  if (!await legacy.estimatedDocumentCount()) return false;
  const rows = await legacy.find({}).toArray();
  for (const row of rows) {
    const value = { ...row.data, id: row.id || row.data.id };
    await db.collection(row.kind).replaceOne({ _id: value.id }, { _id: value.id, ...value }, { upsert: true });
  }
  await legacy.drop();
  console.log(`Moved ${rows.length} legacy records into standard MongoDB collections.`);
  return true;
}

async function importSqliteIfNeeded() {
  if (await hasStoreData()) return;
  const source = databasePath;
  if (!existsSync(source)) return;
  const sqlite = new DatabaseSync(source, { readOnly: true });
  try {
    const rows = sqlite.prepare('SELECT kind,id,data FROM records ORDER BY rowid ASC').all();
    for (const row of rows) {
      const value = { ...JSON.parse(row.data), id: row.id };
      await db.collection(row.kind).replaceOne({ _id: value.id }, { _id: value.id, ...value }, { upsert: true });
    }
    const keys = sqlite.prepare('SELECT key,fingerprint,order_id FROM idempotency').all();
    for (const row of keys) await db.collection('idempotency').replaceOne({ _id: row.key }, { _id: row.key, fingerprint: row.fingerprint, orderId: row.order_id }, { upsert: true });
    if (rows.length) console.log(`Imported ${rows.length} Beauty & baby records from SQLite into MongoDB.`);
  } finally {
    sqlite.close();
  }
}

export async function connect() {
  await client.connect();
  await migrateLegacyRecords();
  await importSqliteIfNeeded();
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections) {
    if (systemCollections.has(name) || name === 'records') continue;
    for (const document of await db.collection(name).find({}).sort({ createdAt: 1 }).toArray()) {
      const value = stripId(document);
      memory(name).set(value.id, value);
    }
  }
  for (const row of await db.collection('sessions').find({}).toArray()) sessions.set(row._id, row);
  for (const row of await db.collection('idempotency').find({}).toArray()) idempotency.set(row._id, row);
  for (const row of await db.collection('rate_limits').find({}).toArray()) rateLimits.set(row._id, row);
  await db.collection('products').createIndex({ slug: 1 }, { unique: true });
  await db.collection('products').createIndex({ sku: 1 }, { unique: true });
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('coupons').createIndex({ code: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
  console.log(`MongoDB connected: ${databaseName}`);
}

export const all = kind => [...memory(kind).values()].reverse().map(clone);
export const get = (kind, id) => {
  const value = memory(kind).get(id);
  return value === undefined ? undefined : clone(value);
};
export function put(kind, value) {
  const now = new Date().toISOString();
  const v = JSON.parse(JSON.stringify({ ...value, id: value.id || uid(), updatedAt: now, createdAt: value.createdAt || now }));
  memory(kind).set(v.id, clone(v));
  queue(kind, { replaceOne: { filter: { _id: v.id }, replacement: { _id: v.id, ...v }, upsert: true } });
  return clone(v);
}
export function remove(kind, id) {
  memory(kind).delete(id);
  queue(kind, { deleteOne: { filter: { _id: id } } });
}
export function transaction(fn) {
  const snapshot = new Map([...records].map(([kind, bucket]) => [kind, new Map([...bucket].map(([id, value]) => [id, clone(value)]))]));
  const keySnapshot = new Map(idempotency);
  const queued = pending.length;
  try { return fn(); }
  catch (error) {
    records.clear();
    for (const [kind, bucket] of snapshot) records.set(kind, bucket);
    idempotency.clear();
    for (const [key, value] of keySnapshot) idempotency.set(key, value);
    pending.length = queued;
    throw error;
  }
}
export function flush() {
  const batch = pending.splice(0);
  if (!batch.length) return flushChain;
  flushChain = flushChain.catch(() => {}).then(async () => {
    for (const { name, operation } of batch) await db.collection(name).bulkWrite([operation], { ordered: true });
  });
  return flushChain;
}
export const audit = (user, action, detail) => put('audit', { actor: user?.email || 'system', action, detail });
export const settings = () => get('settings', 'store');

export function createSession(hash, userId, expires) {
  const value = { _id: hash, userId, expires: new Date(expires) };
  sessions.set(hash, value);
  queue('sessions', { replaceOne: { filter: { _id: hash }, replacement: value, upsert: true } });
}
export function findSession(hash) {
  const value = sessions.get(hash);
  return value && value.expires.getTime() > Date.now() ? value : undefined;
}
export function deleteSession(hash) {
  sessions.delete(hash);
  queue('sessions', { deleteOne: { filter: { _id: hash } } });
}
export function deleteUserSessions(userId) {
  for (const [hash, value] of sessions) if (value.userId === userId) sessions.delete(hash);
  queue('sessions', { deleteMany: { filter: { userId } } });
}
export function consumeRateLimit(key, max, window) {
  const now = Date.now();
  const previous = rateLimits.get(key);
  const value = !previous || previous.reset <= now ? { _id: key, count: 1, reset: now + window } : { ...previous, count: previous.count + 1 };
  if (previous && previous.reset > now && previous.count >= max) return { allowed: false, retryAfter: Math.ceil((previous.reset - now) / 1000) };
  rateLimits.set(key, value);
  queue('rate_limits', { replaceOne: { filter: { _id: key }, replacement: value, upsert: true } });
  return { allowed: true };
}
export const getIdempotency = key => idempotency.get(key);
export function putIdempotency(key, fingerprint, orderId) {
  const value = { _id: key, fingerprint, orderId };
  idempotency.set(key, value);
  queue('idempotency', { replaceOne: { filter: { _id: key }, replacement: value, upsert: true } });
}
export const close = () => client.close();

await connect();
