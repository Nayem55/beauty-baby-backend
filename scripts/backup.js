import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { databasePath } from '../db.js';
const dir=path.resolve('backups');mkdirSync(dir,{recursive:true});
const destination=path.join(dir,`beauty-baby-${new Date().toISOString().replaceAll(/[:.]/g,'-')}.sqlite`);
copyFileSync(databasePath,destination);console.log(`Database backup created at ${destination}`);
