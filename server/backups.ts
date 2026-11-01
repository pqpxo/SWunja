// Backups: a consistent SQLite snapshot (VACUUM INTO) plus the attachment files, one zip per run, oldest pruned.
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { HttpError } from './services.ts';

export type BackupSettings = { enabled: boolean; hour: number; keep: number };
const DEFAULTS: BackupSettings = { enabled: true, hour: 3, keep: 14 };
const NAME = /^(samunja|swunja)-backup-\d{8}-\d{6}\.zip$/; // backups from before the rename keep their name

/** Where backups go: BACKUP_DIR (e.g. a NAS mount) or <data>/backups. */
export const backupDir = (dataDir: string) => process.env.BACKUP_DIR || join(dataDir, 'backups');

export function getBackupSettings(db: DatabaseSync): BackupSettings {
  const r = db.prepare("SELECT value FROM meta WHERE key='backup_settings'").get() as { value: string } | undefined;
  return { ...DEFAULTS, ...(r ? JSON.parse(r.value) : {}) };
}

export function setBackupSettings(db: DatabaseSync, d: Partial<BackupSettings>): BackupSettings {
  const next = { ...getBackupSettings(db) };
  if (d.enabled !== undefined) next.enabled = !!d.enabled;
  if (d.hour !== undefined) {
    if (!Number.isInteger(d.hour) || d.hour < 0 || d.hour > 23) throw new HttpError(400, 'hour must be 0-23');
    next.hour = d.hour;
  }
  if (d.keep !== undefined) {
    if (!Number.isInteger(d.keep) || d.keep < 1 || d.keep > 365) throw new HttpError(400, 'keep must be 1-365');
    next.keep = d.keep;
  }
  db.prepare("INSERT INTO meta VALUES ('backup_settings', ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
  return next;
}

export type Backup = { name: string; size: number; created: string };

export function listBackups(dataDir: string): Backup[] {
  const dir = backupDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => NAME.test(n))
    .map(n => { const st = statSync(join(dir, n)); return { name: n, size: st.size, created: st.mtime.toISOString() }; })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** The only way to address a backup file: a name in our own format (no paths). */
export function backupPath(dataDir: string, name: string): string {
  if (!NAME.test(name)) throw new HttpError(400, 'Not a backup name');
  const p = join(backupDir(dataDir), name);
  if (!existsSync(p)) throw new HttpError(404, 'Backup not found');
  return p;
}

export function createBackup(db: DatabaseSync, dataDir: string, now = new Date()): Backup {
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const tmp = join(dir, `.snapshot-${stamp}.db`);
  rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const files: Record<string, Uint8Array> = { 'samunja.db': readFileSync(tmp) };
  const filesDir = join(dataDir, 'files');
  if (existsSync(filesDir)) for (const f of readdirSync(filesDir)) files[`files/${f}`] = readFileSync(join(filesDir, f));
  files['RESTORE.txt'] = new TextEncoder().encode(
    'To restore: stop SWunja, replace samunja.db (and delete samunja.db-wal / -shm) and the files/ folder in the data volume with these, then start it again.\n');
  rmSync(tmp, { force: true });
  const name = `swunja-backup-${stamp}.zip`;
  writeFileSync(join(dir, name), zipSync(files, { level: 6 }));
  db.prepare("INSERT INTO meta VALUES ('backup_last', ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(now.toISOString());
  pruneBackups(dataDir, getBackupSettings(db).keep);
  return listBackups(dataDir).find(b => b.name === name)!;
}

export function pruneBackups(dataDir: string, keep: number) {
  for (const b of listBackups(dataDir).slice(keep)) rmSync(join(backupDir(dataDir), b.name), { force: true });
}

export const deleteBackup = (dataDir: string, name: string) => rmSync(backupPath(dataDir, name));

/** Called by the scheduler: one backup per day, at or after the chosen hour (server local time). */
export function backupIfDue(db: DatabaseSync, dataDir: string, now = new Date()): Backup | null {
  const st = getBackupSettings(db);
  if (!st.enabled || now.getHours() < st.hour) return null;
  const last = (db.prepare("SELECT value FROM meta WHERE key='backup_last'").get() as { value: string } | undefined)?.value;
  if (last && new Date(last).toDateString() === now.toDateString()) return null;
  return createBackup(db, dataDir, now);
}
