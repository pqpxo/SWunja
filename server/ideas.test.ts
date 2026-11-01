import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import * as s from './services.ts';
import { createIdea, deleteIdea, ideaToTask, listIdeas, updateIdea } from './ideas.ts';
import { search } from './search.ts';

test('ideas: capture, pin, status with a reason, sub-project roll-up, turn into a task, search', () => {
  const db = openDb(':memory:');
  const lab = s.createProject(db, { title: 'Homelab' });
  const nc = s.createProject(db, { title: 'Nextcloud', parent_id: lab.id });
  const a = createIdea(db, { project_id: lab.id, title: 'Rack-mount the UPS' });
  const b = createIdea(db, { project_id: nc.id, title: 'Try S3 storage', body: '<p>MinIO on the NAS?</p>' });
  assert.deepEqual([a.status, a.pinned, a.body, a.task_id], ['new', false, '', null]);
  assert.throws(() => createIdea(db, { project_id: lab.id, title: '  ' }), /title/);
  assert.throws(() => updateIdea(db, a.id, { status: 'someday' as any }), /status/);

  updateIdea(db, a.id, { pinned: true });
  const c = createIdea(db, { project_id: lab.id, title: 'Second NAS' });
  assert.deepEqual(listIdeas(db, { projectId: lab.id }).map(i => i.title), ['Rack-mount the UPS', 'Second NAS', 'Try S3 storage'], 'pinned first, then newest; sub-projects included');
  assert.deepEqual(listIdeas(db, { projectId: lab.id, includeSub: false }).map(i => i.id).sort(), [a.id, c.id].sort());
  assert.equal(listIdeas(db, { projectId: lab.id }).find(i => i.id === b.id)!.project_title, 'Nextcloud');

  const r = updateIdea(db, c.id, { status: 'rejected', reason: 'One is enough for now' });
  assert.deepEqual([r.status, r.reason], ['rejected', 'One is enough for now']);
  assert.deepEqual(listIdeas(db, { projectId: lab.id, status: 'rejected' }).map(i => i.id), [c.id]);

  const { idea, task } = ideaToTask(db, b.id);
  assert.deepEqual([task.title, task.project_id, task.description], ['Try S3 storage', nc.id, '<p>MinIO on the NAS?</p>']);
  assert.deepEqual([idea.status, idea.task_id, idea.task_title], ['done', task.id, 'Try S3 storage']);
  assert.ok(s.listEvents(db, task.id).some(e => e.detail.includes('idea')), 'the task history says where it came from');
  assert.throws(() => ideaToTask(db, b.id), /already/);
  s.deleteTask(db, task.id);
  assert.equal(listIdeas(db, { projectId: nc.id })[0].task_id, null, 'deleting the task keeps the idea');

  assert.deepEqual(search(db, 'minio').ideas.map(h => h.id), [b.id]);
  deleteIdea(db, a.id);
  s.deleteProject(db, nc.id);
  assert.deepEqual(listIdeas(db, {}).map(i => i.id), [c.id], 'deleting a project deletes its ideas');
});
