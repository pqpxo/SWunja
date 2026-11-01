import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { createActivity, getActivity, listActivity, pruneActivity, redact } from './activity.ts';

const fresh = () => openDb(':memory:');

test('redacts', () => {
  assert.equal(redact('mysql -u root -phunter2 db'), 'mysql -u root -p•••• db');
  assert.equal(redact('mysql --password=hunter2'), 'mysql --password=••••');
  assert.equal(redact('export API_TOKEN=abc123'), 'export API_TOKEN=••••');
  assert.equal(redact("curl -H 'Authorization: Bearer sk-ant-xyz'"), "curl -H 'Authorization: Bearer ••••'");
  assert.equal(redact('echo 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'), 'echo ••••');
  assert.equal(redact('curl "https://x/api?token=abc&q=1"'), 'curl "https://x/api?token=••••&q=1"');
  assert.equal(redact('cat .env.production'), 'cat .env.production');
  assert.equal(redact('docker compose up -d'), 'docker compose up -d');
  assert.equal(redact('ls -la /tmp'), 'ls -la /tmp', 'flags that look like -p stay when they are not mysql-style passwords');
  // quoted values and other common password-in-command forms (review finding 1 and 2)
  assert.equal(redact('export DB_PASSWORD="hunter2"'), 'export DB_PASSWORD=••••');
  assert.equal(redact("export API_TOKEN='abc 123'"), 'export API_TOKEN=••••');
  assert.equal(redact("curl 'https://x/?token=abc'"), "curl 'https://x/?token=••••'");
  assert.equal(redact('mysql --password "my secret" db'), 'mysql --password •••• db');
  assert.equal(redact('curl -u admin:hunter2 https://x'), 'curl -u admin:•••• https://x');
  assert.equal(redact('psql postgres://app:hunter2@db/app'), 'psql postgres://app:••••@db/app');
  assert.equal(redact('git clone https://bob:pw123@host/x.git'), 'git clone https://bob:••••@host/x.git');
  assert.equal(redact('sshpass -p hunter2 ssh root@h'), 'sshpass -p •••• ssh root@h');
  assert.equal(redact('curl -H "X-Api-Key: abcd1234" https://x'), 'curl -H "X-Api-Key: ••••" https://x');
  assert.equal(redact('echo password: hunter2'), 'echo password: ••••');
  assert.equal(redact('mysql -u root db'), 'mysql -u root db', '-u without a colon is a user name');
  assert.equal(redact('docker run -p8080:80 nginx'), 'docker run -p8080:80 nginx', 'ports are not passwords');
  assert.equal(redact('ssh -p2222 root@h'), 'ssh -p2222 root@h');
  assert.equal(redact('mysqldump -uroot -phunter2 db > d.sql'), 'mysqldump -uroot -p•••• db > d.sql');
  assert.equal(redact('mariadb -phunter2'), 'mariadb -p••••');
});

test('createActivity stores redacted, capped lists; same batch_id twice → one item', () => {
  const db = fresh();
  const a = createActivity(db, {
    source: 'swjtrack', host: 'server2', folder: '/home/u/app', batch_id: 'b1',
    commands: [{ cmd: 'mysql -phunter2' }, ...Array.from({ length: 600 }, (_, i) => ({ cmd: `ls ${i}` }))],
    prompts: ['x'.repeat(5000)],
  });
  assert.equal(a.commands!.length, 500);
  assert.equal(a.commands![0].cmd, 'mysql -p••••');
  assert.equal(a.prompts![0].length, 2000);
  assert.equal(a.status, 'pending');
  assert.equal(a.suggestion, null);
  assert.equal(createActivity(db, { source: 'swjtrack', host: 'server2', folder: '/home/u/app', batch_id: 'b1' }).id, a.id);
  assert.equal(listActivity(db).length, 1);
  assert.throws(() => createActivity(db, { source: 'nope' as any, host: 'server2', folder: '/x' }), /source/);
  assert.throws(() => createActivity(db, { source: 'mcp', host: 'server2', folder: ' ' }), /folder/);
});

test('pruneActivity removes dismissed items older than 30 days only', () => {
  const db = fresh();
  const mk = (status: string, daysOld: number, batch: string) => {
    const a = createActivity(db, { source: 'mcp', host: 'h', folder: '/f', batch_id: batch });
    db.prepare('UPDATE activity SET status=?, updated=? WHERE id=?').run(status, new Date(Date.now() - daysOld * 864e5).toISOString(), a.id);
    return a.id;
  };
  mk('dismissed', 31, 'a'); const recent = mk('dismissed', 1, 'b'); const pending = mk('pending', 60, 'c');
  assert.equal(pruneActivity(db), 1);
  assert.deepEqual(listActivity(db).map(a => a.id).sort(), [recent, pending].sort());
  assert.equal(getActivity(db, pending).status, 'pending');
});

import * as s from './services.ts';
import { bindingFor, deleteBinding, listBindings, normFolder, setBinding, shortlist } from './activity.ts';
const typeId = (db: ReturnType<typeof fresh>, name: string) => s.listTypes(db).find(t => t.name === name)!.id;

test('bindingFor matches the folder or a parent, longest wins, Windows paths normalised', () => {
  const db = fresh();
  const [p1, p2, p3] = ['a', 'b', 'c'].map(title => s.createProject(db, { title }));
  setBinding(db, '/home/u', p1.id); setBinding(db, '/home/u/app', p2.id);
  assert.equal(bindingFor(db, '/home/u/app/src')!.project_id, p2.id);
  assert.equal(bindingFor(db, '/home/u/application')!.project_id, p1.id, 'a sibling with a shared prefix is not a child of /home/u/app');
  setBinding(db, String.raw`C:\Users\S\vik\ `.trim(), p3.id);
  assert.equal(normFolder(String.raw`C:\Users\S\vik\ `.trim()), 'c:/Users/S/vik');
  assert.equal(bindingFor(db, 'c:/Users/S/vik/web')!.project_id, p3.id);
  assert.equal(bindingFor(db, '/srv'), null);
  assert.deepEqual(listBindings(db).map(b => b.project_title).sort(), ['a', 'b', 'c']);
  deleteBinding(db, '/home/u/app');
  assert.equal(bindingFor(db, '/home/u/app/src')!.project_id, p1.id);
});

test('shortlist ranks matching tasks first; host fields bring their project in; a binding restricts to that tree', () => {
  const db = fresh();
  const webapp = s.createProject(db, { title: 'WebApp' });
  const t = s.createTask(db, { project_id: webapp.id, title: 'Replace neofetch with fastfetch' });
  s.createTask(db, { project_id: webapp.id, title: 'Write the README' });
  const docker = s.createProject(db, { title: 'Docker', type_id: typeId(db, 'Host') });
  s.setFieldValues(db, 'project', docker.id, { 'IP Address': '192.168.1.20' });
  const other = s.createProject(db, { title: 'Other' });
  s.createTask(db, { project_id: other.id, title: 'fastfetch theme ideas' });
  const a = createActivity(db, { source: 'swjtrack', host: 'server2', folder: '/home/u/webapp',
    commands: [{ cmd: 'sudo apt install fastfetch' }, { cmd: 'sudo rm /usr/local/bin/neofetch' }, { cmd: 'ssh 192.168.1.20' }] });
  const list = shortlist(db, a);
  assert.equal(list[0].kind, 'task'); assert.equal(list[0].id, t.id);
  assert.equal(list[0].path, 'WebApp');
  assert.ok(list.some(c => c.kind === 'project' && c.id === docker.id), 'the project whose IP field matches is a candidate');
  setBinding(db, '/home/u/webapp', webapp.id);
  assert.ok(shortlist(db, a).every(c => c.project_id === webapp.id), 'binding narrows to the WebApp tree');
  assert.ok(shortlist(db, a).length <= 20);
});

test('a claude-code session partly reported in the chat (mcp, same folder, inside the session) stays waiting with a note', () => {
  const db = fresh();
  const chat = createActivity(db, { source: 'mcp', host: 'claude-code', folder: 'C:/Users/S/vik', summary: 'Did it' });
  db.prepare("UPDATE activity SET created='2026-10-30T10:30:00Z' WHERE id=?").run(chat.id);
  const hook = createActivity(db, { source: 'claude-code', host: 'PC', folder: String.raw`C:\Users\S\vik`, session_id: 's1',
    started: '2026-10-30T10:00:00Z', ended: '2026-10-30T11:00:00Z', files: [{ path: 'a.ts', change: 'edited', count: 1 }] });
  assert.equal(hook.status, 'pending', 'the rest of a long session is not hidden');
  assert.match(hook.error!, /Partly reported in chat/);
  const other = createActivity(db, { source: 'claude-code', host: 'PC', folder: 'C:/Users/S/other', session_id: 's2',
    started: '2026-10-30T10:00:00Z', ended: '2026-10-30T11:00:00Z' });
  assert.equal(other.status, 'pending', 'a different folder is kept');
});

import { getActivitySettings, heartbeat, remindUnsynced, setActivitySettings } from './activity.ts';

test('remindUnsynced sends once a day per folder and only past the threshold', async () => {
  const db = fresh();
  const sent: any[] = [];
  const send = async (m: any) => { sent.push(m); return []; };
  const now = new Date('2026-10-30T12:00:00Z');
  heartbeat(db, { host: 'server2', folder: '/home/u/app', unsynced_count: 23, oldest: '2026-10-29T11:00:00Z' }, now); // 25 h old
  heartbeat(db, { host: 'server2', folder: '/home/u/new', unsynced_count: 4, oldest: '2026-10-29T13:00:00Z' }, now); // 23 h old
  assert.equal(await remindUnsynced(db, { now, send }), 1);
  assert.equal(sent[0].event, 'activity');
  assert.equal(sent[0].title, 'Unsynced activity');
  assert.match(sent[0].message, /Have you synced your activity for \/home\/u\/app\? \(23 items, since .+\) on server2/);
  assert.equal(await remindUnsynced(db, { now: new Date('2026-10-30T20:00:00Z'), send }), 1, 'the other folder crossed 24 h, the first was reminded today');
  assert.equal(sent[1].message.includes('/home/u/new'), true);
  assert.equal(await remindUnsynced(db, { now: new Date('2026-10-31T12:30:00Z'), send }), 1, 'a day later the first folder is reminded again');
  setActivitySettings(db, { remind_hours: 48 });
  assert.equal(getActivitySettings(db).remind_hours, 48);
  assert.throws(() => setActivitySettings(db, { remind_hours: 0 }), /remind_hours/);
});

test('heartbeat with unsynced 0 clears the reminder', async () => {
  const db = fresh();
  const sent: any[] = [];
  const send = async (m: any) => { sent.push(m); return []; };
  const now = new Date('2026-10-30T12:00:00Z');
  heartbeat(db, { host: 'server2', folder: '/a', unsynced_count: 5, oldest: '2026-10-28T12:00:00Z' }, now);
  heartbeat(db, { host: 'server2', folder: '/a', unsynced_count: 0, oldest: null }, now);
  assert.equal(await remindUnsynced(db, { now, send }), 0);
  assert.throws(() => heartbeat(db, { host: '', folder: '/a', unsynced_count: 1, oldest: null }), /host/);
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChannel, listChannels } from './notify.ts';

test('channels that get maintenance alerts also get activity reminders after upgrading (once)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'smj-')), 'x.db');
  let db = openDb(file);
  const c1 = createChannel(db, { name: 'phone', kind: 'ntfy', config: { url: 'https://ntfy.sh', topic: 'x' }, events: ['maintenance', 'health'] });
  const c2 = createChannel(db, { name: 'ops', kind: 'ntfy', config: { url: 'https://ntfy.sh', topic: 'y' }, events: ['health'] });
  db.exec("DELETE FROM meta WHERE key='activity_event_added'");
  db.close();
  db = openDb(file);
  const ev = Object.fromEntries(listChannels(db).map(c => [c.id, c.events]));
  assert.deepEqual(ev[c1.id], ['maintenance', 'health', 'activity']);
  assert.deepEqual(ev[c2.id], ['health']);
  db.close();
});

test('reminders stop for folders whose host has gone quiet for a week', async () => {
  const db = fresh();
  const sent: any[] = [];
  heartbeat(db, { host: 'old', folder: '/gone', unsynced_count: 9, oldest: '2026-10-01T10:00:00Z' }, new Date('2026-10-02T10:00:00Z'));
  assert.equal(await remindUnsynced(db, { now: new Date('2026-10-30T12:00:00Z'), send: async m => { sent.push(m); } }), 0);
});
