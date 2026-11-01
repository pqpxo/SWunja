import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { createBackup } from './backups.ts';
import { connectFinish, connectStart, disconnect, getDrive, setDrive, uploadIfNew, uploadJob, type FetchFn } from './gdrive.ts';

/** A pretend Google: device sign-in, token refresh, Drive folder + resumable upload + list + delete. Records every call. */
function fakeGoogle(o: { approveAfter?: number; failUpload?: boolean } = {}) {
  const calls: string[] = [];
  const files: { id: string; name: string; parent: string; createdTime: string }[] = [];
  let polls = 0, n = 0;
  const json = (status: number, body: object, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetchFn: FetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push(`${init.method ?? 'GET'} ${u.host}${u.pathname}`);
    if (u.pathname === '/device/code') {
      assert.match(body, /scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file/);
      return json(200, { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 });
    }
    if (u.pathname === '/token') {
      if (body.includes('grant_type=urn')) {
        polls++;
        if (polls <= (o.approveAfter ?? 0)) return json(428, { error: 'authorization_pending' });
        return json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
      }
      assert.match(body, /grant_type=refresh_token&refresh_token=rt-1/);
      return json(200, { access_token: 'at-2', expires_in: 3600 });
    }
    if (u.pathname === '/revoke') return json(200, {});
    assert.match(String((init.headers as Record<string, string>)?.authorization), /^Bearer at-/);
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') { // create folder
      files.push({ id: 'folder-1', name: 'SWunja Backups', parent: 'root', createdTime: '' });
      return json(200, { id: 'folder-1' });
    }
    if (u.pathname === '/drive/v3/files') { // list
      const parent = /'([^']+)' in parents/.exec(u.searchParams.get('q') ?? '')![1];
      return json(200, { files: files.filter(f => f.parent === parent).sort((a, b) => b.createdTime.localeCompare(a.createdTime)) });
    }
    if (u.pathname === '/upload/drive/v3/files' && init.method === 'POST') {
      const meta = JSON.parse(body);
      return json(200, {}, { location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${encodeURIComponent(meta.name)}|${meta.parents[0]}` });
    }
    if (u.pathname === '/upload/drive/v3/files' && init.method === 'PUT') {
      if (o.failUpload) return json(503, { error: { message: 'backend error' } });
      const [name, parent] = u.searchParams.get('upload_id')!.split('|');
      files.push({ id: `f${++n}`, name, parent, createdTime: new Date(Date.now() + n * 1000).toISOString() });
      return json(200, { id: `f${n}` });
    }
    if (u.pathname.startsWith('/drive/v3/files/') && init.method === 'DELETE') {
      files.splice(files.findIndex(f => f.id === u.pathname.split('/').pop()), 1);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  return { fetchFn, calls, files };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  mkdirSync(join(dir, 'files'), { recursive: true });
  const db = openDb(join(dir, 'samunja.db'));
  return { dir, db };
}

test('connect: shows a code for google.com/device, waits for approval, then keeps only a refresh token', async () => {
  const { db } = setup();
  const g = fakeGoogle({ approveAfter: 1 });
  await assert.rejects(connectStart(db, { fetchFn: g.fetchFn }), /client ID and secret/);
  setDrive(db, { client_id: 'cid.apps.googleusercontent.com', client_secret: 'secret' });
  const start = await connectStart(db, { fetchFn: g.fetchFn });
  assert.deepEqual([start.user_code, start.verification_url, start.interval], ['ABCD-EFGH', 'https://www.google.com/device', 5]);
  assert.deepEqual(await connectFinish(db, { fetchFn: g.fetchFn }), { status: 'waiting' });
  assert.deepEqual(await connectFinish(db, { fetchFn: g.fetchFn }), { status: 'connected' });
  const d = getDrive(db);
  assert.deepEqual([d.connected, d.has_secret, d.folder_name, d.keep], [true, true, 'SWunja Backups', 14]);
  assert.ok(!JSON.stringify(d).includes('rt-1') && !JSON.stringify(d).includes('"secret"'), 'tokens and secret never leave the server');
});

test('uploads each new backup once into the SWunja Backups folder and keeps only the newest N', async () => {
  const { db, dir } = setup();
  const g = fakeGoogle();
  setDrive(db, { client_id: 'cid', client_secret: 's', keep: 2 });
  await connectStart(db, { fetchFn: g.fetchFn });
  await connectFinish(db, { fetchFn: g.fetchFn });
  const names: string[] = [];
  for (const t of ['2026-10-28T03:00:00Z', '2026-10-29T03:00:00Z', '2026-10-30T03:00:00Z']) {
    names.push(createBackup(db, dir, new Date(t)).name);
    assert.equal((await uploadIfNew(db, dir, { fetchFn: g.fetchFn }))?.name, names.at(-1));
  }
  assert.equal(await uploadIfNew(db, dir, { fetchFn: g.fetchFn }), null, 'nothing new: no upload');
  assert.deepEqual(g.files.filter(f => f.parent === 'folder-1').map(f => f.name).sort(), names.slice(1).sort(), 'oldest pruned');
  assert.equal(g.calls.filter(c => c === 'POST www.googleapis.com/drive/v3/files').length, 1, 'folder created once');
  const d = getDrive(db);
  assert.equal(d.last_upload?.name, names[2]);
  assert.equal(d.last_error, null);
});

test('a failed upload is recorded, retried later, and never throws into the background job', async () => {
  const { db, dir } = setup();
  const bad = fakeGoogle({ failUpload: true });
  setDrive(db, { client_id: 'cid', client_secret: 's' });
  await connectStart(db, { fetchFn: bad.fetchFn });
  await connectFinish(db, { fetchFn: bad.fetchFn });
  createBackup(db, dir, new Date('2026-10-30T03:00:00Z'));
  assert.equal(await uploadIfNew(db, dir, { fetchFn: bad.fetchFn }), null);
  assert.match(getDrive(db).last_error!, /503/);
  const good = fakeGoogle();
  assert.ok(await uploadIfNew(db, dir, { fetchFn: good.fetchFn }), 'tried again next time');
  assert.equal(getDrive(db).last_error, null);
});

test('not connected: does nothing; disconnect forgets the tokens', async () => {
  const { db, dir } = setup();
  const g = fakeGoogle();
  createBackup(db, dir, new Date('2026-10-30T03:00:00Z'));
  assert.equal(await uploadIfNew(db, dir, { fetchFn: g.fetchFn }), null);
  assert.equal(g.calls.length, 0);
  setDrive(db, { client_id: 'cid', client_secret: 's' });
  await connectStart(db, { fetchFn: g.fetchFn });
  await connectFinish(db, { fetchFn: g.fetchFn });
  await disconnect(db, { fetchFn: g.fetchFn });
  assert.equal(getDrive(db).connected, false);
  assert.ok(g.calls.includes('POST oauth2.googleapis.com/revoke'));
  assert.throws(() => setDrive(db, { keep: 0 }), /keep/);
  writeFileSync(join(dir, 'x'), '');
});

test('the background job waits 15 minutes after a failure before trying again', async () => {
  const { db, dir } = setup();
  const bad = fakeGoogle({ failUpload: true });
  setDrive(db, { client_id: 'cid', client_secret: 's' });
  await connectStart(db, { fetchFn: bad.fetchFn });
  await connectFinish(db, { fetchFn: bad.fetchFn });
  createBackup(db, dir, new Date('2026-10-30T03:00:00Z'));
  const t0 = Date.now();
  await uploadJob(db, dir, { fetchFn: bad.fetchFn, now: t0 });
  const good = fakeGoogle();
  assert.equal(await uploadJob(db, dir, { fetchFn: good.fetchFn, now: t0 + 5 * 60_000 }), null, 'too soon after a failure');
  assert.equal(good.calls.length, 0);
  assert.ok(await uploadJob(db, dir, { fetchFn: good.fetchFn, now: t0 + 16 * 60_000 }));
});
