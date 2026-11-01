import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import * as s from './services.ts';
import { closeProject } from './closure.ts';
import { homeSummary } from './home.ts';

test('home summary: done this week, top-level project progress with sub-projects, hosts, network counts', () => {
  const db = openDb(':memory:');
  const nas = s.createProject(db, { title: 'NAS' });
  const shares = s.createProject(db, { title: 'Shares', parent_id: nas.id });
  const ha = s.createProject(db, { title: 'Home Assistant' });
  const old = s.createProject(db, { title: 'Old' });
  for (const t of ['a', 'b', 'c']) s.createTask(db, { project_id: shares.id, title: t });
  const d = s.createTask(db, { project_id: nas.id, title: 'd' });
  s.updateTask(db, d.id, { done: true });
  const lastWeek = s.createTask(db, { project_id: ha.id, title: 'e' });
  s.updateTask(db, lastWeek.id, { done: true });
  db.prepare('UPDATE tasks SET done_at=? WHERE id=?').run(new Date(Date.now() - 10 * 864e5).toISOString(), lastWeek.id);
  closeProject(db, ha.id, { status: 'on_hold' });
  closeProject(db, old.id, { status: 'completed' });
  db.prepare("INSERT INTO activity_hosts (host, folder, unsynced, seen) VALUES ('server1', '/srv/a', 3, ?), ('server1', '/srv/b', 0, ?)").run(new Date().toISOString(), new Date(Date.now() - 864e5).toISOString());
  db.prepare("INSERT INTO networks (name, cidr) VALUES ('LAN', '192.168.1.0/24')").run();

  const h = homeSummary(db, ':memory:');
  assert.equal(h.done_week, 1);
  assert.equal(h.done_prev_week, 1);
  const byTitle = Object.fromEntries(h.projects.map(p => [p.title, p]));
  assert.deepEqual([byTitle.NAS.open, byTitle.NAS.done], [3, 1], 'sub-project tasks count towards the top-level project');
  assert.equal(byTitle['Home Assistant'].closed, 'on_hold');
  assert.equal(byTitle.Old, undefined, 'archived / closed-completed projects are left out');
  assert.deepEqual(h.hosts.map(x => ({ ...x })), [{ host: 'server1', folders: 2, unsynced: 3, seen: h.hosts[0].seen }]);
  assert.equal(h.network.subnets, 1);
  assert.equal(h.last_run, null);
  assert.match(h.version, /^\d+\.\d+\.\d+$/);
});
