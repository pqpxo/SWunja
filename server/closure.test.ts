import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import * as s from './services.ts';
import { closeProject, closeTask, reopenProject, reopenTask } from './closure.ts';

const fresh = () => openDb(':memory:');
const as = <T>(who: string, fn: () => T): T => s.actor.run(who, fn);

test('closing a task: completed and abandoned mark it done with the closure kept; on hold leaves it open', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'WebApp' });
  const [a, b, c] = ['Ship v2', 'Try Redis', 'Migrate DNS'].map(title => s.createTask(db, { project_id: p.id, title }));
  const t1 = as('web', () => closeTask(db, a.id, { status: 'completed', notes: 'Shipped on Friday', lessons: 'Write the runbook first' }));
  assert.deepEqual([t1.done, t1.closed, t1.closure!.notes, t1.closure!.lessons, t1.closure!.closed_by], [true, 'completed', 'Shipped on Friday', 'Write the runbook first', 'web']);
  assert.ok(t1.closure!.closed_at);
  const t2 = closeTask(db, b.id, { status: 'abandoned', notes: 'Not worth it', reason: 'too_costly', replaced_by: { kind: 'task', id: a.id } });
  assert.deepEqual([t2.done, t2.closed, t2.closure!.reason, t2.closure!.replaced_by], [true, 'abandoned', 'too_costly', { kind: 'task', id: a.id, title: 'Ship v2' }]);
  const t3 = closeTask(db, c.id, { status: 'on_hold', notes: 'Waiting for the registrar' });
  assert.deepEqual([t3.done, t3.closed], [false, 'on_hold']);
  assert.ok(s.listEvents(db, b.id).some(e => e.kind === 'closed' && /abandoned/i.test(e.detail)), 'history records it');
  assert.throws(() => closeTask(db, c.id, { status: 'finished' as any }), /status/);
  assert.throws(() => closeTask(db, c.id, { status: 'completed', reason: 'blocked' }), /reason/, 'a reason is only for abandoned');
  assert.throws(() => closeTask(db, c.id, { status: 'abandoned', replaced_by: { kind: 'task', id: 999 } }), /not found/i);
});

test('reopening, or simply unticking done, clears a completed/abandoned closure; history keeps it', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'P' });
  const t = s.createTask(db, { project_id: p.id, title: 'x' });
  closeTask(db, t.id, { status: 'abandoned', notes: 'n' });
  const r = reopenTask(db, t.id);
  assert.deepEqual([r.done, r.closed, r.closure], [false, null, null]);
  assert.ok(s.listEvents(db, t.id).some(e => e.kind === 'reopened'));
  closeTask(db, t.id, { status: 'completed' });
  assert.equal(s.updateTask(db, t.id, { done: false }).closed, null, 'unticking done reopens it');
  closeTask(db, t.id, { status: 'on_hold' });
  assert.equal(s.updateTask(db, t.id, { title: 'y' }).closed, 'on_hold', 'other edits keep it on hold');
});

test('closing a project archives it, can close its open tasks too, and can write to the logbook', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'Old NAS' });
  const sub = s.createProject(db, { title: 'Shares', parent_id: p.id });
  const open = s.createTask(db, { project_id: sub.id, title: 'Move photos' });
  const done = s.createTask(db, { project_id: p.id, title: 'Back up' });
  s.updateTask(db, done.id, { done: true });
  const r = closeProject(db, p.id, { status: 'abandoned', reason: 'replaced', notes: 'Replaced by TrueNAS', close_tasks: true, log: true, lessons: 'Buy bigger disks' });
  assert.deepEqual([r.archived, r.closed, r.closure!.reason], [true, 'abandoned', 'replaced']);
  const ot = s.getTask(db, open.id);
  assert.deepEqual([ot.done, ot.closed], [true, 'abandoned'], 'open tasks in sub-projects closed too');
  assert.equal(s.getTask(db, done.id).closed, null, 'already-done tasks are left alone');
  const log = s.listLog(db, { projectId: p.id })[0];
  assert.match(log.title, /Closed: Old NAS \(Abandoned\)/);
  assert.match(log.body, /Replaced by TrueNAS/);
  assert.match(log.body, /Buy bigger disks/);
  const back = reopenProject(db, p.id);
  assert.deepEqual([back.archived, back.closed, back.closure], [false, null, null]);
  const held = closeProject(db, sub.id, { status: 'on_hold', notes: 'later', close_tasks: true });
  assert.deepEqual([held.archived, held.closed], [false, 'on_hold']);
  assert.equal(s.getTask(db, open.id).closed, 'abandoned', 'on hold does not touch tasks');
});

test('on hold can carry a review date; it is only for on hold and must be a real date', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'P' });
  const t = s.createTask(db, { project_id: p.id, title: 'x' });
  const held = closeTask(db, t.id, { status: 'on_hold', notes: 'waiting on parts', review_on: '2026-12-01' });
  assert.equal(held.closure!.review_on, '2026-12-01');
  assert.throws(() => closeTask(db, t.id, { status: 'completed', review_on: '2026-12-01' }), /review date/);
  assert.throws(() => closeTask(db, t.id, { status: 'on_hold', review_on: '1 Dec' }), /review date/);
  assert.equal(closeProject(db, p.id, { status: 'on_hold', review_on: '2027-01-15' }).closure!.review_on, '2027-01-15');
});
