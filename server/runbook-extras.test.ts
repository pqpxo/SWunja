import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { createRunbook, getRunbook, updateRunbook } from './runbooks.ts';

const fresh = () => openDb(':memory:');

test('runbooks keep rollback steps, an expected result per step, a time estimate, risk and downtime', () => {
  const db = fresh();
  const r = createRunbook(db, {
    title: 'Upgrade Postgres', steps: ['<p>Stop app</p>', '<p></p>', '<p>pg_upgrade</p>'], expected: ['Containers stopped', 'ignored with its blank step', ' Upgrade reports success '],
    rollback: ['<p>Restore snapshot</p>', ' '], est_minutes: 20, risk: 'high', downtime: true,
  });
  assert.deepEqual(r.steps, ['<p>Stop app</p>', '<p>pg_upgrade</p>']);
  assert.deepEqual(r.expected, ['Containers stopped', 'Upgrade reports success'], 'kept in line with the steps that remain');
  assert.deepEqual(r.rollback, ['<p>Restore snapshot</p>']);
  assert.deepEqual([r.est_minutes, r.risk, r.downtime], [20, 'high', true]);
  const u = updateRunbook(db, r.id, { steps: ['<p>Stop app</p>', '<p>Backup</p>', '<p>pg_upgrade</p>'], expected: ['Containers stopped', '', 'Upgrade reports success'] });
  assert.deepEqual(u.expected, ['Containers stopped', '', 'Upgrade reports success']);
  assert.deepEqual(updateRunbook(db, r.id, { steps: ['<p>Only one</p>'] }).expected, ['Containers stopped'], 'trimmed to the number of steps');
  assert.deepEqual([updateRunbook(db, r.id, { est_minutes: null, risk: '', downtime: false }).est_minutes, getRunbook(db, r.id).risk], [null, '']);
  assert.throws(() => updateRunbook(db, r.id, { risk: 'extreme' as any }), /risk/);
  assert.throws(() => updateRunbook(db, r.id, { est_minutes: 0 }), /est_minutes/);
  const plain = createRunbook(db, { title: 'Old style', steps: ['<p>a</p>'] });
  assert.deepEqual([plain.expected, plain.rollback, plain.est_minutes, plain.risk, plain.downtime], [[''], [], null, '', false]);
});

test('a runbook can ask to be tested every N months; test_due counts from the last run, or from when it was made', () => {
  const db = fresh();
  const r = createRunbook(db, { title: 'Restore VM', steps: ['<p>a</p>'], test_every: 6 });
  assert.equal(r.test_every, 6);
  const made = new Date(r.created); made.setUTCMonth(made.getUTCMonth() + 6);
  assert.equal(r.test_due?.slice(0, 7), made.toISOString().slice(0, 7), 'never run: six months after it was made');
  db.prepare("INSERT INTO runbook_runs (runbook_id, started, finished) VALUES (?, '2026-01-31T10:00:00Z', '2026-01-31T10:20:00Z')").run(r.id);
  assert.equal(getRunbook(db, r.id).test_due, '2026-07-31');
  assert.equal(updateRunbook(db, r.id, { test_every: 1 }).test_due, '2026-02-28', 'month ends clamp');
  const off = updateRunbook(db, r.id, { test_every: null });
  assert.deepEqual([off.test_every, off.test_due], [null, null]);
  assert.equal(createRunbook(db, { title: 'One-off' }).test_due, null);
  assert.throws(() => updateRunbook(db, r.id, { test_every: 0 }), /test_every/);
  assert.throws(() => updateRunbook(db, r.id, { test_every: 61 }), /test_every/);
});
