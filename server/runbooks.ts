// Runbooks: reusable step-by-step procedures, for one project (and its sub-projects), one task, or nothing in particular (global).
import type { DatabaseSync } from 'node:sqlite';
import { tx } from './db.ts';
import { HttpError, actor, ancestorIds, createLog, getProject, getTask, markMaintenanceDone, type LogKind } from './services.ts';
import { addInterval } from './recurring.ts';

/** The Tasks / Requirements / Resources lists, shaped like a task's (items have one level of sub-items). */
export const LISTS = ['tasks', 'requirements', 'resources'] as const;
export type ListName = (typeof LISTS)[number];
export type ListItem = { id: number; parent_id: number | null; text: string; done: boolean; position: number };
export type RunbookList = { style: 'bullets' | 'numbered'; enabled: boolean; items: ListItem[] };
export type Runbook = {
  id: number; project_id: number | null; project_title: string | null; task_id: number | null; task_title: string | null;
  title: string; steps: string[]; lists: Record<ListName, RunbookList>; notes: string; created: string; updated: string;
  /** expected[i] is what step i should show when it worked ('' for none); rollback undoes the procedure. */
  expected: string[]; rollback: string[]; est_minutes: number | null; risk: Risk; downtime: boolean;
  runs: number; last_run: string | null; active_run_id: number | null;
  /** Months between test runs (null = no reminder); test_due is the day the next one is due, from the last run or else when it was made. */
  test_every: number | null; test_due: string | null;
};
export const RISKS = ['', 'low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];
type RunbookInput = {
  project_id?: number | null; task_id?: number | null; title?: string; steps?: string[]; lists?: unknown; notes?: string;
  expected?: string[]; rollback?: string[]; est_minutes?: number | null; risk?: Risk; downtime?: boolean; test_every?: number | null;
};

const SELECT = `SELECT r.*, p.title project_title, t.title task_title,
    (SELECT count(*) FROM runbook_runs x WHERE x.runbook_id=r.id AND x.finished IS NOT NULL) runs,
    (SELECT max(finished) FROM runbook_runs x WHERE x.runbook_id=r.id) last_run,
    (SELECT max(id) FROM runbook_runs x WHERE x.runbook_id=r.id AND x.finished IS NULL) active_run_id
  FROM runbooks r LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN tasks t ON t.id=r.task_id`;
const toRunbook = (r: Record<string, any>): Runbook => {
  const steps: string[] = JSON.parse(r.steps), expected: string[] = JSON.parse(r.expected ?? '[]');
  return {
    ...(r as Runbook), steps, lists: cleanLists(JSON.parse(r.lists)), rollback: JSON.parse(r.rollback ?? '[]'),
    expected: steps.map((_, i) => expected[i] ?? ''), est_minutes: r.est_minutes ?? null, risk: r.risk ?? '', downtime: !!r.downtime,
    test_every: r.test_every ?? null,
    test_due: r.test_every ? addInterval(String(r.last_run ?? r.created).slice(0, 10), { every: r.test_every, unit: 'month' }) : null,
  };
};

/** Steps with their expected results, dropping blank steps together with the result that belonged to them. */
function stepsWithExpected(steps: unknown, expected: unknown): [string[], string[]] {
  if (steps !== undefined && !Array.isArray(steps)) throw new HttpError(400, 'steps must be a list of strings');
  if (expected !== undefined && !Array.isArray(expected)) throw new HttpError(400, 'expected must be a list of strings, one per step');
  const ex = (expected ?? []) as unknown[];
  const pairs = ((steps ?? []) as unknown[]).map((s, i) => [String(s).trim(), String(ex[i] ?? '').trim().slice(0, 300)] as const)
    .filter(([s]) => s && s !== '<p></p>').slice(0, 200);
  return [pairs.map(p => p[0]), pairs.map(p => p[1])];
}

function checkExtras(d: RunbookInput) {
  if (d.risk !== undefined && !RISKS.includes(d.risk)) throw new HttpError(400, `risk must be one of: low, medium, high (or empty)`);
  if (d.test_every != null && !(Number.isInteger(d.test_every) && d.test_every >= 1 && d.test_every <= 60)) throw new HttpError(400, 'test_every must be a whole number of months, 1 to 60');
  if (d.est_minutes != null && !(Number.isInteger(d.est_minutes) && d.est_minutes >= 1 && d.est_minutes <= 10080)) throw new HttpError(400, 'est_minutes must be a whole number of minutes, 1 to 10080');
}
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function cleanSteps(steps: unknown): string[] {
  if (steps === undefined) return [];
  if (!Array.isArray(steps)) throw new HttpError(400, 'steps must be a list of strings');
  return steps.map(x => String(x).trim()).filter(x => x && x !== '<p></p>').slice(0, 200);
}

/** Missing lists get the task defaults (Tasks and Resources on, Requirements off); items lose bad parents and are renumbered. */
export function cleanLists(v: unknown): Record<ListName, RunbookList> {
  const src = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  return Object.fromEntries(LISTS.map(name => {
    const l = src[name] && typeof src[name] === 'object' ? src[name] : {};
    const raw = (Array.isArray(l.items) ? l.items : []).slice(0, 500)
      .filter((i: any) => i && Number.isInteger(i.id) && String(i.text ?? '').trim());
    const tops = new Set(raw.filter((i: any) => i.parent_id == null).map((i: any) => i.id));
    const items = raw.filter((i: any) => i.parent_id == null || tops.has(i.parent_id))
      .map((i: any, n: number) => ({ id: i.id, parent_id: i.parent_id ?? null, text: String(i.text).trim(), done: !!i.done, position: n }));
    return [name, { style: l.style === 'numbered' ? 'numbered' : 'bullets', enabled: l.enabled ?? name !== 'requirements', items }];
  })) as Record<ListName, RunbookList>;
}

/** A list from plain strings (MCP), all top-level. */
export const listFromStrings = (texts: string[]): RunbookList =>
  ({ style: 'bullets', enabled: true, items: texts.map(t => t.trim()).filter(Boolean).map((text, i) => ({ id: i + 1, parent_id: null, text, done: false, position: i })) });

/** A task pins the runbook to that task's project; changing the project drops a task from elsewhere. */
function scope(db: DatabaseSync, project_id: number | null, task_id: number | null, taskGiven: boolean) {
  if (task_id) {
    const t = getTask(db, task_id);
    if (taskGiven) return { project_id: t.project_id, task_id };
    return t.project_id === project_id ? { project_id, task_id } : { project_id, task_id: null };
  }
  if (project_id) getProject(db, project_id);
  return { project_id, task_id: null };
}

export function getRunbook(db: DatabaseSync, id: number): Runbook {
  const r = db.prepare(`${SELECT} WHERE r.id=?`).get(id);
  if (!r) throw new HttpError(404, 'Runbook not found');
  return toRunbook(r);
}

/** With a project: its own runbooks, its parents' and the global ones (they all apply there). */
export function listRunbooks(db: DatabaseSync, o: { projectId?: number } = {}): Runbook[] {
  if (o.projectId === undefined) return db.prepare(`${SELECT} ORDER BY lower(r.title)`).all().map(toRunbook);
  const ids = ancestorIds(db, o.projectId);
  return db.prepare(`${SELECT} WHERE r.project_id IS NULL OR r.project_id IN (${ids.map(() => '?').join(',')}) ORDER BY lower(r.title)`).all(...ids).map(toRunbook);
}

export function createRunbook(db: DatabaseSync, d: RunbookInput): Runbook {
  if (!d.title?.trim()) throw new HttpError(400, 'title is required');
  const sc = scope(db, d.project_id ?? null, d.task_id ?? null, d.task_id != null);
  checkExtras(d);
  const [steps, expected] = stepsWithExpected(d.steps, d.expected);
  const id = Number(db.prepare('INSERT INTO runbooks (project_id,task_id,title,steps,lists,notes,expected,rollback,est_minutes,risk,downtime,test_every) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sc.project_id, sc.task_id, d.title.trim(), JSON.stringify(steps), JSON.stringify(cleanLists(d.lists)), d.notes ?? '',
      JSON.stringify(expected), JSON.stringify(cleanSteps(d.rollback)), d.est_minutes ?? null, d.risk ?? '', d.downtime ? 1 : 0, d.test_every ?? null).lastInsertRowid);
  return getRunbook(db, id);
}

export function updateRunbook(db: DatabaseSync, id: number, d: RunbookInput): Runbook {
  const cur = getRunbook(db, id);
  if (d.title !== undefined && !d.title.trim()) throw new HttpError(400, 'title cannot be empty');
  const sc = scope(db, d.project_id === undefined ? cur.project_id : d.project_id, d.task_id === undefined ? cur.task_id : d.task_id, d.task_id != null);
  checkExtras(d);
  // new steps without new results keep the old results in order (trimmed to the new number of steps)
  const [steps, expected] = stepsWithExpected(d.steps ?? cur.steps, d.expected ?? cur.expected);
  db.prepare(`UPDATE runbooks SET project_id=?, task_id=?, title=?, steps=?, lists=?, notes=?, expected=?, rollback=?, est_minutes=?, risk=?, downtime=?,
      test_every=?, updated=? WHERE id=?`).run(
    sc.project_id, sc.task_id, d.title?.trim() ?? cur.title, JSON.stringify(steps),
    JSON.stringify(d.lists === undefined ? cur.lists : cleanLists(d.lists)), d.notes ?? cur.notes, JSON.stringify(expected),
    JSON.stringify(d.rollback === undefined ? cur.rollback : cleanSteps(d.rollback)),
    d.est_minutes === undefined ? cur.est_minutes : d.est_minutes, d.risk ?? cur.risk, (d.downtime ?? cur.downtime) ? 1 : 0,
    d.test_every === undefined ? cur.test_every : d.test_every, now(), id);
  return getRunbook(db, id);
}

export function deleteRunbook(db: DatabaseSync, id: number) {
  getRunbook(db, id);
  db.prepare('DELETE FROM runbooks WHERE id=?').run(id);
}

/* ---------------- runs: following a runbook, tick by tick, ending in a logbook entry ---------------- */

export type Run = {
  id: number; runbook_id: number; runbook_title: string; project_id: number | null; project_title: string | null; task_id: number | null;
  maintenance_id: number | null; log_id: number | null; steps: string[]; ticked: number[]; notes: string; actor: string; started: string; finished: string | null;
};
type FinishInput = { notes?: string; project_id?: number | null; task_id?: number | null; kind?: LogKind; at?: string };

const RUN_SELECT = 'SELECT x.*, r.title runbook_title, p.title project_title FROM runbook_runs x JOIN runbooks r ON r.id=x.runbook_id LEFT JOIN projects p ON p.id=x.project_id';
const toRun = (r: Record<string, any>): Run => ({ ...(r as Run), steps: JSON.parse(r.steps), ticked: JSON.parse(r.ticked) });
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export function getRun(db: DatabaseSync, id: number): Run {
  const r = db.prepare(`${RUN_SELECT} WHERE x.id=?`).get(id);
  if (!r) throw new HttpError(404, 'Run not found');
  return toRun(r);
}

/** Newest first; an unfinished run comes first. */
export const listRuns = (db: DatabaseSync, runbookId: number): Run[] =>
  db.prepare(`${RUN_SELECT} WHERE x.runbook_id=? ORDER BY x.finished IS NOT NULL, coalesce(x.finished, x.started) DESC, x.id DESC`).all(runbookId).map(toRun);

const cleanTicked = (ticked: unknown, n: number) => {
  if (!Array.isArray(ticked)) throw new HttpError(400, 'ticked must be a list of step numbers (0-based)');
  return [...new Set(ticked.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < n))].sort((a, b) => a - b);
};

function newRun(db: DatabaseSync, runbookId: number, maintenanceId: number | null = null): Run {
  const rb = getRunbook(db, runbookId);
  const id = Number(db.prepare('INSERT INTO runbook_runs (runbook_id,project_id,task_id,maintenance_id,steps,actor,started) VALUES (?,?,?,?,?,?,?)')
    .run(runbookId, rb.project_id, rb.task_id, maintenanceId, JSON.stringify(rb.steps), actor.getStore() ?? 'system', now()).lastInsertRowid);
  return getRun(db, id);
}

/** Starts a run, or carries on with the one already in progress. */
export function startRun(db: DatabaseSync, runbookId: number): Run {
  const rb = getRunbook(db, runbookId);
  return rb.active_run_id ? getRun(db, rb.active_run_id) : newRun(db, runbookId);
}

export function updateRun(db: DatabaseSync, id: number, d: { ticked?: unknown }): Run {
  const run = getRun(db, id);
  if (run.finished) throw new HttpError(400, 'That run has finished');
  if (d.ticked !== undefined) db.prepare('UPDATE runbook_runs SET ticked=? WHERE id=?').run(JSON.stringify(cleanTicked(d.ticked, getRunbook(db, run.runbook_id).steps.length)), id);
  return getRun(db, id);
}

/** "Runbook X: 3 of 4 steps done", plus the skipped ones when some were ticked. */
function summary(title: string, steps: string[], ticked: number[]) {
  const skipped = steps.map((s, i) => [i, s] as const).filter(([i]) => !ticked.includes(i));
  return `<p>Runbook <strong>${esc(title)}</strong>: ${ticked.length} of ${steps.length} step${steps.length === 1 ? '' : 's'} done.</p>`
    + (ticked.length && skipped.length ? `<p>Skipped:</p><ul>${skipped.map(([i, s]) => `<li><p>${i + 1}. ${plain(s)}</p></li>`).join('')}</ul>` : '');
}

/**
 * Finishes a run: keeps the steps as they are now, and writes a logbook entry on the project (and task) it is for.
 * project_id null means don't log it; logId links an entry that was already written (maintenance).
 */
function finish(db: DatabaseSync, id: number, d: FinishInput, logId?: number): Run {
  const run = getRun(db, id);
  if (run.finished) throw new HttpError(400, 'That run has already finished');
  const rb = getRunbook(db, run.runbook_id);
  const ticked = run.ticked.filter(i => i < rb.steps.length);
  const project_id = d.project_id === undefined ? run.project_id : d.project_id;
  const task_id = project_id === null ? null : d.task_id === undefined ? (project_id === run.project_id ? run.task_id : null) : d.task_id;
  return tx(db, () => {
    const log = logId ?? (project_id ? createLog(db, {
      project_id, task_id, kind: d.kind ?? 'change', title: `Ran runbook: ${rb.title}`, body: summary(rb.title, rb.steps, ticked) + (d.notes ?? ''), at: d.at,
    }).id : null);
    db.prepare('UPDATE runbook_runs SET finished=?, steps=?, ticked=?, notes=?, project_id=?, task_id=?, log_id=? WHERE id=?')
      .run(now(), JSON.stringify(rb.steps), JSON.stringify(ticked), d.notes ?? '', project_id, task_id, log, id);
    return getRun(db, id);
  });
}

export const finishRun = (db: DatabaseSync, id: number, d: FinishInput = {}) => finish(db, id, d);

/** A whole run in one go (MCP): the steps done, notes, and where to log it. */
export function recordRun(db: DatabaseSync, runbookId: number, d: FinishInput & { ticked: unknown }): Run {
  return tx(db, () => {
    const run = newRun(db, runbookId);
    updateRun(db, run.id, { ticked: d.ticked });
    return finish(db, run.id, d);
  });
}

/** Marks a maintenance job done; with its runbook's ticked steps, that is recorded as a run too and summed up in the same logbook entry. */
export function maintenanceDone(db: DatabaseSync, id: number, d: { date?: string; notes?: string; runbook_ticked?: unknown }) {
  return tx(db, () => {
    const runbookId = (db.prepare('SELECT runbook_id FROM maintenance WHERE id=?').get(id) as { runbook_id: number | null } | undefined)?.runbook_id;
    if (!runbookId || d.runbook_ticked === undefined) return { ...markMaintenanceDone(db, id, d), run: null as Run | null };
    const rb = getRunbook(db, runbookId);
    const ticked = cleanTicked(d.runbook_ticked, rb.steps.length);
    const r = markMaintenanceDone(db, id, { date: d.date, notes: (d.notes ?? '') + summary(rb.title, rb.steps, ticked) });
    const run = newRun(db, runbookId, id);
    db.prepare('UPDATE runbook_runs SET ticked=?, project_id=? WHERE id=?').run(JSON.stringify(ticked), r.item.project_id, run.id);
    return { ...r, run: finish(db, run.id, { notes: d.notes, project_id: r.item.project_id, task_id: null }, r.log.id) };
  });
}

/** Cancels a run in progress, or removes one from the history (its logbook entry stays). */
export function deleteRun(db: DatabaseSync, id: number) {
  getRun(db, id);
  db.prepare('DELETE FROM runbook_runs WHERE id=?').run(id);
}
