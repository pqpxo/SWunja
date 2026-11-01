import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import * as s from './services.ts';
import { createChannel, deleteChannel, listChannels, notify, notifyOverdue, setGithubToken, updateChannel } from './notify.ts';
import { createCheck, listChecks, probe, runDueChecks } from './health.ts';
import { checkUpdates, isNewer, listUpdates, parseRepo } from './updates.ts';
import { exportAll, importAny } from './transfer.ts';

const fresh = () => openDb(':memory:');
type Hit = { method: string; url: string; headers: IncomingMessage['headers']; body: string };

/** A local HTTP server that records every request. */
async function recorder(status = 200) {
  const hits: Hit[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => { hits.push({ method: req.method!, url: req.url!, headers: req.headers, body }); res.writeHead(status, { 'content-type': 'application/json' }).end('{}'); });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { hits, base, close: () => new Promise(r => srv.close(r)) };
}

test('version compare and GitHub repo parsing', () => {
  assert.equal(parseRepo('https://github.com/pagesgo/rackdb'), 'pagesgo/rackdb');
  assert.equal(parseRepo('https://github.com/a/b.git'), 'a/b');
  assert.equal(parseRepo('https://github.com/a/b/releases/tag/v1'), 'a/b');
  assert.equal(parseRepo('https://gitlab.com/a/b'), null);
  assert.equal(isNewer('v1.4.0', '1.3.9'), true);
  assert.equal(isNewer('1.10', '1.9'), true);
  assert.equal(isNewer('v2.0', 'v2.0.0'), false);
  assert.equal(isNewer('1.3', '1.4'), false);
  assert.equal(isNewer('2024.10.1', '2024.9.30'), true);
});

test('notifications go to every enabled channel that wants the event; secrets are write-only', async () => {
  const db = fresh();
  const r = await recorder();
  try {
    const ntfy = createChannel(db, { name: 'Phone', kind: 'ntfy', config: { url: r.base, topic: 'homelab' }, secret: 'tk_ntfy' });
    createChannel(db, { name: 'Gotify', kind: 'gotify', config: { url: `${r.base}/` }, secret: 'gotify-app' });
    createChannel(db, { name: 'HA', kind: 'homeassistant', config: { url: r.base, service: 'notify.mobile_app_pixel' }, secret: 'ha-llat' });
    createChannel(db, { name: 'Hook', kind: 'webhook', config: { url: `${r.base}/hook` } });
    createChannel(db, { name: 'Pushover', kind: 'pushover', config: { user: 'uKey123', url: `${r.base}/1/messages.json` }, secret: 'appToken' });
    assert.throws(() => createChannel(db, { name: 'x', kind: 'pushover', config: { user: 'u' } }), /API token/);
    createChannel(db, { name: 'Updates only', kind: 'webhook', config: { url: `${r.base}/updates` }, events: ['update'] });
    const off = createChannel(db, { name: 'Off', kind: 'webhook', config: { url: `${r.base}/off` } });
    updateChannel(db, off.id, { enabled: false });
    assert.throws(() => createChannel(db, { name: 'x', kind: 'gotify', config: { url: r.base } }), /token/i);
    assert.throws(() => createChannel(db, { name: 'x', kind: 'ntfy', config: { url: 'ftp://x', topic: 't' } }), /http/);

    const listed = listChannels(db);
    assert.ok(!JSON.stringify(listed).includes('tk_ntfy'));
    assert.equal(listed.find(c => c.id === ntfy.id)!.has_secret, true);

    const results = await notify(db, { event: 'health', title: 'server2 is down', message: 'Connection refused', project: 'server2' });
    assert.equal(results.length, 5);
    assert.ok(results.every(x => x.ok), JSON.stringify(results));
    const by = (u: string) => r.hits.find(h => h.url.startsWith(u))!;
    const ntfyHit = r.hits.find(h => h.body.includes('"topic"'))!;
    assert.equal(ntfyHit.headers.authorization, 'Bearer tk_ntfy');
    assert.equal(JSON.parse(ntfyHit.body).topic, 'homelab');
    const g = by('/message');
    assert.equal(g.headers['x-gotify-key'], 'gotify-app');
    assert.equal(JSON.parse(g.body).title, 'server2 is down');
    const ha = by('/api/services/notify/mobile_app_pixel');
    assert.equal(ha.headers.authorization, 'Bearer ha-llat');
    assert.equal(JSON.parse(ha.body).message, 'Connection refused');
    assert.equal(JSON.parse(by('/hook').body).event, 'health');
    const po = JSON.parse(by('/1/messages.json').body);
    assert.deepEqual([po.token, po.user, po.title, po.priority], ['appToken', 'uKey123', 'server2 is down', 0]);
    assert.ok(!r.hits.some(h => h.url === '/updates' || h.url === '/off'));

    // a blank secret keeps the old one, null clears it
    updateChannel(db, ntfy.id, { secret: '' });
    assert.equal(listChannels(db).find(c => c.id === ntfy.id)!.has_secret, true);
    updateChannel(db, ntfy.id, { secret: null });
    assert.equal(listChannels(db).find(c => c.id === ntfy.id)!.has_secret, false);
    deleteChannel(db, ntfy.id);
    assert.equal(db.prepare("SELECT count(*) n FROM secrets WHERE key LIKE 'channel:%'").get()!.n, 3);

    // a failing channel is reported, not thrown
    const bad = await recorder(500);
    createChannel(db, { name: 'Broken', kind: 'webhook', config: { url: bad.base } });
    const res2 = await notify(db, { event: 'health', title: 't', message: 'm' });
    assert.equal(res2.find(x => x.channel === 'Broken')!.ok, false);
    await bad.close();
  } finally { await r.close(); }
});

test('health checks: two failures mark a check down with an incident, recovery notes it and notifies', async () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'server2' });
  const c = createCheck(db, { project_id: p.id, kind: 'http', target: 'http://server2.lan:7760/api/health', every_min: 5 });
  assert.throws(() => createCheck(db, { project_id: p.id, kind: 'tcp', target: 'no-port' }), /host:port/);
  const sent: string[] = [];
  const send = async (m: { title: string }) => { sent.push(m.title); return []; };
  let up = false;
  const fake = async () => (up ? { ok: true, ms: 12, error: '' } : { ok: false, ms: 0, error: 'ECONNREFUSED' });
  const t0 = Date.parse('2026-10-28T10:00:00Z');

  await runDueChecks(db, { now: t0, probe: fake, send });
  assert.equal(listChecks(db)[0].status, 'unknown'); // one failure isn't enough
  await runDueChecks(db, { now: t0 + 60_000, probe: fake, send });
  assert.equal(listChecks(db)[0].status, 'unknown'); // not due again yet (every 5 minutes)
  await runDueChecks(db, { now: t0 + 5 * 60_000, probe: fake, send });
  const down = listChecks(db)[0];
  assert.equal(down.status, 'down');
  assert.equal(down.last_error, 'ECONNREFUSED');
  const incident = s.listLog(db, { projectId: p.id })[0];
  assert.equal(incident.kind, 'incident');
  assert.match(incident.title, /server2.*down/i);
  assert.equal(incident.actor, 'monitor');
  assert.deepEqual(sent, [incident.title]);

  up = true;
  await runDueChecks(db, { now: t0 + 10 * 60_000, probe: fake, send });
  const back = listChecks(db)[0];
  assert.equal(back.status, 'up');
  assert.equal(back.last_ms, 12);
  assert.equal(s.listLog(db, { projectId: p.id }).length, 1); // recovery is added to the same incident
  assert.match(s.listLog(db, { projectId: p.id })[0].body, /Back up .*5 min/);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /back up/i);
  assert.equal(listChecks(db, { projectId: p.id })[0].id, c.id);
});

test('real probes: http answers below 500 are up, closed ports are down', async () => {
  const r = await recorder(401);
  const bad = await recorder(503);
  try {
    assert.equal((await probe({ kind: 'http', target: r.base })).ok, true);
    const b = await probe({ kind: 'http', target: bad.base });
    assert.equal(b.ok, false);
    assert.match(b.error, /503/);
    assert.equal((await probe({ kind: 'tcp', target: r.base.replace('http://', '') })).ok, true);
  } finally { await r.close(); await bad.close(); }
  const closed = await probe({ kind: 'tcp', target: '127.0.0.1:1' });
  assert.equal(closed.ok, false);
});

test('GitHub update checks compare with the Version field and notify once per release', async () => {
  const db = fresh();
  const app = s.listTypes(db).find(t => t.name === 'Application')!.id;
  const p = s.createProject(db, { title: 'RackDB', type_id: app });
  s.setFieldValues(db, 'project', p.id, { GitHub: 'https://github.com/pagesgo/rackdb', Version: 'v1.3.0' });
  s.createProject(db, { title: 'No repo', type_id: app });
  setGithubToken(db, 'ghp_test');
  const calls: { url: string; auth: string | null }[] = [];
  let latest = 'v1.4.0';
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify({ tag_name: latest, html_url: `https://github.com/pagesgo/rackdb/releases/tag/${latest}` }), { status: 200 });
  }) as typeof fetch;
  const sent: string[] = [];
  const send = async (m: { title: string }) => { sent.push(m.title); return []; };

  await checkUpdates(db, { fetchFn, send });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/pagesgo/rackdb/releases/latest');
  assert.equal(calls[0].auth, 'Bearer ghp_test');
  const u = listUpdates(db);
  assert.equal(u.length, 1);
  assert.equal(u[0].latest, 'v1.4.0');
  assert.equal(u[0].current, 'v1.3.0');
  assert.equal(u[0].update_available, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /RackDB.*v1\.4\.0/);

  await checkUpdates(db, { fetchFn, send }); // not due again for hours
  assert.equal(calls.length, 1);
  await checkUpdates(db, { fetchFn, send, force: true }); // same release: no second notification
  assert.equal(sent.length, 1);
  s.setFieldValues(db, 'project', p.id, { Version: '1.4.0' });
  assert.equal(listUpdates(db)[0].update_available, false);
  latest = 'v1.5.0';
  await checkUpdates(db, { fetchFn, send, force: true });
  assert.equal(sent.length, 2);
});

test('overdue maintenance notifies once per due date', async () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'server2' });
  const m = s.createMaintenance(db, { project_id: p.id, title: 'Patch', every: 1, unit: 'month', next_due: '2020-01-01' });
  s.createMaintenance(db, { project_id: p.id, title: 'Later', every: 1, unit: 'month', next_due: '2999-01-01' });
  const sent: { title: string; message: string }[] = [];
  const send = async (x: { title: string; message: string }) => { sent.push(x); return []; };
  await notifyOverdue(db, { send });
  await notifyOverdue(db, { send });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Patch/);
  assert.doesNotMatch(sent[0].message, /Later/);
  s.updateMaintenance(db, m.id, { next_due: '2020-02-01' });
  await notifyOverdue(db, { send });
  assert.equal(sent.length, 2);
});

test('exports carry checks and channels but never their secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const db = openDb(join(dir, 'samunja.db'));
  const p = s.createProject(db, { title: 'server2' });
  createCheck(db, { project_id: p.id, kind: 'tcp', target: 'server2.lan:22' });
  createChannel(db, { name: 'Phone', kind: 'ntfy', config: { url: 'https://ntfy.sh', topic: 'x' }, secret: 'SECRET_tk' });
  setGithubToken(db, 'ghp_SECRET');
  const zip = exportAll(db, dir);
  const text = new TextDecoder().decode(unzipSync(zip)['samunja.json']);
  assert.ok(!text.includes('SECRET'));
  const other = openDb(':memory:');
  importAny(other, mkdtempSync(join(tmpdir(), 'smj-')), zip, {});
  const checks = listChecks(other);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'unknown');
  assert.equal(listChannels(other)[0].name, 'Phone');
  assert.equal(listChannels(other)[0].has_secret, false);
});

test('older databases gain the pushover kind and keep their channels and secrets', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'smj-')), 'old.db');
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE notify_channels (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ntfy','gotify','homeassistant','email','webhook')), config TEXT NOT NULL DEFAULT '{}',
    events TEXT NOT NULL DEFAULT '["health"]', enabled INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL DEFAULT 'x');
    INSERT INTO notify_channels (id,name,kind,config) VALUES (7,'Phone','ntfy','{"url":"https://ntfy.sh","topic":"t"}');
    CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO secrets VALUES ('channel:7','tk');`);
  raw.close();
  const db = openDb(path);
  const old = listChannels(db)[0];
  assert.deepEqual([old.id, old.name, old.has_secret], [7, 'Phone', true]);
  assert.equal(createChannel(db, { name: 'P', kind: 'pushover', config: { user: 'u' }, secret: 's' }).kind, 'pushover');
});
