import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EJSON } from 'bson';
import { db, flush, close } from '../db.js';

await flush();
const collections = {};
for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
  collections[name] = await db.collection(name).find({}).toArray();
}
const directory = path.resolve('backups');
mkdirSync(directory, { recursive: true });
const destination = path.join(directory, `beauty-baby-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);
writeFileSync(destination, EJSON.stringify({ database: db.databaseName, createdAt: new Date(), collections }, null, 2));
await close();
console.log(`MongoDB backup created at ${destination}`);
