import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import * as s from './services.ts';
import { acceptActivity, bindingFor, createActivity, dismissActivity, getActivity, listActivity, listBindings, restoreActivity, setBinding } from './activity.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportAll, importAny } from './transfer.ts';
import { activityJobIfDue, getClaude, matchActivity, matchPending, setClaude } from './claude.ts';

const fresh = () => openDb(':memory:');
function world() {
  const db = fresh();
  const webapp = s.createProject(db, { title: 'WebApp' });
  const task = s.createTask(db, { project_id: webapp.id, title: 'Replace neofetch with fastfetch' });
  const other = s.createProject(db, { title: 'Other' });
  const a = createActivity(db, { source: 'swjtrack', host: 'server2', folder: '/home/u/webapp',
    commands: [{ cmd: 'sudo apt install fastfetch' }, { cmd: 'mysql -phunter2 -e "select 1"' }, { cmd: 'rm /usr/local/bin/neofetch' }] });
  return { db, webapp, task, other, a };
}
let seen: any;
const fake = (out: object | null, o: { usage?: object; stop_reason?: string; fail?: Error } = {}) => ({
  messages: { parse: async (req: any) => {
    seen = req;
    if (o.fail) throw o.fail;
    return { parsed_output: out, usage: o.usage ?? { input_tokens: 900, output_tokens: 60 }, stop_reason: o.stop_reason ?? 'end_turn' };
  } },
});

test('settings: model defaults to Haiku, the key is write-only, blank keeps it, null clears it', () => {
  const { db } = world();
  assert.deepEqual(getClaude(db), { model: 'claude-haiku-5-5', has_key: false, usage: { month: new Date().toISOString().slice(0, 7), input: 0, output: 0 } });
  setClaude(db, { key: 'sk-test', model: 'claude-sonnet-5-5' });
  assert.equal(getClaude(db).has_key, true);
  assert.ok(!JSON.stringify(getClaude(db)).includes('sk-test'));
  setClaude(db, { key: '' }); assert.equal(getClaude(db).has_key, true);
  setClaude(db, { key: null }); assert.equal(getClaude(db).has_key, false);
  assert.throws(() => setClaude(db, { model: ' ' }), /model/);
});

test('matches with Claude: target, summary, usage counted, model and effort from settings', async () => {
  const { db, task, a } = world();
  setClaude(db, { key: 'sk-test' });
  const m = await matchActivity(db, a.id, { client: fake({ target_id: `t:${task.id}`, confidence: 0.86, summary: 'Installed fastfetch and removed neofetch.', reason: 'commands mention fastfetch', alternative_ids: [] }) });
  assert.equal(m.status, 'matched');
  assert.deepEqual([m.suggestion!.target.kind, m.suggestion!.target.id, m.suggestion!.target.path], ['task', task.id, 'WebApp']);
  assert.equal(m.suggestion!.ai, true);
  assert.equal(m.suggestion!.summary, 'Installed fastfetch and removed neofetch.');
  assert.equal(seen.model, 'claude-haiku-5-5');
  assert.equal(seen.output_config.effort, 'low');
  assert.equal(seen.output_config.format.type, 'json_schema');
  assert.equal(seen.temperature, undefined);
  assert.equal(seen.max_tokens, 4096, 'room for adaptive thinking on Haiku');
  assert.deepEqual([getClaude(db).usage.input, getClaude(db).usage.output], [900, 60]);
});

test('prompt contains no secrets', async () => {
  const { db, task, a } = world();
  await matchActivity(db, a.id, { client: fake({ target_id: `t:${task.id}`, confidence: 0.5, summary: 'x', reason: 'y', alternative_ids: [] }) });
  assert.ok(!JSON.stringify(seen).includes('hunter2'));
});

test('project match carries a task title; alternatives resolve to targets', async () => {
  const { db, webapp, task, a } = world();
  const m = await matchActivity(db, a.id, { client: fake({ target_id: `p:${webapp.id}`, confidence: 0.6, summary: 'Set up fastfetch.', reason: 'r', task_title: 'Set up fastfetch', alternative_ids: [`t:${task.id}`, 't:99999'] }) });
  assert.deepEqual([m.suggestion!.target.kind, m.suggestion!.target.id, m.suggestion!.task_title], ['project', webapp.id, 'Set up fastfetch']);
  assert.deepEqual(m.suggestion!.alternatives.map(t => t.id), [task.id], 'unknown ids are dropped');
});

test('falls back on API error, refusal, unknown id, and without a key', async () => {
  const { db, task, a } = world();
  const cases = [
    fake(null, { fail: new Error('401 invalid x-api-key') }),
    fake(null, { stop_reason: 'refusal' }),
    fake({ target_id: 't:99999', confidence: 0.9, summary: 's', reason: 'r', alternative_ids: [] }),
  ];
  for (const client of cases) {
    const m = await matchActivity(db, a.id, { client });
    assert.equal(m.status, 'matched');
    assert.equal(m.suggestion!.ai, false);
    assert.ok(m.suggestion!.error, 'error explains why AI was not used');
    assert.equal(m.suggestion!.target.id, task.id, 'shortlist top candidate');
    assert.match(m.suggestion!.summary, /3 commands/);
  }
  const noKey = await matchActivity(db, a.id, { client: null });
  assert.equal(noKey.suggestion!.ai, false);
  assert.equal(noKey.suggestion!.error, undefined);
});

test('a folder binding narrows candidates to that project tree', async () => {
  const { db, other, a } = world();
  s.createTask(db, { project_id: other.id, title: 'Tidy up' });
  setBinding(db, a.folder, other.id);
  await matchActivity(db, a.id, { client: fake({ target_id: 'p:1', confidence: 0.1, summary: 's', reason: 'r', alternative_ids: [] }) });
  const listed = String(seen.messages[0].content);
  assert.ok(listed.includes('Tidy up') && !listed.includes('Replace neofetch'));
});

test('matchPending matches every pending item and leaves others alone', async () => {
  const { db, a } = world();
  const b = createActivity(db, { source: 'mcp', host: 'h', folder: '/x', summary: 'did a thing' });
  db.prepare("UPDATE activity SET status='accepted' WHERE id=?").run(b.id);
  assert.equal(await matchPending(db, { client: null }), 1);
  assert.equal(getActivity(db, a.id).status, 'matched');
  assert.equal(getActivity(db, b.id).status, 'accepted');
});

test('accept writes one agent comment and one activity event, binds the folder, touches nothing else', async () => {
  const { db, task, a } = world();
  await matchActivity(db, a.id, { client: fake({ target_id: `t:${task.id}`, confidence: 0.9, summary: 'Installed fastfetch.', reason: 'r', alternative_ids: [] }) });
  const before = s.getTask(db, task.id);
  const r = acceptActivity(db, a.id);
  assert.equal(r.task_id, task.id);
  const cs = s.listComments(db, task.id);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].source, 'agent');
  assert.match(cs[0].body, /<p>Installed fastfetch\.<\/p>/);
  assert.match(cs[0].body, /From swjtrack on server2, \/home\/u\/webapp · 3 commands/);
  assert.ok(!cs[0].body.includes('hunter2'));
  const evs = s.listEvents(db, task.id);
  const ev = evs.find(e => e.kind === 'activity')!;
  assert.equal(ev.actor, 'agent');
  assert.equal(JSON.parse(ev.detail).commands.length, 3);
  assert.equal(evs.filter(e => e.kind === 'commented').length, 0, 'the activity record stands in for the usual "commented" entry');
  assert.equal(bindingFor(db, a.folder)!.project_id, task.project_id);
  const after = getActivity(db, a.id);
  assert.deepEqual([after.status, after.task_id], ['accepted', task.id]);
  const t = s.getTask(db, task.id);
  assert.deepEqual([t.done, t.title, t.checklist.length], [before.done, before.title, before.checklist.length], 'task untouched');
  assert.throws(() => acceptActivity(db, a.id), /already/);
});

test('accept onto a project creates the task first; picking another task works', async () => {
  const { db, webapp, other, a } = world();
  await matchActivity(db, a.id, { client: fake({ target_id: `p:${webapp.id}`, confidence: 0.6, summary: 'Set up fastfetch.', reason: 'r', task_title: 'Set up fastfetch', alternative_ids: [] }) });
  const r = acceptActivity(db, a.id);
  const t = s.getTask(db, r.task_id);
  assert.deepEqual([t.title, t.project_id], ['Set up fastfetch', webapp.id]);
  const b = createActivity(db, { source: 'mcp', host: 'h', folder: '/y', summary: 'Other work' });
  const t2 = s.createTask(db, { project_id: other.id, title: 'Chosen' });
  assert.equal(acceptActivity(db, b.id, { task_id: t2.id }).task_id, t2.id, 'an unmatched item can be accepted onto a chosen task');
  const c = createActivity(db, { source: 'mcp', host: 'h', folder: '/z', summary: 'New thing' });
  const r3 = acceptActivity(db, c.id, { project_id: other.id, task_title: 'Brand new' });
  assert.equal(s.getTask(db, r3.task_id).title, 'Brand new');
});

test('accept onto a deleted task fails cleanly', async () => {
  const { db, task, a } = world();
  await matchActivity(db, a.id, { client: fake({ target_id: `t:${task.id}`, confidence: 0.9, summary: 's', reason: 'r', alternative_ids: [] }) });
  s.deleteTask(db, task.id);
  assert.throws(() => acceptActivity(db, a.id), (e: any) => e.status === 400 && /no longer exists/.test(e.message));
  assert.equal(getActivity(db, a.id).status, 'matched');
});

test('dismiss writes nothing to tasks; a dismissed item cannot be accepted', async () => {
  const { db, task, a } = world();
  await matchActivity(db, a.id, { client: null });
  assert.equal(dismissActivity(db, a.id).status, 'dismissed');
  assert.equal(s.listComments(db, task.id).length, 0);
  assert.throws(() => acceptActivity(db, a.id), /dismissed/);
});

test('a dismissed item can be restored with its suggestion and then accepted', async () => {
  const { db, task, a } = world();
  await matchActivity(db, a.id, { client: null });
  dismissActivity(db, a.id);
  const back = restoreActivity(db, a.id);
  assert.equal(back.status, 'matched');
  assert.ok(back.suggestion, 'suggestion kept');
  assert.throws(() => restoreActivity(db, a.id), (e: any) => e.status === 400);
  acceptActivity(db, a.id, { task_id: task.id });
  assert.equal(s.listComments(db, task.id).length, 1);
  const b = createActivity(db, { source: 'mcp', host: 'h', folder: '/x', summary: 'never matched' });
  dismissActivity(db, b.id);
  assert.equal(restoreActivity(db, b.id).status, 'pending', 'no suggestion yet, so it waits to be matched');
});

test('activity job runs at most hourly', async () => {
  const { db } = world();
  const t0 = new Date('2026-10-30T10:00:00Z');
  await activityJobIfDue(db, t0);
  const b = createActivity(db, { source: 'mcp', host: 'h', folder: '/home/u/webapp', summary: 'fastfetch' });
  await activityJobIfDue(db, new Date('2026-10-30T10:30:00Z'));
  assert.equal(getActivity(db, b.id).status, 'pending', 'not due yet');
  await activityJobIfDue(db, new Date('2026-10-30T11:01:00Z'));
  assert.equal(getActivity(db, b.id).status, 'matched');
});

test('export/import carries activity (task remapped) and folder memory', async () => {
  const { db, task, a } = world();
  await matchActivity(db, a.id, { client: null });
  acceptActivity(db, a.id);
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const dst = fresh();
  importAny(dst, dir, exportAll(db, dir));
  const [copy] = listActivity(dst);
  assert.equal(copy.status, 'accepted');
  assert.equal(s.getTask(dst, copy.task_id!).title, task.title);
  assert.equal(listBindings(dst)[0].project_title, 'WebApp');
});

test('with a key, items matched without AI (no key yet, or an API error) are matched again', async () => {
  const { db, task, a } = world();
  await matchActivity(db, a.id, { client: null });
  assert.equal(getActivity(db, a.id).suggestion!.ai, false);
  assert.equal(await matchPending(db, { client: null }), 0, 'without a key nothing is redone');
  const n = await matchPending(db, { client: fake({ target_id: `t:${task.id}`, confidence: 0.9, summary: 'Installed fastfetch.', reason: 'r', alternative_ids: [] }) });
  assert.equal(n, 1);
  assert.equal(getActivity(db, a.id).suggestion!.ai, true);
});

test('import sends waiting items back to be matched (their suggestion ids belong to the old database)', async () => {
  const { db, a } = world();
  await matchActivity(db, a.id, { client: null });
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const dst = fresh();
  s.createProject(dst, { title: 'Shifts the ids' });
  importAny(dst, dir, exportAll(db, dir));
  const [copy] = listActivity(dst);
  assert.deepEqual([copy.status, copy.suggestion], ['pending', null]);
});

test('the activity job does not wait for slow matching (other jobs keep their schedule)', async () => {
  const { db } = world();
  let started = false;
  const hang = () => { started = true; return new Promise<number>(() => {}); };
  await activityJobIfDue(db, new Date('2026-10-30T10:00:00Z'), { match: hang });
  assert.ok(started);
});

test('bad start/end times are dropped on arrival, so accepting never fails on them', async () => {
  const { db, task } = world();
  const a = createActivity(db, { source: 'mcp', host: 'h', folder: '/home/u/webapp', summary: 'fastfetch', started: 'yesterday-ish', ended: 'not a date' });
  assert.deepEqual([a.started, a.ended], [null, null]);
  assert.equal(acceptActivity(db, a.id, { task_id: task.id }).task_id, task.id);
});

test('the time range in an accepted comment is UK time (BST in summer)', async () => {
  const { db, task } = world();
  const a = createActivity(db, { source: 'swjtrack', host: 'h', folder: '/f', summary: 'x', started: '2026-07-01T10:00:00Z', ended: '2026-07-01T10:30:00Z', commands: [{ cmd: 'ls' }] });
  acceptActivity(db, a.id, { task_id: task.id });
  assert.match(s.listComments(db, task.id)[0].body, /11:00–11:30/);
});
