// Home page summary: the counts and roll-ups that no other endpoint gives in one go.
import { listRunbooks } from './runbooks.ts';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { listBackups } from './backups.ts';
import { getDrive } from './gdrive.ts';
import { getClaude } from './claude.ts';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const n = (db: DatabaseSync, sql: string, ...a: (string | number)[]) => (db.prepare(sql).get(...a) as { n: number }).n;

export function homeSummary(db: DatabaseSync, dataDir: string) {
  const week = new Date(Date.now() - 7 * 864e5).toISOString(), fortnight = new Date(Date.now() - 14 * 864e5).toISOString();
  // each task counted once, against its top-level project (open and done across all sub-projects)
  const projects = db.prepare(`WITH RECURSIVE top(id, root) AS (SELECT id, id FROM projects WHERE parent_id IS NULL
      UNION ALL SELECT p.id, top.root FROM projects p JOIN top ON p.parent_id=top.id)
    SELECT r.id, r.title, r.color, r.icon, r.closed, sum(t.done=0) open, sum(t.done=1) done FROM projects r
    JOIN top ON top.root=r.id LEFT JOIN tasks t ON t.project_id=top.id
    WHERE r.parent_id IS NULL AND r.archived=0 GROUP BY r.id ORDER BY sum(t.done=0) DESC, r.title`).all() as
    { id: number; title: string; color: string; icon: string; closed: string | null; open: number | null; done: number | null }[];
  const backups = listBackups(dataDir);
  const drive = getDrive(db);
  const lastRun = db.prepare(`SELECT r.id, r.runbook_id, b.title, r.started, r.finished FROM runbook_runs r JOIN runbooks b ON b.id=r.runbook_id
    ORDER BY coalesce(r.finished, r.started) DESC LIMIT 1`).get() as { id: number; runbook_id: number; title: string; started: string; finished: string | null } | undefined;
  return {
    done_week: n(db, 'SELECT count(*) n FROM tasks WHERE done=1 AND done_at>=?', week),
    done_prev_week: n(db, 'SELECT count(*) n FROM tasks WHERE done=1 AND done_at>=? AND done_at<?', fortnight, week),
    projects: projects.map(p => ({ ...p, open: p.open ?? 0, done: p.done ?? 0 })),
    backup: { last: backups[0]?.created ?? null, kept: backups.length, drive: drive.connected, drive_last: drive.last_upload, drive_error: drive.last_error },
    hosts: db.prepare('SELECT host, count(*) folders, sum(unsynced) unsynced, max(seen) seen FROM activity_hosts GROUP BY host ORDER BY max(seen) DESC').all() as { host: string; folders: number; unsynced: number; seen: string }[],
    claude: getClaude(db).usage,
    network: { subnets: n(db, 'SELECT count(*) n FROM networks'), ports: n(db, 'SELECT count(*) n FROM ports'), clients: n(db, 'SELECT count(*) n FROM unifi_clients') },
    last_run: lastRun ?? null,
    // runbooks with a test reminder, soonest due first
    runbook_tests: listRunbooks(db).filter(r => r.test_due).map(r => ({ id: r.id, title: r.title, test_due: r.test_due!, last_run: r.last_run }))
      .sort((a, b) => a.test_due.localeCompare(b.test_due)),
    version: VERSION,
  };
}
