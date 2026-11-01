import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listifyResources, listsOffUnlessUsed, openDb, splitExistingDescriptions } from './db.ts';
import { htmlToLines, splitSections } from './sections.ts';
import * as s from './services.ts';
import { importVikunja } from './importer.ts';
import { exportAll, importAny } from './transfer.ts';
import { backupIfDue, backupPath, createBackup, listBackups, setBackupSettings } from './backups.ts';
import { unzipSync } from 'fflate';
import { search } from './search.ts';
import { applyTemplate, deleteTemplate, listTemplates, saveTemplate } from './templates.ts';
import { createRunbook, deleteRun, deleteRunbook, finishRun, getRunbook, listRunbooks, listRuns, maintenanceDone, recordRun, startRun, updateRun, updateRunbook } from './runbooks.ts';
import { DatabaseSync } from 'node:sqlite';

const fresh = () => openDb(':memory:');
const typeId = (db: ReturnType<typeof fresh>, name: string) => s.listTypes(db).find(t => t.name === name)!.id;

test('presets seeded and project types inherit down the tree, override wins', () => {
  const db = fresh();
  const app = s.createProject(db, { title: 'AppSuite', type_id: typeId(db, 'Application') });
  const child = s.createProject(db, { title: 'RackDB', parent_id: app.id });
  assert.deepEqual(s.getProject(db, child.id).fields.map(f => f.name), ['Host', 'OS', 'GitHub', 'Platform', 'Access', 'URL', 'Runs On', 'Version']);
  s.updateProject(db, child.id, { type_id: typeId(db, 'Electronics') });
  assert.deepEqual(s.getProject(db, child.id).fields.map(f => f.name), ['Platform', 'Device']);
  const ha = s.createProject(db, { title: 'HA', type_id: typeId(db, 'Home Assistant') });
  const t = s.createTask(db, { project_id: ha.id, title: 'Motion sensor' });
  assert.deepEqual(s.getTask(db, t.id).fields.map(f => f.name), ['Device', 'Connectivity']);
});

test('field validation: select options, inapplicable fields, types', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'App', type_id: typeId(db, 'Application') });
  assert.throws(() => s.setFieldValues(db, 'project', p.id, { Access: 'Sideways' }), /Local, Public/);
  assert.throws(() => s.setFieldValues(db, 'project', p.id, { Connectivity: 'WiFi' }), /does not apply/);
  assert.throws(() => s.setFieldValues(db, 'project', p.id, { GitHub: 'not a url' }), /URL/);
  s.setFieldValues(db, 'project', p.id, { access: 'local', Host: 'server1', URL: '192.168.1.5:8080' });
  const f = Object.fromEntries(s.getProject(db, p.id).fields.map(x => [x.name, x.value]));
  assert.equal(f.Access, 'Local');
  assert.equal(f.URL, 'http://192.168.1.5:8080');
  s.setFieldValues(db, 'project', p.id, { Host: null });
  assert.equal(s.getProject(db, p.id).fields.find(x => x.name === 'Host')!.value, null);
  const n = s.createField(db, { name: 'Cost', type: 'number', target: 'task' });
  s.updateType(db, typeId(db, 'Application'), { fieldIds: [...s.listTypes(db).find(t => t.name === 'Application')!.fields.map(x => x.id), n.id] });
  const t = s.createTask(db, { project_id: p.id, title: 'x', fields: { Cost: '12.5' } });
  assert.equal(s.getTask(db, t.id).fields.find(x => x.name === 'Cost')!.value, '12.5');
  assert.throws(() => s.setFieldValues(db, 'task', t.id, { Cost: 'abc' }), /number/);
});

test('filter tasks and projects by custom field value', () => {
  const db = fresh();
  const root = s.createProject(db, { title: 'Apps', type_id: typeId(db, 'Application') });
  const a = s.createProject(db, { title: 'A', parent_id: root.id, fields: { Host: 'server1', Access: 'Public' } });
  s.createProject(db, { title: 'B', parent_id: root.id, fields: { Host: 'server1', Access: 'Local' } });
  assert.deepEqual(s.listProjects(db, { filters: [{ field: 'Access', op: 'eq', value: 'public' }] }).map(p => p.title), ['A']);
  assert.equal(s.listProjects(db, { filters: [{ field: 'Host', op: 'eq', value: 'server1' }] }).length, 2);
  assert.equal(s.listProjects(db, { filters: [{ field: 'Host', op: 'empty' }] }).length, 1);
  const cost = s.createField(db, { name: 'Cost', type: 'number', target: 'task' });
  s.updateType(db, typeId(db, 'Application'), { fieldIds: [cost.id] });
  s.createTask(db, { project_id: a.id, title: 'cheap', fields: { Cost: 5 } });
  s.createTask(db, { project_id: a.id, title: 'dear', fields: { Cost: 50 } });
  s.createTask(db, { project_id: root.id, title: 'root task' });
  assert.deepEqual(s.listTasks(db, { filters: [{ field: 'Cost', op: 'gt', value: 10 }] }).map(t => t.title), ['dear']);
  assert.equal(s.listTasks(db, { projectId: root.id }).length, 3);
  assert.equal(s.listTasks(db, { projectId: root.id, includeSub: false }).length, 1);
});

test('done follows last bucket both ways; moving into a column a sub-project lacks creates it', () => {
  const db = fresh();
  const parent = s.createProject(db, { title: 'P' });
  const child = s.createProject(db, { title: 'C', parent_id: parent.id });
  const cb = s.listBuckets(db, child.id);
  assert.deepEqual(cb.map(b => b.title), ['To-Do', 'Doing', 'Done']);
  const t = s.createTask(db, { project_id: child.id, title: 't' });
  assert.equal(t.bucket_id, cb[0].id);
  assert.equal(s.updateTask(db, t.id, { done: true }).bucket_id, cb[2].id);
  assert.equal(s.updateTask(db, t.id, { done: false }).bucket_id, cb[0].id);
  assert.equal(s.moveTask(db, t.id, { bucketId: cb[2].id }).done, true);
  // parent gets a "Review" column before Done; child has none
  const pb = s.listBuckets(db, parent.id);
  const review = s.createBucket(db, parent.id, { title: 'Review', position: (pb[1].position + pb[2].position) / 2 });
  const moved = s.moveTask(db, t.id, { bucketId: review.id });
  assert.equal(moved.done, false);
  assert.equal(moved.project_id, child.id);
  assert.deepEqual(s.listBuckets(db, child.id).map(b => b.title), ['To-Do', 'Doing', 'Review', 'Done']);
  // moving to the parent's Done column maps to the child's Done
  assert.equal(s.moveTask(db, t.id, { bucketId: pb[2].id }).bucket_id, cb[2].id);
});

test('deleting a project cascades to descendants, tasks, comments and values', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'P', type_id: typeId(db, 'Application'), fields: { Host: 'server1' } });
  const c = s.createProject(db, { title: 'C', parent_id: p.id, fields: { Host: 'server1' } });
  const t = s.createTask(db, { project_id: c.id, title: 't', labels: ['Fix'] });
  s.createComment(db, t.id, { body: 'hi' });
  s.deleteProject(db, p.id);
  for (const tbl of ['projects', 'tasks', 'comments', 'field_values', 'buckets', 'task_labels'])
    assert.equal((db.prepare(`SELECT count(*) n FROM ${tbl}`).get() as { n: number }).n, 0, tbl);
  assert.equal(s.listLabels(db).length, 1);
});

test('api tokens and password', () => {
  const db = fresh();
  assert.equal(s.hasPassword(db), false);
  s.setPassword(db, 'hunter22');
  assert.equal(s.checkPassword(db, 'hunter22'), true);
  assert.equal(s.checkPassword(db, 'nope'), false);
  const { token } = s.createToken(db, 'claude');
  assert.equal(s.checkToken(db, token), true);
  assert.equal(s.checkToken(db, token + 'x'), false);
  s.deleteToken(db, s.listTokens(db)[0].id);
  assert.equal(s.checkToken(db, token), false);
});

test('columns: done column stays last, reorder is atomic, open tasks never get relocated', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'P' });
  const [todo, doing, done] = s.listBuckets(db, p.id);
  const t = s.moveTask(db, s.createTask(db, { project_id: p.id, title: 'a' }).id, { bucketId: doing.id });
  assert.throws(() => s.reorderBuckets(db, p.id, [todo.id, done.id, doing.id]), /done column/);
  assert.throws(() => s.deleteBucket(db, done.id), /done column/);
  s.reorderBuckets(db, p.id, [doing.id, todo.id, done.id]);
  assert.deepEqual(s.listBuckets(db, p.id).map(b => b.title), ['Doing', 'To-Do', 'Done']);
  assert.equal(s.getTask(db, t.id).bucket_id, doing.id);
  const extra = s.createBucket(db, p.id, { title: 'Late', position: 999 });
  assert.equal(s.listBuckets(db, p.id).at(-1)!.id, done.id, 'explicit position past Done is clamped');
  s.deleteBucket(db, extra.id);
});

test('moveTask: only own or ancestor columns; parent done column maps to own done column', () => {
  const db = fresh();
  const parent = s.createProject(db, { title: 'P' });
  const child = s.createProject(db, { title: 'C', parent_id: parent.id });
  const other = s.createProject(db, { title: 'O' });
  s.updateBucket(db, s.listBuckets(db, parent.id)[2].id, { title: 'Complete' });
  const t = s.createTask(db, { project_id: child.id, title: 't' });
  assert.throws(() => s.moveTask(db, t.id, { bucketId: s.listBuckets(db, other.id)[0].id }), /does not show/);
  const moved = s.moveTask(db, t.id, { bucketId: s.listBuckets(db, parent.id)[2].id });
  assert.equal(moved.done, true);
  assert.deepEqual(s.listBuckets(db, child.id).map(b => b.title), ['To-Do', 'Doing', 'Done']);
  assert.throws(() => s.updateTask(db, t.id, { done: false, bucket_id: s.listBuckets(db, child.id)[2].id }), /either/);
});

test('url fields only take http(s); deleting a task removes its attachment files', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'App', type_id: typeId(db, 'Application') });
  assert.throws(() => s.setFieldValues(db, 'project', p.id, { GitHub: 'javascript://x.com/%0aalert(1)' }), /URL/);
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const t = s.createTask(db, { project_id: p.id, title: 'x' });
  const a = s.createAttachment(db, dir, { name: 'a.png', mime: 'image/png', data: new Uint8Array([1]), taskId: t.id });
  s.deleteTask(db, t.id, dir);
  assert.equal(existsSync(s.attachmentPath(dir, a.id)), false);
  const t2 = s.createTask(db, { project_id: p.id, title: 'y' });
  const a2 = s.createAttachment(db, dir, { name: 'b.png', mime: 'image/png', data: new Uint8Array([1]), taskId: t2.id });
  s.deleteProject(db, p.id, dir);
  assert.equal(existsSync(s.attachmentPath(dir, a2.id)), false);
});

test('splitSections moves Issue/Workaround/Proposed Resolution/Resources out of a description', () => {
  const html = '<p>intro</p><h2><strong><u>Issue</u></strong></h2><p>a</p><p></p><h2>Workaround</h2><p>b</p>'
    + '<h2>Proposed Resolution</h2><p>c</p><h3>Steps</h3><p>d</p><h2>Resources:</h2><ul><li>x</li></ul>';
  assert.deepEqual(splitSections(html), {
    description: '<p>intro</p>', issue: '<p>a</p>', workaround: '<p>b</p>',
    resolution: '<p>c</p><h3>Steps</h3><p>d</p>', resources: '<ul><li>x</li></ul>',
  });
  assert.deepEqual(splitSections('<p>no headings</p>'), { description: '<p>no headings</p>' });
});

test('task sections round-trip, are searchable, and old descriptions get split once', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'P' });
  const t = s.createTask(db, { project_id: p.id, title: 't', issue: '<p>broken</p>' });
  assert.equal(t.issue, '<p>broken</p>');
  assert.equal(s.updateTask(db, t.id, { workaround: '<p>reboot</p>' }).workaround, '<p>reboot</p>');
  assert.equal(s.listTasks(db, { q: 'reboot' }).length, 1);
  const old = s.createTask(db, { project_id: p.id, title: 'old', description: '<h2>Issue</h2><p>x</p><h2>Workaround</h2><p>y</p>' });
  splitExistingDescriptions(db);
  const after = s.getTask(db, old.id);
  assert.deepEqual([after.description, after.issue, after.workaround], ['', '<p>x</p>', '<p>y</p>']);
  assert.equal(s.getTask(db, t.id).issue, '<p>broken</p>', 'tasks that already use sections are left alone');
});

test('attachments list and delete per task; appearance settings validate', () => {
  const db = fresh();
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const t = s.createTask(db, { project_id: s.createProject(db, { title: 'P' }).id, title: 't' });
  const a = s.createAttachment(db, dir, { name: 'notes.txt', mime: 'text/plain', data: new Uint8Array([104, 105]), taskId: t.id });
  assert.deepEqual(s.listAttachments(db, t.id).map(x => x.name), ['notes.txt']);
  s.deleteAttachment(db, dir, a.id);
  assert.equal(s.listAttachments(db, t.id).length, 0);
  assert.equal(existsSync(s.attachmentPath(dir, a.id)), false);

  assert.equal(s.getAppearance(db).theme, 'light');
  assert.deepEqual(s.setAppearance(db, { theme: 'dark', accent: '#A3E635', font: 'figtree' }), { theme: 'dark', accent: '#a3e635', font: 'figtree', taskView: 'panel', nav: { order: [], hidden: ['projects'] }, showArchived: false });
  assert.throws(() => s.setAppearance(db, { theme: 'neon' as never }), /theme/);
  assert.throws(() => s.setAppearance(db, { accent: 'red; background:url(x)' }), /accent/);
  assert.equal(s.setAppearance(db, { accent: null }).accent, null);
});

test('extra fields: add to one task, or to a project and all its tasks; only own additions can be removed', () => {
  const db = fresh();
  const parent = s.createProject(db, { title: 'Lab', type_id: typeId(db, 'Home Assistant') });
  const child = s.createProject(db, { title: 'Sensors', parent_id: parent.id });
  const t = s.createTask(db, { project_id: child.id, title: 'hall' });
  const cost = s.createField(db, { name: 'Cost', type: 'number', target: 'task' });
  const serial = s.createField(db, { name: 'Serial', type: 'text', target: 'task' });
  s.attachField(db, 'task', t.id, 'Cost');
  assert.deepEqual(s.getTask(db, t.id).fields.map(x => [x.name, x.source]), [['Device', 'type'], ['Connectivity', 'type'], ['Cost', 'own']]);
  assert.throws(() => s.attachField(db, 'task', t.id, 'Device'), /already/);
  s.attachField(db, 'project', parent.id, serial.id);
  s.attachField(db, 'project', parent.id, 'Host');
  assert.ok(s.getTask(db, t.id).fields.some(x => x.name === 'Serial' && x.source === 'parent'), 'task field on a project reaches sub-project tasks');
  assert.deepEqual(s.getProject(db, child.id).fields.map(x => [x.name, x.source]), [['Host', 'parent']]);
  assert.deepEqual(s.getProject(db, parent.id).fields.map(x => [x.name, x.source]), [['Host', 'own']]);
  assert.deepEqual(s.getProject(db, parent.id).task_fields.map(x => [x.name, x.source]), [['Serial', 'own']]);
  s.setFieldValues(db, 'task', t.id, { Cost: 5 });
  assert.throws(() => s.detachField(db, 'task', t.id, serial.id), /comes from/);
  s.detachField(db, 'task', t.id, cost.id);
  assert.ok(!s.getTask(db, t.id).fields.some(x => x.name === 'Cost'));
  s.attachField(db, 'task', t.id, cost.id);
  assert.equal(s.getTask(db, t.id).fields.find(x => x.name === 'Cost')!.value, '5', 'values survive remove + re-add');
});

test('history records who did what and collapses repeated views', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'P' });
  const t = s.actor.run('web', () => s.createTask(db, { project_id: p.id, title: 't' }));
  s.actor.run('mcp', () => s.updateTask(db, t.id, { priority: 3, title: 't2', labels: ['Fix'] }));
  s.actor.run('web', () => { s.logView(db, t.id); s.logView(db, t.id); });
  s.actor.run('web', () => s.updateTask(db, t.id, { done: true }));
  s.actor.run('web', () => s.createComment(db, t.id, { body: '<p>x</p>' }));
  assert.deepEqual(s.listEvents(db, t.id).map(e => [e.kind, e.actor, e.detail]).reverse(), [
    ['created', 'web', ''], ['updated', 'mcp', 'title, priority → High, labels'], ['viewed', 'web', ''], ['done', 'web', ''], ['commented', 'web', ''],
  ]);
});

test('project icons', () => {
  const db = fresh();
  assert.equal(s.createProject(db, { title: 'P', icon: 'server' }).icon, 'server');
  assert.equal(s.createProject(db, { title: 'Q', icon: '🏠' }).icon, '🏠');
  assert.throws(() => s.createProject(db, { title: 'R', icon: 'x'.repeat(40) }), /icon/);
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const img = s.createAttachment(db, dir, { name: 'logo.png', mime: 'image/png', data: new Uint8Array([1]) });
  const txt = s.createAttachment(db, dir, { name: 'notes.txt', mime: 'text/plain', data: new Uint8Array([1]) });
  assert.equal(s.createProject(db, { title: 'S', icon: `img:${img.id}` }).icon, `img:${img.id}`);
  assert.throws(() => s.createProject(db, { title: 'T', icon: `img:${txt.id}` }), /image/);
  assert.throws(() => s.createProject(db, { title: 'U', icon: 'img:999' }), /image/);
});

test('task checklist: add, tick, reorder, delete, style, history', () => {
  const db = fresh();
  const t = s.createTask(db, { project_id: s.createProject(db, { title: 'P' }).id, title: 't', checklist: ['Back up config'] });
  const a = s.getTask(db, t.id).checklist[0];
  const b = s.addChecklistItem(db, t.id, { text: 'Upgrade' });
  const c = s.addChecklistItem(db, t.id, { text: 'Test' });
  s.updateChecklistItem(db, b.id, { done: true });
  s.reorderChecklist(db, t.id, [c.id, a.id, b.id]);
  assert.deepEqual(s.getTask(db, t.id).checklist.map(i => [i.text, i.done]), [['Test', false], ['Back up config', false], ['Upgrade', true]]);
  assert.throws(() => s.addChecklistItem(db, t.id, { text: '  ' }), /text/);
  assert.throws(() => s.reorderChecklist(db, t.id, [a.id]), /every/);
  s.deleteChecklistItem(db, c.id);
  assert.equal(s.getTask(db, t.id).checklist.length, 2);
  assert.equal(s.getTask(db, t.id).checklist_style, 'bullets');
  assert.equal(s.updateTask(db, t.id, { checklist_style: 'numbered' }).checklist_style, 'numbered');
  assert.throws(() => s.updateTask(db, t.id, { checklist_style: 'zigzag' as never }), /checklist_style/);
  assert.ok(s.listEvents(db, t.id).some(e => e.detail === 'ticked “Upgrade”'));
});

test('appearance: task view and the extra themes and fonts', () => {
  const db = fresh();
  assert.equal(s.getAppearance(db).taskView, 'panel');
  const a = s.setAppearance(db, { taskView: 'page', theme: 'nord', font: 'inter' });
  assert.deepEqual([a.taskView, a.theme, a.font], ['page', 'nord', 'inter']);
  assert.ok(s.THEMES.length >= 15 && s.FONTS.length >= 12);
  assert.throws(() => s.setAppearance(db, { taskView: 'popup' as never }), /taskView/);
});

test('checklist subtasks: one level deep, ordered within their parent, removed with it', () => {
  const db = fresh();
  const t = s.createTask(db, { project_id: s.createProject(db, { title: 'P' }).id, title: 't' });
  const a = s.addChecklistItem(db, t.id, { text: 'Upgrade' });
  const b = s.addChecklistItem(db, t.id, { text: 'Test' });
  const a1 = s.addChecklistItem(db, t.id, { text: 'Stop service', parent_id: a.id });
  const a2 = s.addChecklistItem(db, t.id, { text: 'Swap binary', parent_id: a.id });
  assert.throws(() => s.addChecklistItem(db, t.id, { text: 'too deep', parent_id: a1.id }), /one level/);
  assert.throws(() => s.reorderChecklist(db, t.id, [a2.id, a1.id]), /every/, 'top-level order needs the top-level ids');
  s.reorderChecklist(db, t.id, [a2.id, a1.id], a.id);
  const list = s.getTask(db, t.id).checklist;
  assert.deepEqual(list.map(i => [i.text, i.parent_id]), [['Upgrade', null], ['Swap binary', a.id], ['Stop service', a.id], ['Test', null]]);
  s.deleteChecklistItem(db, a.id);
  assert.deepEqual(s.getTask(db, t.id).checklist.map(i => i.text), ['Test']);
  void b;
});

test('a field can be created for projects and tasks at once', () => {
  const db = fresh();
  const made = s.createFieldForTargets(db, { name: 'Owner', type: 'text', target: 'both' });
  assert.deepEqual(made.map(f => f.target), ['project', 'task']);
  assert.throws(() => s.createFieldForTargets(db, { name: 'Owner', type: 'text', target: 'both' }), /already exists/);
  assert.equal(s.listFields(db).filter(f => f.name === 'Owner').length, 2, 'failed second attempt left nothing half-made');
});

test('requirements: a second list on the task, kept apart from the checklist, with its own style and on/off switch', () => {
  const db = fresh();
  const t = s.createTask(db, { project_id: s.createProject(db, { title: 'P' }).id, title: 't' });
  assert.equal(s.getTask(db, t.id).requirements_enabled, false);
  const domain = s.addChecklistItem(db, t.id, { text: 'Domain name', list: 'requirements' });
  s.addChecklistItem(db, t.id, { text: 'DNS record', list: 'requirements', parent_id: domain.id });
  const pi = s.addChecklistItem(db, t.id, { text: 'Raspberry Pi 5', list: 'requirements' });
  s.addChecklistItem(db, t.id, { text: 'Flash SD card' });
  let task = s.getTask(db, t.id);
  assert.equal(task.requirements_enabled, true, 'adding a requirement switches the list on');
  assert.deepEqual(task.requirements.map(i => i.text), ['Domain name', 'DNS record', 'Raspberry Pi 5']);
  assert.deepEqual(task.checklist.map(i => i.text), ['Flash SD card']);
  assert.throws(() => s.addChecklistItem(db, t.id, { text: 'x', parent_id: domain.id }), /other list/);
  s.reorderChecklist(db, t.id, [pi.id, domain.id], null, 'requirements');
  task = s.updateTask(db, t.id, { requirements_style: 'numbered', requirements_enabled: false });
  assert.deepEqual([task.requirements[0].text, task.requirements_style, task.requirements_enabled], ['Raspberry Pi 5', 'numbered', false]);
  assert.ok(s.listEvents(db, t.id).some(e => e.detail === 'added requirement “Domain name”'));
});

test('resources: rich text becomes list items; every list has its own on/off switch', () => {
  assert.deepEqual(htmlToLines('<p>ChatGPT: <a href="https://chatgpt.com/c/1">https://chatgpt.com/c/1</a></p><p>Docs <a href="https://x.dev">here</a></p><ul><li>Pi 5 &amp; case</li></ul><p></p>'),
    ['ChatGPT: https://chatgpt.com/c/1', 'Docs here (https://x.dev)', 'Pi 5 & case']);
  const db = fresh();
  const t = s.createTask(db, { project_id: s.createProject(db, { title: 'P' }).id, title: 't', resources: ['https://github.com/example/rackdb'] });
  let task = s.getTask(db, t.id);
  assert.deepEqual(task.resources.map(r => r.text), ['https://github.com/example/rackdb']);
  assert.deepEqual([task.checklist_enabled, task.resources_enabled, task.requirements_enabled], [false, true, false], 'only lists given items start on');
  task = s.updateTask(db, t.id, { checklist_enabled: false, resources_enabled: false, resources_style: 'numbered' });
  assert.deepEqual([task.checklist_enabled, task.resources_enabled, task.resources_style], [false, false, 'numbered']);
  s.addChecklistItem(db, t.id, { text: 'Wiki page', list: 'resources' });
  assert.equal(s.getTask(db, t.id).resources_enabled, true, 'adding an item switches its list back on');
  assert.equal(s.listTasks(db, { q: 'Wiki page' }).length, 1, 'search covers list items');
});

test('old rich-text Resources are converted to items once', () => {
  const db = fresh();
  const t = s.createTask(db, { project_id: s.createProject(db, { title: 'P' }).id, title: 't' });
  db.prepare('UPDATE tasks SET resources=? WHERE id=?').run('<p>GitHub: <a href="https://github.com/x">https://github.com/x</a></p>', t.id);
  listifyResources(db);
  assert.deepEqual(s.getTask(db, t.id).resources.map(r => r.text), ['GitHub: https://github.com/x']);
  listifyResources(db);
  assert.equal(s.getTask(db, t.id).resources.length, 1, 'running again does not duplicate');
});

test('lists are off until used; the one-off fix-up keeps lists that already have items switched on', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'P' });
  const bare = s.createTask(db, { project_id: p.id, title: 'bare' });
  assert.deepEqual([bare.checklist_enabled, bare.requirements_enabled, bare.resources_enabled], [false, false, false]);
  const used = s.createTask(db, { project_id: p.id, title: 'used', checklist: ['step'] });
  db.prepare('UPDATE tasks SET checklist_enabled=1, resources_enabled=1').run(); // what older versions stored
  listsOffUnlessUsed(db);
  assert.deepEqual([s.getTask(db, bare.id).checklist_enabled, s.getTask(db, bare.id).resources_enabled], [false, false]);
  assert.deepEqual([s.getTask(db, used.id).checklist_enabled, s.getTask(db, used.id).resources_enabled], [true, false]);
});

test('logbook: entries per project, filtered by type, time and sub-projects, tagged with who wrote them', () => {
  const db = fresh();
  const lab = s.createProject(db, { title: 'Lab' });
  const server2 = s.createProject(db, { title: 'server2', parent_id: lab.id });
  const t = s.createTask(db, { project_id: server2.id, title: 'Patch' });
  const a = s.actor.run('mcp', () => s.createLog(db, { project_id: server2.id, kind: 'change', title: 'Upgraded Docker', body: '<p>28 → 29</p>', rollback: '<p>apt install docker-ce=28</p>', task_id: t.id }));
  s.createLog(db, { project_id: lab.id, kind: 'incident', title: 'Power cut', at: '2026-10-01T10:00:00Z' });
  assert.equal(a.actor, 'mcp');
  assert.equal(a.task_title, 'Patch');
  assert.deepEqual(s.listLog(db, { projectId: lab.id }).map(e => e.title), ['Upgraded Docker', 'Power cut'], 'newest first, sub-projects included');
  assert.equal(s.listLog(db, { projectId: lab.id, includeSub: false }).length, 1);
  assert.deepEqual(s.listLog(db, { kind: 'incident' }).map(e => e.title), ['Power cut']);
  assert.deepEqual(s.listLog(db, { since: '2026-10-02T00:00:00Z' }).map(e => e.title), ['Upgraded Docker']);
  assert.throws(() => s.createLog(db, { project_id: server2.id, kind: 'oops' as never, title: 'x' }), /kind/);
  assert.throws(() => s.createLog(db, { project_id: server2.id, kind: 'change', title: ' ' }), /title/);
  assert.equal(s.updateLog(db, a.id, { rollback: '' }).rollback, '');
  assert.ok(s.listEvents(db, t.id).some(e => e.detail === 'logged change “Upgraded Docker”'));
  s.deleteLog(db, a.id);
  assert.equal(s.listLog(db, {}).length, 1);
});

test('maintenance: next due follows the interval, Mark Done logs it, overdue is flagged', () => {
  assert.equal(s.addInterval('2026-01-31', 1, 'month'), '2026-02-28');
  assert.equal(s.addInterval('2024-02-29', 1, 'year'), '2025-02-28');
  assert.equal(s.addInterval('2026-10-28', 2, 'week'), '2026-11-11');
  const db = fresh();
  const p = s.createProject(db, { title: 'server2' });
  const m = s.createMaintenance(db, { project_id: p.id, title: 'Test backup restore', every: 3, unit: 'month', next_due: '2020-01-01' });
  assert.equal(m.status, 'overdue');
  assert.equal(m.last_done, null);
  const { item, log } = s.markMaintenanceDone(db, m.id, { date: '2026-10-28', notes: '<p>Restored /etc from borg</p>' });
  assert.deepEqual([item.last_done, item.next_due], ['2026-10-28', '2027-01-28']);
  assert.deepEqual([log.kind, log.title, log.maintenance_id], ['maintenance', 'Test backup restore', m.id]);
  assert.equal(s.updateMaintenance(db, m.id, { every: 1, unit: 'week' }).next_due, '2026-11-04', 'changing the interval re-plans from the last time it was done');
  assert.equal(s.listMaintenance(db, { overdue: true }).length, 0);
  assert.throws(() => s.createMaintenance(db, { project_id: p.id, title: 'x', every: 0, unit: 'day' }), /every/);
  assert.throws(() => s.createMaintenance(db, { project_id: p.id, title: 'x', every: 1, unit: 'fortnight' as never }), /unit/);
  s.deleteMaintenance(db, m.id);
  assert.equal(s.listMaintenance(db, {}).length, 0);
  assert.equal(s.listLog(db, {}).length, 1, 'the logbook keeps the record after the item is gone');
});

test('linked records: link fields point at projects, refuse loops, and answer what depends on a host', () => {
  const db = fresh();
  const runsOn = s.listFields(db, 'project').find(f => f.name === 'Runs On')!;
  assert.equal(runsOn.type, 'link');
  const host = s.listTypes(db).find(t => t.name === 'Host')!;
  assert.deepEqual(host.fields.map(f => f.name), ['Kind', 'IP Address', 'OS', 'Runs On']);
  const pve = s.createProject(db, { title: 'pve10', type_id: host.id, fields: { Kind: 'physical' } });
  const server2 = s.createProject(db, { title: 'server2', type_id: host.id, fields: { Kind: 'VM', 'Runs On': 'PVE10' } });
  const app = s.createProject(db, { title: 'WebApp', type_id: typeId(db, 'Application'), fields: { 'Runs On': server2.id } });
  assert.deepEqual(s.getProject(db, server2.id).fields.find(f => f.name === 'Runs On'), { ...s.getProject(db, server2.id).fields.find(f => f.name === 'Runs On')!, value: String(pve.id), display: 'pve10' });
  assert.throws(() => s.setFieldValues(db, 'project', pve.id, { 'Runs On': app.id }), /loop/);
  assert.throws(() => s.setFieldValues(db, 'project', server2.id, { 'Runs On': server2.id }), /itself/);
  assert.throws(() => s.setFieldValues(db, 'project', server2.id, { 'Runs On': 'nope' }), /No project/);
  assert.deepEqual(s.dependents(db, server2.id).map(d => d.title), ['WebApp']);
  assert.deepEqual(s.dependents(db, pve.id, true).map(d => [d.title, d.depth]), [['server2', 1], ['WebApp', 2]]);
  const tree = s.infraTree(db);
  assert.equal(tree.length, 1);
  assert.deepEqual([tree[0].title, tree[0].children[0].title, tree[0].children[0].children[0].title], ['pve10', 'server2', 'WebApp']);
  assert.equal(s.listProjects(db, { filters: [{ field: 'Runs On', op: 'eq', value: 'server2' }] }).length, 1);
  s.deleteProject(db, server2.id);
  assert.equal(s.getProject(db, app.id).fields.find(f => f.name === 'Runs On')!.value, null, 'links to a deleted project are cleared');
});

test('a database from before link fields (old CHECK, with triggers) upgrades in place', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'smj-')), 'old.db');
  const old = openDb(p);
  const proj = s.createProject(old, { title: 'App', type_id: typeId(old, 'Application'), fields: { Host: 'server1' } });
  // put the table back the way older versions created it
  old.exec(`PRAGMA foreign_keys=OFF; BEGIN;
    CREATE TABLE f2 (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('text','number','date','select','checkbox','url')),
      target TEXT NOT NULL CHECK (target IN ('project','task')), options TEXT NOT NULL DEFAULT '[]', UNIQUE (name, target));
    INSERT INTO f2 SELECT * FROM fields WHERE type<>'link';
    DELETE FROM type_fields WHERE field_id IN (SELECT id FROM fields WHERE type='link');
    DROP TRIGGER projects_del_values; DROP TRIGGER tasks_del_values; DROP TRIGGER projects_del_links;
    DROP TABLE fields; ALTER TABLE f2 RENAME TO fields; COMMIT;`);
  old.exec(`CREATE TRIGGER projects_del_values AFTER DELETE ON projects BEGIN
    DELETE FROM field_values WHERE entity_id = OLD.id AND field_id IN (SELECT id FROM fields WHERE target='project'); END;`);
  old.exec("DELETE FROM meta WHERE key='infra_seeded'");
  old.close();
  const db = openDb(p);
  assert.ok(s.listFields(db, 'project').some(f => f.name === 'Runs On' && f.type === 'link'));
  assert.equal(s.getProject(db, proj.id).fields.find(f => f.name === 'Host')!.value, 'server1', 'existing values survive');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  s.deleteProject(db, proj.id);
  assert.equal((db.prepare('SELECT count(*) n FROM field_values').get() as { n: number }).n, 0, 'triggers are back');
});

test('completing a task writes a Change entry to its project logbook, unless that project (or a parent) opts out', () => {
  const db = fresh();
  const lab = s.createProject(db, { title: 'Lab' });
  const ha = s.createProject(db, { title: 'HA tweaks', parent_id: lab.id });
  const t = s.createTask(db, { project_id: lab.id, title: 'Replace neofetch', resolution: '<p>Use fastfetch</p>' });
  s.updateTask(db, t.id, { done: true });
  const [e] = s.listLog(db, { projectId: lab.id });
  assert.deepEqual([e.kind, e.title, e.task_id, e.body], ['change', 'Replace neofetch', t.id, '<p>Use fastfetch</p>']);
  s.updateTask(db, t.id, { done: false });
  assert.equal(s.listLog(db, {}).length, 1, 'reopening does not log');
  assert.equal(s.getProject(db, lab.id).log_completed_effective, true, 'on by default');
  s.updateProject(db, lab.id, { log_completed: false });
  assert.deepEqual([s.getProject(db, ha.id).log_completed, s.getProject(db, ha.id).log_completed_effective], [null, false], 'sub-projects inherit');
  const t2 = s.createTask(db, { project_id: ha.id, title: 'Tweak card' });
  s.moveTask(db, t2.id, { bucketId: s.listBuckets(db, ha.id).at(-1)!.id });
  assert.equal(s.listLog(db, {}).length, 1, 'opted out: nothing logged');
  s.updateProject(db, ha.id, { log_completed: true });
  s.updateTask(db, t2.id, { done: false });
  s.updateTask(db, t2.id, { done: true });
  assert.equal(s.listLog(db, {}).length, 2, 'a sub-project can opt back in');
});

test('export everything to a zip and import it into another instance as copies, references remapped', () => {
  const src = fresh();
  const dirA = mkdtempSync(join(tmpdir(), 'smj-'));
  const img = s.createAttachment(src, dirA, { name: 'logo.png', mime: 'image/png', data: new Uint8Array([7, 7]) });
  const host = s.createProject(src, { title: 'pve10', type_id: typeId(src, 'Host'), icon: `img:${img.id}`, fields: { Kind: 'Physical' } });
  const app = s.createProject(src, { title: 'WebApp', type_id: typeId(src, 'Application'), fields: { 'Runs On': 'pve10', Host: 'server1' } });
  const t = s.createTask(src, { project_id: app.id, title: 'Replace neofetch', labels: ['Fix'], description: `<p><img src="/api/attachments/${img.id}"></p>`, checklist: ['Install'] });
  s.addChecklistItem(src, t.id, { text: 'Configure', parent_id: s.getTask(src, t.id).checklist[0].id });
  s.createComment(src, t.id, { body: '<p>note</p>' });
  s.createLog(src, { project_id: host.id, kind: 'change', title: 'Upgraded kernel' });
  s.createMaintenance(src, { project_id: host.id, title: 'Patch', every: 1, unit: 'month' });
  s.createToken(src, 'secret token');
  const zip = exportAll(src, dirA);

  const dst = fresh();
  const dirB = mkdtempSync(join(tmpdir(), 'smj-'));
  s.createProject(dst, { title: 'Already here' });
  const r = importAny(dst, dirB, zip);
  assert.equal(r.format, 'samunja');
  const pve = s.listProjects(dst).find(p => p.title === 'pve10')!;
  const webapp = s.listProjects(dst).find(p => p.title === 'WebApp')!;
  assert.equal(webapp.fields.find(f => f.name === 'Runs On')!.display, 'pve10', 'link remapped to the new host');
  assert.equal(webapp.fields.find(f => f.name === 'Host')!.value, 'server1');
  const newImg = Number(/^img:(\d+)$/.exec(pve.icon)![1]);
  assert.ok(existsSync(s.attachmentPath(dirB, newImg)), 'icon file copied');
  const task = s.listTasks(dst, { projectId: webapp.id })[0];
  assert.ok(task.description.includes(`/api/attachments/${newImg}`), 'attachment URL in text rewritten');
  assert.deepEqual(task.checklist.map(i => [i.text, i.parent_id === null]), [['Install', true], ['Configure', false]]);
  assert.deepEqual(task.labels.map(l => l.title), ['Fix']);
  assert.equal(s.listComments(dst, task.id).length, 1);
  assert.equal(s.listLog(dst, { projectId: pve.id }).length, 1);
  assert.equal(s.listMaintenance(dst, { projectId: pve.id }).length, 1);
  assert.equal(s.listTokens(dst).length, 0, 'tokens never travel');
  assert.equal(s.listFields(dst).filter(f => f.name === 'Runs On').length, 1, 'same-named fields reused');
  assert.throws(() => importAny(dst, dirB, zip), /already imported/);
  assert.throws(() => importAny(dst, dirB, new Uint8Array([1, 2, 3])), /not a zip/);
});

test('backups: snapshot + files in one zip, one per day after the set hour, oldest pruned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const db = openDb(join(dir, 'samunja.db'));
  s.createProject(db, { title: 'Keep me' });
  s.createAttachment(db, dir, { name: 'a.png', mime: 'image/png', data: new Uint8Array([1]) });
  const b = createBackup(db, dir, new Date('2026-10-01T04:00:00'));
  const zip = unzipSync(readFileSync(backupPath(dir, b.name)));
  assert.ok(zip['samunja.db'] && zip['files/1'] && zip['RESTORE.txt']);
  const snap = join(mkdtempSync(join(tmpdir(), 'smj-')), 'r.db');
  writeFileSync(snap, zip['samunja.db']);
  const restored = new DatabaseSync(snap);
  assert.equal((restored.prepare("SELECT title FROM projects").get() as { title: string }).title, 'Keep me', 'the snapshot opens and has the data');
  restored.close();
  setBackupSettings(db, { hour: 3, keep: 2 });
  assert.equal(backupIfDue(db, dir, new Date('2026-10-01T05:00:00')), null, 'already backed up today');
  assert.equal(backupIfDue(db, dir, new Date('2026-10-02T02:00:00')), null, 'before the hour');
  assert.ok(backupIfDue(db, dir, new Date('2026-10-02T03:30:00')));
  createBackup(db, dir, new Date('2026-10-03T03:00:00'));
  assert.equal(listBackups(dir).length, 2, 'kept 2');
  assert.throws(() => backupPath(dir, '../samunja.db'), /Not a backup/);
  assert.throws(() => setBackupSettings(db, { hour: 25 }), /hour/);
});

test('search finds projects, tasks (incl. list items), logbook entries, maintenance and runbooks', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'server2 host', description: '<p>Ubuntu VM</p>' });
  s.createTask(db, { project_id: p.id, title: 'Patch', checklist: ['Reboot server2 after kernel update'] });
  s.createLog(db, { project_id: p.id, kind: 'change', title: 'Docker upgraded', body: '<p>on server2</p>' });
  s.createMaintenance(db, { project_id: p.id, title: 'server2 restore test', every: 3, unit: 'month' });
  createRunbook(db, { project_id: p.id, title: 'Rebuild server2', steps: ['Restore from borg'] });
  const r = search(db, 'server2');
  assert.deepEqual([r.projects.length, r.tasks.length, r.log.length, r.maintenance.length, r.runbooks.length], [1, 1, 1, 1, 1]);
  assert.equal(r.tasks[0].snippet, 'Reboot server2 after kernel update');
  assert.deepEqual(search(db, ' ').projects, []);
});

test('templates: save a task or project as a template and create new ones from it', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'WebApp', type_id: typeId(db, 'Application'), fields: { Platform: 'Docker' } });
  const t = s.createTask(db, { project_id: p.id, title: 'Release checklist', labels: ['Changes'], issue: '<p>x</p>', checklist: ['Bump version', 'Tag'], resources: ['https://github.com/example/webapp'] });
  s.addChecklistItem(db, t.id, { text: 'Changelog', parent_id: s.getTask(db, t.id).checklist[0].id });
  const tt = saveTemplate(db, { kind: 'task', from_id: t.id, name: 'Release' });
  const other = s.createProject(db, { title: 'Other' });
  const copy = applyTemplate(db, tt.id, { project_id: other.id });
  const c = s.getTask(db, (copy as s.Task).id);
  assert.deepEqual([c.title, c.issue, c.labels.map(l => l.title), c.checklist.map(i => i.text), c.resources.map(i => i.text), c.checklist_enabled],
    ['Release checklist', '<p>x</p>', ['Changes'], ['Bump version', 'Changelog', 'Tag'], ['https://github.com/example/webapp'], true]);
  const pt = saveTemplate(db, { kind: 'project', from_id: p.id, name: 'Docker app' });
  const np = applyTemplate(db, pt.id, { title: 'SWNEW' }) as s.Project;
  assert.deepEqual([np.title, np.type_id, np.fields.find(f => f.name === 'Platform')!.value], ['SWNEW', p.type_id, 'Docker']);
  assert.deepEqual(s.listTasks(db, { projectId: np.id }).map(x => x.title), ['Release checklist']);
  assert.throws(() => saveTemplate(db, { kind: 'task', from_id: t.id, name: 'Release' }), /already/);
  deleteTemplate(db, tt.id);
  assert.equal(listTemplates(db).length, 1);
});

test('runbooks: steps per project (or global), attachable to maintenance, inherited down the tree', () => {
  const db = fresh();
  const pve = s.createProject(db, { title: 'pve10' });
  const vm = s.createProject(db, { title: 'server2', parent_id: pve.id });
  const rb = createRunbook(db, { project_id: pve.id, title: 'Restore a VM', steps: ['Stop VM', 'qmrestore', 'Start VM'], notes: '<p>borg repo on NAS</p>' });
  const glob = createRunbook(db, { title: 'Rotate certs', steps: ['certbot renew'] });
  assert.deepEqual(listRunbooks(db, { projectId: vm.id }).map(r => r.title), ['Restore a VM', 'Rotate certs'], 'parent and global runbooks apply');
  assert.deepEqual(updateRunbook(db, rb.id, { steps: ['Stop VM', ' ', 'Start VM'] }).steps, ['Stop VM', 'Start VM'], 'blank steps dropped');
  const m = s.createMaintenance(db, { project_id: vm.id, title: 'Restore test', every: 3, unit: 'month', runbook_id: rb.id });
  assert.equal(m.runbook_id, rb.id);
  assert.throws(() => createRunbook(db, { title: ' ', steps: [] }), /title/);
  deleteRunbook(db, rb.id);
  assert.equal(s.getMaintenance(db, m.id).runbook_id, null);
  void glob;
});

test('runbooks: a task pins the project, lists are cleaned, changing project drops the task', () => {
  const db = fresh();
  const a = s.createProject(db, { title: 'pve10' });
  const b = s.createProject(db, { title: 'server2' });
  const t = s.createTask(db, { project_id: a.id, title: 'Upgrade to PVE 9' });
  const r = createRunbook(db, {
    title: 'Upgrade', task_id: t.id, steps: ['<p><b>Back up</b></p>', '<p></p>'],
    lists: { tasks: { style: 'numbered', items: [{ id: 1, text: 'Snapshot' }, { id: 2, parent_id: 1, text: 'server2' }, { id: 3, parent_id: 9, text: 'orphan' }, { id: 4, text: ' ' }] } },
  });
  assert.equal(r.project_id, a.id, 'task sets the project');
  assert.equal(r.task_title, 'Upgrade to PVE 9');
  assert.deepEqual(r.steps, ['<p><b>Back up</b></p>'], 'empty rich steps dropped');
  assert.deepEqual(r.lists.tasks.items.map(i => [i.id, i.parent_id, i.position]), [[1, null, 0], [2, 1, 1]], 'orphans and blanks dropped');
  assert.equal(r.lists.tasks.style, 'numbered');
  assert.deepEqual([r.lists.requirements.enabled, r.lists.resources.enabled], [false, true], 'task defaults');
  const moved = updateRunbook(db, r.id, { project_id: b.id });
  assert.deepEqual([moved.project_id, moved.task_id], [b.id, null], 'task from another project dropped');
  assert.equal(moved.lists.tasks.items.length, 2, 'lists kept');
  const na = updateRunbook(db, r.id, { project_id: null });
  assert.deepEqual([na.project_id, na.task_id], [null, null]);
  s.deleteTask(db, updateRunbook(db, r.id, { task_id: t.id }).task_id!);
  assert.equal(listRunbooks(db)[0].task_id, null, 'deleting the task keeps the runbook');
});

test('sub-projects show the nearest parent\'s icon until they get their own', () => {
  const db = fresh();
  const host = s.createProject(db, { title: 'pve10', icon: 'server', color: '#e57000' });
  const lxc = s.createProject(db, { title: 'adguard', parent_id: host.id });
  const app = s.createProject(db, { title: 'blocklists', parent_id: lxc.id, color: '#2266aa' });
  assert.deepEqual([s.getProject(db, lxc.id).icon, s.getProject(db, lxc.id).color, s.getProject(db, lxc.id).icon_inherited], ['server', '#e57000', true]);
  assert.deepEqual([s.getProject(db, app.id).icon, s.getProject(db, app.id).color], ['server', '#2266aa']); // its own colour wins
  s.updateProject(db, host.id, { icon: 'cpu' });
  assert.equal(s.getProject(db, app.id).icon, 'cpu'); // follows the parent
  s.updateProject(db, lxc.id, { icon: 'shield' });
  assert.deepEqual([s.getProject(db, lxc.id).icon_inherited, s.getProject(db, app.id).icon], [false, 'shield']);
  assert.equal(s.getProject(db, host.id).icon_inherited, false);
  s.setFieldValues(db, 'project', lxc.id, {}); // no-op
  assert.equal(search(db, 'blocklists').projects[0].icon, 'shield');
});

test('appearance keeps the sidebar layout and checks it', () => {
  const db = fresh();
  assert.deepEqual(s.getAppearance(db).nav, { order: [], hidden: ['projects'] });
  s.setAppearance(db, { nav: { order: ['network', 'tasks'], hidden: [] }, showArchived: true, theme: 'tokyo-night' });
  const a = s.getAppearance(db);
  assert.deepEqual([a.nav.order, a.nav.hidden, a.showArchived, a.theme], [['network', 'tasks'], [], true, 'tokyo-night']);
  assert.throws(() => s.setAppearance(db, { nav: { order: ['<script>'], hidden: [] } }), /menu item ids/);
  assert.throws(() => s.setAppearance(db, { theme: 'neon' as never }), /theme must be/);
});

test('runbook runs: start, tick, finish into the logbook; maintenance records one; record in one go', () => {
  const db = fresh();
  const p = s.createProject(db, { title: 'pve10' });
  const rb = createRunbook(db, { project_id: p.id, title: 'Patch <LXCs>', steps: ['<p>Snapshot</p>', '<p><b>apt</b> upgrade</p>', '<p>Reboot</p>'] });
  const run = startRun(db, rb.id);
  assert.equal(startRun(db, rb.id).id, run.id, 'one run in progress per runbook');
  assert.equal(getRunbook(db, rb.id).active_run_id, run.id);
  assert.deepEqual(updateRun(db, run.id, { ticked: [2, 0, 0, 7, -1] }).ticked, [0, 2], 'ticks cleaned');
  const done = finishRun(db, run.id, { notes: '<p>all fine</p>' });
  assert.ok(done.finished && done.log_id);
  const log = s.listLog(db, { projectId: p.id })[0];
  assert.equal(log.title, 'Ran runbook: Patch <LXCs>');
  assert.equal(log.kind, 'change');
  assert.match(log.body, /Patch &lt;LXCs><\/strong>: 2 of 3 steps done/);
  assert.match(log.body, /<li><p>2\. apt upgrade<\/p><\/li>/, 'skipped step listed as text');
  assert.match(log.body, /all fine/);
  assert.throws(() => updateRun(db, run.id, { ticked: [1] }), /finished/);
  const rb2 = getRunbook(db, rb.id);
  assert.deepEqual([rb2.runs, rb2.active_run_id, rb2.last_run], [1, null, done.finished]);

  const m = s.createMaintenance(db, { project_id: p.id, title: 'Monthly patching', every: 1, unit: 'month', runbook_id: rb.id });
  const md = maintenanceDone(db, m.id, { notes: '<p>ok</p>', runbook_ticked: [0, 1, 2] });
  assert.match(md.log.body, /<p>ok<\/p>.*3 of 3 steps done/);
  assert.equal(s.listLog(db, { projectId: p.id }).length, 2, 'no second logbook entry for the run');
  assert.deepEqual([md.run!.maintenance_id, md.run!.log_id], [m.id, md.log.id]);

  const quiet = recordRun(db, rb.id, { ticked: [1], project_id: null });
  assert.equal(quiet.log_id, null, 'project null: not logged');
  assert.deepEqual(listRuns(db, rb.id).map(r => r.id), [quiet.id, md.run!.id, run.id], 'newest first');
  deleteRun(db, quiet.id);
  assert.equal(listRuns(db, rb.id).length, 2);
});
