// Google Drive copies of the nightly backups (off-host, so they survive if server1 fails).
// Sign-in is Google's TV / limited-input flow (a code entered at google.com/device) with the drive.file scope:
// SWunja can only see files it created. Only the refresh token and client secret are kept, write-only, in `secrets`.
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { backupPath, listBackups } from './backups.ts';
import { getSecret, putSecret } from './notify.ts';
import { HttpError } from './services.ts';

export type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;
type Opt = { fetchFn?: FetchFn };
type Stored = {
  client_id?: string; keep?: number; folder_id?: string;
  last_upload?: { name: string; at: string } | null; last_error?: string | null; failed_at?: number | null; device?: { code: string; expires: string } | null;
};
export type DriveInfo = {
  client_id: string; has_secret: boolean; connected: boolean; folder_name: string; keep: number;
  last_upload: { name: string; at: string } | null; last_error: string | null; waiting: boolean;
};

const FOLDER = 'SWunja Backups';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

const load = (db: DatabaseSync): Stored => JSON.parse((db.prepare("SELECT value FROM meta WHERE key='gdrive'").get() as { value: string } | undefined)?.value ?? '{}');
const save = (db: DatabaseSync, patch: Stored) =>
  db.prepare("INSERT INTO meta VALUES ('gdrive', ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(JSON.stringify({ ...load(db), ...patch }));

export function getDrive(db: DatabaseSync): DriveInfo {
  const s = load(db);
  return {
    client_id: s.client_id ?? '', has_secret: !!getSecret(db, 'gdrive_secret'), connected: !!getSecret(db, 'gdrive_refresh'),
    folder_name: FOLDER, keep: s.keep ?? 14, last_upload: s.last_upload ?? null, last_error: s.last_error ?? null,
    waiting: !!s.device && Date.parse(s.device.expires) > Date.now(),
  };
}

/** Client ID / secret (from Google Cloud) and how many copies to keep. A blank secret keeps the saved one. */
export function setDrive(db: DatabaseSync, d: { client_id?: string; client_secret?: string | null; keep?: number }) {
  if (d.keep !== undefined && !(Number.isInteger(d.keep) && d.keep >= 1 && d.keep <= 365)) throw new HttpError(400, 'keep must be between 1 and 365');
  if (d.client_id !== undefined) save(db, { client_id: d.client_id.trim() });
  if (d.keep !== undefined) save(db, { keep: d.keep });
  putSecret(db, 'gdrive_secret', d.client_secret === null ? null : d.client_secret?.trim());
  return getDrive(db);
}

async function post(fetchFn: FetchFn, url: string, form: Record<string, string>) {
  const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

function credentials(db: DatabaseSync) {
  const id = load(db).client_id, secret = getSecret(db, 'gdrive_secret');
  if (!id || !secret) throw new HttpError(400, 'Save the Google client ID and secret first');
  return { client_id: id, client_secret: secret };
}

/** Step 1 of connecting: Google gives a short code for the person to enter at google.com/device. */
export async function connectStart(db: DatabaseSync, o: Opt = {}) {
  const fetchFn = o.fetchFn ?? fetch;
  const { client_id } = credentials(db);
  const r = await post(fetchFn, 'https://oauth2.googleapis.com/device/code', { client_id, scope: SCOPE });
  if (r.status !== 200) throw new HttpError(400, `Google refused: ${r.body.error_description ?? r.body.error ?? r.status} (check the client ID, and that its type is "TVs and Limited Input devices")`);
  save(db, { device: { code: r.body.device_code, expires: new Date(Date.now() + r.body.expires_in * 1000).toISOString() } });
  return { user_code: r.body.user_code as string, verification_url: (r.body.verification_url ?? r.body.verification_uri) as string, interval: r.body.interval as number ?? 5 };
}

/** Step 2: asked every few seconds by the page until the person has approved (or it expires). */
export async function connectFinish(db: DatabaseSync, o: Opt = {}): Promise<{ status: 'waiting' | 'connected' | 'denied' | 'expired' }> {
  const fetchFn = o.fetchFn ?? fetch;
  const device = load(db).device;
  if (!device) return { status: 'expired' };
  const r = await post(fetchFn, TOKEN_URL, { ...credentials(db), device_code: device.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  if (r.body.refresh_token) {
    putSecret(db, 'gdrive_refresh', r.body.refresh_token);
    cache = { refresh: r.body.refresh_token, token: r.body.access_token, until: Date.now() + (r.body.expires_in - 60) * 1000 };
    save(db, { device: null, last_error: null, folder_id: undefined });
    return { status: 'connected' };
  }
  if (r.body.error === 'authorization_pending' || r.body.error === 'slow_down') return { status: 'waiting' };
  save(db, { device: null });
  return { status: r.body.error === 'access_denied' ? 'denied' : 'expired' };
}

let cache: { refresh: string; token: string; until: number } | null = null;

async function accessToken(db: DatabaseSync, fetchFn: FetchFn): Promise<string> {
  const refresh = getSecret(db, 'gdrive_refresh');
  if (!refresh) throw new HttpError(400, 'Google Drive is not connected');
  if (cache?.refresh === refresh && cache.until > Date.now()) return cache.token;
  const r = await post(fetchFn, TOKEN_URL, { ...credentials(db), grant_type: 'refresh_token', refresh_token: refresh });
  if (r.status !== 200) throw new Error(`Google sign-in failed (${r.body.error ?? r.status}); connect again`);
  cache = { refresh, token: r.body.access_token, until: Date.now() + (r.body.expires_in - 60) * 1000 };
  return cache.token;
}

async function drive(fetchFn: FetchFn, token: string, url: string, init: RequestInit = {}) {
  const r = await fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Google Drive ${r.status}: ${((await r.json().catch(() => ({}))) as any).error?.message ?? r.statusText}`);
  return r;
}

async function folderId(db: DatabaseSync, fetchFn: FetchFn, token: string): Promise<string> {
  const known = load(db).folder_id;
  if (known) return known;
  const r = await drive(fetchFn, token, DRIVE, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const id = ((await r.json()) as { id: string }).id;
  save(db, { folder_id: id });
  return id;
}

/**
 * Uploads the newest local backup if it hasn't been uploaded yet, then keeps only the newest `keep` copies in Drive.
 * Never throws (it runs in the background job): failures are recorded and retried on the next run.
 */
export async function uploadIfNew(db: DatabaseSync, dataDir: string, o: Opt & { force?: boolean } = {}): Promise<{ name: string } | null> {
  const fetchFn = o.fetchFn ?? fetch;
  if (!getSecret(db, 'gdrive_refresh')) return null;
  const newest = listBackups(dataDir)[0];
  const s = load(db);
  if (!newest || (!o.force && s.last_upload?.name === newest.name)) return null;
  try {
    const token = await accessToken(db, fetchFn);
    const parent = await folderId(db, fetchFn, token);
    const start = await drive(fetchFn, token, `${UPLOAD}?uploadType=resumable`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/zip' },
      body: JSON.stringify({ name: newest.name, parents: [parent] }),
    });
    const location = start.headers.get('location');
    if (!location) throw new Error('Google Drive did not return an upload address');
    await drive(fetchFn, token, location, { method: 'PUT', headers: { 'content-type': 'application/zip' }, body: readFileSync(backupPath(dataDir, newest.name)) });
    const q = encodeURIComponent(`'${parent}' in parents and trashed = false`);
    const list = (await (await drive(fetchFn, token, `${DRIVE}?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime)&pageSize=1000`)).json()) as { files: { id: string }[] };
    for (const f of list.files.slice(s.keep ?? 14)) await drive(fetchFn, token, `${DRIVE}/${f.id}`, { method: 'DELETE' });
    save(db, { last_upload: { name: newest.name, at: new Date().toISOString() }, last_error: null, failed_at: null });
    return { name: newest.name };
  } catch (e) {
    save(db, { last_error: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${(e as Error).message}`.slice(0, 300), failed_at: Date.now() });
    return null;
  }
}

/** The background job (every minute): uploads a new backup, but waits 15 minutes after a failure before trying again. */
export async function uploadJob(db: DatabaseSync, dataDir: string, o: Opt & { now?: number } = {}) {
  const failed = load(db).failed_at;
  if (failed && (o.now ?? Date.now()) - failed < 15 * 60_000) return null;
  return uploadIfNew(db, dataDir, o);
}

/** Forgets the tokens (and asks Google to revoke them). The copies already in Drive stay. */
export async function disconnect(db: DatabaseSync, o: Opt = {}) {
  const fetchFn = o.fetchFn ?? fetch;
  const refresh = getSecret(db, 'gdrive_refresh');
  if (refresh) await fetchFn(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => {});
  putSecret(db, 'gdrive_refresh', null);
  cache = null;
  save(db, { folder_id: undefined, device: null, last_error: null });
  return getDrive(db);
}
