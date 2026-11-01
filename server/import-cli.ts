// Usage: node server/import-cli.ts <vikunja-export.zip> [--force]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { importVikunja } from './importer.ts';

const [zip, flag] = process.argv.slice(2);
if (!zip) throw new Error('Usage: node server/import-cli.ts <vikunja-export.zip> [--force]');
const dataDir = process.env.DATA_DIR ?? '/data';
console.log(importVikunja(openDb(join(dataDir, 'samunja.db')), dataDir, readFileSync(zip), { force: flag === '--force' }));
