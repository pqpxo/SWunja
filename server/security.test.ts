import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, trustProxy } from './main.ts';
import { openDb } from './db.ts';
import { checkSession, createSession } from './services.ts';

const fresh = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  return { dir, app: await buildApp(dir) };
};

test('the installer only names a plain host, so nothing can be smuggled into the script', async () => {
  const { app } = await fresh();
  try {
    for (const headers of [{ host: 'evil"; rm -rf ~; echo "x' }, { host: 'ok.lan', 'x-forwarded-host': 'a$(id)b' }, { host: 'a b' }]) {
      const r = await app.inject({ url: '/swjtrack/install', headers });
      assert.equal(r.statusCode, 400, JSON.stringify(headers));
      assert.doesNotMatch(r.body, /rm -rf|\$\(id\)|SERVER=/);
    }
    for (const host of ['server2.lan:7760', '192.168.1.5', '[fd00::1]:7760'])
      assert.match((await app.inject({ url: '/swjtrack/install', headers: { host } })).body, new RegExp(`SERVER="http://${host.replace(/[[\].]/g, '\\$&')}"`));
  } finally { await app.close(); }
});

test('proxy headers are trusted from private addresses only, unless TRUST_PROXY says otherwise', () => {
  assert.match(String(trustProxy('')), /192\.168\.0\.0\/16/);
  assert.equal(trustProxy('true'), true);
  assert.equal(trustProxy('false'), false);
  assert.equal(trustProxy('10.0.0.2'), '10.0.0.2');
});

test('every response carries the security headers', async () => {
  const { app } = await fresh();
  try {
    const r = await app.inject({ url: '/api/health' });
    assert.match(String(r.headers['content-security-policy']), /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
  } finally { await app.close(); }
});

test('wrong passwords are slowed down per address, and a good one is refused while locked', async () => {
  const { app } = await fresh();
  try {
    await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'correct horse' } });
    const login = (password: string, ip = '10.0.0.9') => app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': ip }, payload: { password } });
    for (let i = 0; i < 5; i++) assert.equal((await login('nope')).statusCode, 401);
    const locked = await login('correct horse');
    assert.equal(locked.statusCode, 429);
    assert.match(locked.json().error, /try again in \d+ s/);
    assert.equal((await login('correct horse', '10.0.0.10')).statusCode, 200, 'another address is not affected');
  } finally { await app.close(); }
});

test('a login expires after 90 days unused', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'smj-')), 'samunja.db'));
  const token = createSession(db);
  assert.ok(checkSession(db, token));
  db.prepare("UPDATE sessions SET last_used='2020-01-01T00:00:00Z'").run();
  assert.equal(checkSession(db, token), false);
  assert.equal((db.prepare('SELECT count(*) n FROM sessions').get() as { n: number }).n, 0, 'and is removed');
});
