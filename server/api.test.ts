import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './main.ts';
import { openDb } from './db.ts';
import { createToken } from './services.ts';

test('every /api route needs auth, however the path is encoded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const app = await buildApp(dir);
  try {
    for (const url of ['/api/tokens', '/%61pi/tokens', '/api/%74okens', '/api//tokens', '/API/tokens'])
      for (const method of ['GET', 'POST'] as const) {
        const r = await app.inject({ method, url, payload: method === 'POST' ? { name: 'x' } : undefined });
        assert.ok([401, 403, 404].includes(r.statusCode) || (method === 'GET' && !r.body.includes('smj_') && r.headers['content-type']?.toString().includes('html')),
          `${method} ${url} -> ${r.statusCode} ${r.body.slice(0, 60)}`);
      }
    assert.equal((await app.inject({ url: '/api/health' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/auth/status' })).statusCode, 200);

    // REST calls made with an API token are tagged "api" in the task history
    const db = openDb(join(dir, 'samunja.db'));
    const { token } = createToken(db, 't');
    const auth = { authorization: `Bearer ${token}` };
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { title: 'P' } })).json();
    const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth, payload: { project_id: p.id, title: 't' } })).json();
    await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/viewed`, headers: auth });
    const ev = (await app.inject({ url: `/api/tasks/${t.id}/events`, headers: auth })).json();
    assert.deepEqual(ev.map((e: any) => [e.kind, e.actor]), [['viewed', 'api'], ['created', 'api']]);
  } finally {
    await app.close();
  }
});

test('logbook webhook: other tools post with an API token; text or JSON; tagged "webhook"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const app = await buildApp(dir);
  try {
    const db = openDb(join(dir, 'samunja.db'));
    const { token } = createToken(db, 'watchtower');
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { title: 'server2' } });
    const r1 = await app.inject({ method: 'POST', url: '/api/hooks/log?project=server2', headers: auth, payload: { title: 'Watchtower updated 3 containers', message: 'webapp: 1.2 -> 1.3' } });
    assert.equal(r1.statusCode, 200, r1.body);
    assert.deepEqual([r1.json().kind, r1.json().actor, r1.json().body], ['change', 'webhook', '<p>webapp: 1.2 -&gt; 1.3</p>\n']);
    const r2 = await app.inject({ method: 'POST', url: '/api/hooks/log?project=server2&kind=incident', headers: { ...auth, 'content-type': 'text/plain' }, payload: 'Backup job failed\nexit code 2' });
    assert.deepEqual([r2.statusCode, r2.json().title, r2.json().kind], [200, 'Backup job failed', 'incident']);
    assert.equal((await app.inject({ method: 'POST', url: '/api/hooks/log?project=server2', payload: { title: 'x' } })).statusCode, 401);
  } finally {
    await app.close();
  }
});

test('activity: POST with a token creates an item; accept writes the agent comment; claude key never leaks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const app = await buildApp(dir);
  try {
    const db = openDb(join(dir, 'samunja.db'));
    const { token } = createToken(db, 'swjtrack');
    const auth = { authorization: `Bearer ${token}` };
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { title: 'WebApp' } })).json();
    const t = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth, payload: { project_id: p.id, title: 'Replace neofetch with fastfetch' } })).json();
    assert.equal((await app.inject({ method: 'POST', url: '/api/activity', payload: { source: 'swjtrack', host: 'server2', folder: '/x' } })).statusCode, 401);
    const r = await app.inject({ method: 'POST', url: '/api/activity', headers: auth, payload: { source: 'swjtrack', host: 'server2', folder: '/home/u/webapp', batch_id: 'b1', commands: [{ cmd: 'apt install fastfetch' }] } });
    assert.equal(r.statusCode, 200, r.body);
    const id = r.json().id;
    assert.equal((await app.inject({ url: '/api/activity/count', headers: auth })).json().waiting, 1);
    const m = (await app.inject({ method: 'POST', url: `/api/activity/${id}/match`, headers: auth })).json();
    assert.deepEqual([m.status, m.suggestion.target.id, m.suggestion.ai], ['matched', t.id, false]);
    const acc = await app.inject({ method: 'POST', url: `/api/activity/${id}/accept`, headers: auth, payload: {} });
    assert.equal(acc.statusCode, 200, acc.body);
    const cs = (await app.inject({ url: `/api/tasks/${t.id}/comments`, headers: auth })).json();
    assert.deepEqual(cs.map((c: any) => c.source), ['agent']);
    assert.deepEqual((await app.inject({ url: '/api/folder-bindings', headers: auth })).json().map((b: any) => b.folder), ['/home/u/webapp']);
    assert.equal((await app.inject({ url: '/api/activity?status=accepted', headers: auth })).json().length, 1);
    assert.equal((await app.inject({ url: '/api/activity/count', headers: auth })).json().waiting, 0);
    assert.equal((await app.inject({ url: '/api/claude', headers: auth })).json().model, 'claude-haiku-5-5');
    const put = await app.inject({ method: 'PUT', url: '/api/claude', headers: auth, payload: { key: 'sk-ant-secret-xyz' } });
    assert.equal(put.json().has_key, true);
    assert.ok(!put.body.includes('sk-ant-secret-xyz'));
    assert.equal((await app.inject({ method: 'POST', url: '/api/activity/sync', headers: auth })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('swjtrack installer is served without login and points at this server; heartbeat needs a token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const app = await buildApp(dir);
  try {
    const r = await app.inject({ url: '/swjtrack/install', headers: { host: 'server2.lan:7760' } });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'] as string, /text\/plain/);
    assert.match(r.body, /SERVER="http:\/\/server2\.lan:7760"/);
    const proxied = await app.inject({ url: '/swjtrack/install', headers: { host: 'swunja.example.com', 'x-forwarded-proto': 'https' } });
    assert.match(proxied.body, /SERVER="https:\/\/swunja\.example\.com"/, 'behind an HTTPS reverse proxy the agent is pointed at https');
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-forwarded-proto': 'https' }, payload: { password: 'correct horse' } });
    assert.match(String(setup.headers['set-cookie']), /; Secure/, 'the login cookie is Secure over HTTPS');
    assert.doesNotMatch(r.body, /read -r TOKEN|_setup "\$SERVER" "\$/, 'the token is never read by the shell or passed as an argument');
    assert.match(r.body, /_install "\$SERVER" < \/dev\/tty/, 'runs the interactive setup on the terminal');
    assert.match(r.body, /\/swjtrack" -o "\$HOME\/\.local\/bin\/swjtrack"/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/activity/heartbeat', payload: { host: 'h', folder: '/f', unsynced_count: 1 } })).statusCode, 401);
    const { token } = createToken(openDb(join(dir, 'samunja.db')), 't');
    const hb = await app.inject({ method: 'POST', url: '/api/activity/heartbeat', headers: { authorization: `Bearer ${token}` }, payload: { host: 'h', folder: '/f', unsynced_count: 1, oldest: '2026-10-30T10:00:00Z' } });
    assert.equal(hb.statusCode, 200, hb.body);
  } finally {
    await app.close();
  }
});
