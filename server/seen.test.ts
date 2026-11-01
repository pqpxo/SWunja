import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import * as s from './services.ts';

const fresh = () => openDb(':memory:');
const as = <T>(who: string, fn: () => T): T => s.actor.run(who, fn);
const tick = () => new Promise(r => setTimeout(r, 5));

test('a task changed outside the browser is highlighted until it is opened', async () => {
  const db = fresh();
  const p = as('web', () => s.createProject(db, { title: 'WebApp' }));
  const t = as('mcp', () => s.createTask(db, { project_id: p.id, title: 'From Claude' }));
  assert.equal(s.getTask(db, t.id).unseen, 'new');
  await tick();
  as('web', () => s.logView(db, t.id));
  assert.equal(s.getTask(db, t.id).unseen, null, 'opened once: no longer highlighted');
  await tick();
  as('mcp', () => s.updateTask(db, t.id, { title: 'From Claude, renamed' }));
  assert.equal(s.getTask(db, t.id).unseen, 'updated');
  await tick();
  as('web', () => s.logView(db, t.id));
  await tick();
  as('web', () => s.logView(db, t.id)); // a second open within 10 minutes isn't logged again, but still counts as seen
  assert.equal(s.getTask(db, t.id).unseen, null);
  await tick();
  as('agent', () => s.createComment(db, t.id, { body: '<p>did it</p>', source: 'agent' }));
  assert.equal(s.listTasks(db, { projectId: p.id })[0].unseen, 'updated', 'list results carry the flag too');
});

test('your own changes in the browser, and imports, are not highlighted', () => {
  const db = fresh();
  const p = as('web', () => s.createProject(db, { title: 'Mine' }));
  const mine = as('web', () => s.createTask(db, { project_id: p.id, title: 'Typed in the browser' }));
  as('web', () => s.updateTask(db, mine.id, { title: 'Edited in the browser' }));
  assert.equal(s.getTask(db, mine.id).unseen, null);
  const imported = as('import', () => s.createTask(db, { project_id: p.id, title: 'From Vikunja' }));
  assert.equal(s.getTask(db, imported.id).unseen, null);
  assert.deepEqual([s.getProject(db, p.id).unseen, s.getProject(db, p.id).unseen_tasks], [null, 0]);
});

test('a project added or changed outside the browser is highlighted until opened; its unseen tasks are counted', async () => {
  const db = fresh();
  const p = as('mcp', () => s.createProject(db, { title: 'New from Claude' }));
  as('mcp', () => s.createTask(db, { project_id: p.id, title: 'a' }));
  as('mcp', () => s.createTask(db, { project_id: p.id, title: 'b' }));
  assert.deepEqual([s.getProject(db, p.id).unseen, s.getProject(db, p.id).unseen_tasks], ['new', 2]);
  await tick();
  as('web', () => s.markProjectSeen(db, p.id));
  const after = s.getProject(db, p.id);
  assert.deepEqual([after.unseen, after.unseen_tasks], [null, 2], 'opening the project clears its own highlight, not its tasks\'');
  await tick();
  as('api', () => s.updateProject(db, p.id, { description: 'changed by the API' }));
  assert.equal(s.listProjects(db).find(x => x.id === p.id)!.unseen, 'updated');
});

test('a task that existed before (imported, or from before this feature) is "updated", not "new", when changed', () => {
  const db = fresh();
  const p = as('import', () => s.createProject(db, { title: 'Old' }));
  const t = as('import', () => s.createTask(db, { project_id: p.id, title: 'Imported long ago' }));
  as('mcp', () => s.updateTask(db, t.id, { priority: 2 }));
  assert.equal(s.getTask(db, t.id).unseen, 'updated');
  as('mcp', () => s.updateProject(db, p.id, { description: 'x' }));
  assert.equal(s.getProject(db, p.id).unseen, 'updated');
});
