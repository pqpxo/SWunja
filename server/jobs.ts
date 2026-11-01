// Background jobs, run in-process every few minutes. Each job decides for itself whether it is due.
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyBaseLogger } from 'fastify';
import { backupIfDue } from './backups.ts';
import { uploadJob } from './gdrive.ts';
import { runDueChecks } from './health.ts';
import { notify, notifyOverdue } from './notify.ts';
import { remindUnsynced } from './activity.ts';
import { checkUpdates } from './updates.ts';
import { refreshClientsIfDue } from './unifi.ts';
import { activityJobIfDue } from './claude.ts';

type Job = { name: string; run: () => unknown | Promise<unknown> };

export function startJobs(db: DatabaseSync, dataDir: string, log: FastifyBaseLogger, extra: Job[] = []) {
  const jobs: Job[] = [
    { name: 'backup', run: () => backupIfDue(db, dataDir) },
    { name: 'gdrive', run: () => uploadJob(db, dataDir) },
    { name: 'health', run: () => runDueChecks(db) },
    { name: 'maintenance-overdue', run: () => notifyOverdue(db) },
    { name: 'updates', run: () => checkUpdates(db) },
    { name: 'unifi-clients', run: () => refreshClientsIfDue(db) },
    { name: 'activity', run: () => activityJobIfDue(db) },
    { name: 'activity-reminders', run: () => remindUnsynced(db, { send: m => notify(db, m) }) },
    ...extra,
  ];
  let busy = false;
  const tick = async () => {
    if (busy) return; // a slow job (e.g. many health checks) never overlaps the next tick
    busy = true;
    for (const j of jobs) {
      try { await j.run(); } catch (e) { log.error({ job: j.name, err: e }, 'background job failed'); }
    }
    busy = false;
  };
  setTimeout(tick, 30_000);
  return setInterval(tick, 60_000);
}
