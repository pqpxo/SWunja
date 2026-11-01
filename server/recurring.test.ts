import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import * as s from './services.ts';
import { closeTask } from './closure.ts';
import { nextDue } from './recurring.ts';

test('next due date: from the due date (skipping past ones) or from completion; month ends clamp', () => {
  assert.equal(nextDue({ every: 1, unit: 'week', from: 'due' }, '2026-11-02', '2026-11-03'), '2026-11-09');
  assert.equal(nextDue({ every: 1, unit: 'week', from: 'due' }, '2026-10-01', '2026-11-03'), '2026-11-05', 'done late: the next one is still in the future');
  assert.equal(nextDue({ every: 3, unit: 'month', from: 'done' }, '2026-01-01', '2026-11-03'), '2027-02-03');
  assert.equal(nextDue({ every: 1, unit: 'month', from: 'due' }, '2027-01-31', '2027-01-30'), '2027-02-28');
  assert.equal(nextDue({ every: 1, unit: 'year', from: 'due' }, null, '2026-11-03'), '2027-11-03', 'no due date: counts from today');
});

test('ticking a repeating task done creates the next one (copy with unticked checklist), once', () => {
  const db = openDb(':memory:');
  const p = s.createProject(db, { title: 'UPS' });
  const t = s.createTask(db, { project_id: p.id, title: 'Check UPS battery', due_date: '2020-01-06', priority: 2, labels: ['hardware'],
    checklist: ['Run self-test'], repeat: { every: 3, unit: 'month', from: 'due' } });
  assert.deepEqual(t.repeat, { every: 3, unit: 'month', from: 'due' });
  s.updateChecklistItem(db, t.checklist[0].id, { done: true });
  const done = s.updateTask(db, t.id, { done: true });
  assert.equal(done.repeat, null, 'the finished one stops repeating');
  const open = s.listTasks(db, { projectId: p.id, done: false });
  assert.equal(open.length, 1);
  const n = open[0];
  assert.deepEqual([n.title, n.priority, n.labels.map(l => l.title), n.repeat?.unit, n.checklist.map(c => [c.text, c.done])],
    ['Check UPS battery', 2, ['hardware'], 'month', [['Run self-test', false]]]);
  assert.ok(n.due_date! > new Date().toISOString().slice(0, 10), 'next due is in the future');
  assert.ok(s.listEvents(db, t.id).some(e => e.kind === 'repeated' && e.detail.includes(`#${n.id}`)));
  s.updateTask(db, t.id, { done: false });
  s.updateTask(db, t.id, { done: true });
  assert.equal(s.listTasks(db, { projectId: p.id, done: false }).length, 2 - 1, 're-ticking the old one does not make another');
  closeTask(db, n.id, { status: 'completed' });
  assert.equal(s.listTasks(db, { projectId: p.id, done: false }).length, 1, 'closing as completed also repeats');
  const last = s.listTasks(db, { projectId: p.id, done: false })[0];
  closeTask(db, last.id, { status: 'abandoned' });
  assert.equal(s.listTasks(db, { projectId: p.id, done: false }).length, 0, 'abandoning stops it');
  assert.throws(() => s.updateTask(db, last.id, { repeat: { every: 0, unit: 'week', from: 'due' } }), /repeat/);
  assert.throws(() => s.updateTask(db, last.id, { repeat: { every: 1, unit: 'fortnight' as any, from: 'due' } }), /repeat/);
});
