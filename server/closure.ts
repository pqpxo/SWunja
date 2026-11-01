// Closing tasks and projects: Completed, Abandoned or On Hold, with notes, an abandon reason, a "replaced by" link,
// lessons learned, and optionally a logbook entry. Reopening clears it (task history keeps what happened).
import type { DatabaseSync } from 'node:sqlite';
import { tx } from './db.ts';
import { HttpError, actor, completed, createLog, descendantIds, getProject, getTask, logEvent, setDone, type Project, type Task } from './services.ts';

export const STATUSES = ['completed', 'abandoned', 'on_hold'] as const;
export const REASONS = ['no_longer_needed', 'replaced', 'too_costly', 'blocked', 'other'] as const;
export type ClosedStatus = (typeof STATUSES)[number];
export type Closure = {
  status: ClosedStatus; notes: string; reason?: (typeof REASONS)[number]; lessons?: string;
  replaced_by?: { kind: 'task' | 'project'; id: number; title: string }; closed_at: string; closed_by: string; log_id?: number;
  /** On hold only: the day (YYYY-MM-DD) it comes back onto Home to be looked at again. */
  review_on?: string;
};
export type CloseInput = {
  status: ClosedStatus; notes?: string; reason?: string; lessons?: string; replaced_by?: { kind: 'task' | 'project'; id: number } | null;
  log?: boolean; close_tasks?: boolean; review_on?: string | null;
};

const LABEL = { completed: 'Completed', abandoned: 'Abandoned', on_hold: 'On Hold' } as const;
const REASON_LABEL = { no_longer_needed: 'No longer needed', replaced: 'Replaced', too_costly: 'Too costly', blocked: 'Blocked', other: 'Other' } as const;
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function build(db: DatabaseSync, d: CloseInput): Closure {
  if (!STATUSES.includes(d?.status)) throw new HttpError(400, 'status must be completed, abandoned or on_hold');
  if (d.reason && d.status !== 'abandoned') throw new HttpError(400, 'a reason is only for abandoned');
  if (d.reason && !REASONS.includes(d.reason as any)) throw new HttpError(400, `reason must be one of: ${REASONS.join(', ')}`);
  if (d.lessons?.trim() && d.status === 'on_hold') throw new HttpError(400, 'lessons learned are for completed or abandoned');
  if (d.review_on && d.status !== 'on_hold') throw new HttpError(400, 'a review date is only for on hold');
  if (d.review_on && !(/^\d{4}-\d{2}-\d{2}$/.test(d.review_on) && !isNaN(Date.parse(d.review_on)))) throw new HttpError(400, 'review date must be YYYY-MM-DD');
  let replaced: Closure['replaced_by'];
  if (d.replaced_by) {
    const { kind, id } = d.replaced_by;
    const title = kind === 'task' ? (() => { try { return getTask(db, id).title; } catch { return null; } })()
      : kind === 'project' ? (() => { try { return getProject(db, id).title; } catch { return null; } })() : null;
    if (!title) throw new HttpError(400, `Replaced by: ${kind} ${id} not found`);
    replaced = { kind, id, title };
  }
  return {
    status: d.status, notes: String(d.notes ?? '').trim().slice(0, 5000),
    ...(d.status === 'abandoned' && d.reason && { reason: d.reason as Closure['reason'] }),
    ...(d.lessons?.trim() && { lessons: d.lessons.trim().slice(0, 5000) }),
    ...(replaced && { replaced_by: replaced }),
    ...(d.review_on && { review_on: d.review_on }),
    closed_at: new Date().toISOString(), closed_by: actor.getStore() ?? 'system',
  };
}

/** The logbook entry for a closure: title with the outcome, then notes, reason, follow-up and lessons. */
function writeLog(db: DatabaseSync, projectId: number, taskId: number | null, title: string, c: Closure): number {
  const body = [
    c.notes && `<p>${esc(c.notes).replace(/\n/g, '<br>')}</p>`,
    c.reason && `<p><strong>Reason:</strong> ${REASON_LABEL[c.reason]}</p>`,
    c.replaced_by && `<p><strong>Replaced by:</strong> ${esc(c.replaced_by.title)}</p>`,
    c.lessons && `<p><strong>Lessons learned:</strong> ${esc(c.lessons).replace(/\n/g, '<br>')}</p>`,
  ].filter(Boolean).join('');
  return createLog(db, { project_id: projectId, task_id: taskId, kind: 'change', title: `Closed: ${title} (${LABEL[c.status]})`, body }, { taskHistory: false }).id;
}

function closeOneTask(db: DatabaseSync, id: number, c: Closure) {
  if (c.status !== 'on_hold') setDone(db, id, true);
  db.prepare('UPDATE tasks SET closed=?, closure=? WHERE id=?').run(c.status, JSON.stringify(c), id);
  logEvent(db, id, 'closed', `${LABEL[c.status]}${c.notes ? `: ${c.notes.slice(0, 200)}` : ''}`);
}

export function closeTask(db: DatabaseSync, id: number, d: CloseInput): Task {
  const t = getTask(db, id);
  return tx(db, () => {
    const c = build(db, d);
    if (d.log) c.log_id = writeLog(db, t.project_id, id, t.title, c);
    closeOneTask(db, id, c);
    if (c.status === 'completed' && !t.done) completed(db, getTask(db, id));
    return getTask(db, id);
  });
}

export function reopenTask(db: DatabaseSync, id: number): Task {
  const t = getTask(db, id);
  return tx(db, () => {
    if (t.done) setDone(db, id, false);
    db.prepare('UPDATE tasks SET closed=NULL, closure=NULL WHERE id=?').run(id);
    logEvent(db, id, 'reopened', t.closed ? `was ${LABEL[t.closed as ClosedStatus]}` : '');
    return getTask(db, id);
  });
}

/** Completed / abandoned archive the project (and, with close_tasks, close its open tasks the same way); on hold only marks it. */
export function closeProject(db: DatabaseSync, id: number, d: CloseInput): Project {
  const p = getProject(db, id);
  return tx(db, () => {
    const c = build(db, d);
    if (d.log) c.log_id = writeLog(db, id, null, p.title, c);
    db.prepare('UPDATE projects SET closed=?, closure=?, archived=? WHERE id=?').run(c.status, JSON.stringify(c), c.status === 'on_hold' ? (p.archived ? 1 : 0) : 1, id);
    if (d.close_tasks && c.status !== 'on_hold') {
      const ids = descendantIds(db, id);
      const open = db.prepare(`SELECT id FROM tasks WHERE done=0 AND project_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number }[];
      for (const t of open) closeOneTask(db, t.id, { ...c, notes: `Closed with the project ${p.title}` });
    }
    return getProject(db, id);
  });
}

export function reopenProject(db: DatabaseSync, id: number): Project {
  getProject(db, id);
  db.prepare('UPDATE projects SET closed=NULL, closure=NULL, archived=0 WHERE id=?').run(id);
  return getProject(db, id);
}
