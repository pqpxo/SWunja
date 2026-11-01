// Ideas: a per-project place to dump thoughts. Each has a status (rejected ones keep a "why not"), can be pinned,
// and can be turned into a task, which keeps a link back.
import type { DatabaseSync } from 'node:sqlite';
import { tx } from './db.ts';
import { HttpError, createTask, descendantIds, getProject, getTask, logEvent, type Task } from './services.ts';

export const IDEA_STATUSES = ['new', 'maybe', 'parked', 'done', 'rejected'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export type Idea = {
  id: number; project_id: number; project_title: string; title: string; body: string; status: IdeaStatus; reason: string;
  pinned: boolean; task_id: number | null; task_title: string | null; created: string; updated: string;
};
type IdeaInput = { project_id?: number; title?: string; body?: string; status?: IdeaStatus; reason?: string; pinned?: boolean };

const SELECT = `SELECT i.*, p.title project_title, t.title task_title FROM ideas i JOIN projects p ON p.id=i.project_id LEFT JOIN tasks t ON t.id=i.task_id`;
const toIdea = (r: Record<string, any>): Idea => ({ ...(r as Idea), pinned: !!r.pinned });
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function check(d: IdeaInput) {
  if (d.title !== undefined && !d.title.trim()) throw new HttpError(400, 'title cannot be empty');
  if (d.status !== undefined && !IDEA_STATUSES.includes(d.status)) throw new HttpError(400, `status must be one of: ${IDEA_STATUSES.join(', ')}`);
}

export function getIdea(db: DatabaseSync, id: number): Idea {
  const r = db.prepare(`${SELECT} WHERE i.id=?`).get(id);
  if (!r) throw new HttpError(404, 'Idea not found');
  return toIdea(r);
}

/** Pinned first, then newest. A project's list includes its sub-projects' ideas unless includeSub is false. */
export function listIdeas(db: DatabaseSync, o: { projectId?: number; includeSub?: boolean; status?: IdeaStatus } = {}): Idea[] {
  const where: string[] = [], params: (string | number)[] = [];
  if (o.projectId !== undefined) {
    const ids = o.includeSub === false ? [o.projectId] : descendantIds(db, o.projectId);
    where.push(`i.project_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
  }
  if (o.status) { where.push('i.status=?'); params.push(o.status); }
  return db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.pinned DESC, i.created DESC, i.id DESC`)
    .all(...params).map(toIdea);
}

export function createIdea(db: DatabaseSync, d: IdeaInput): Idea {
  if (!d.title?.trim()) throw new HttpError(400, 'title is required');
  if (!d.project_id) throw new HttpError(400, 'project_id is required');
  getProject(db, d.project_id);
  check(d);
  const id = Number(db.prepare('INSERT INTO ideas (project_id,title,body,status,reason,pinned,created,updated) VALUES (?,?,?,?,?,?,?,?)')
    .run(d.project_id, d.title.trim(), d.body ?? '', d.status ?? 'new', d.reason ?? '', d.pinned ? 1 : 0, now(), now()).lastInsertRowid);
  return getIdea(db, id);
}

export function updateIdea(db: DatabaseSync, id: number, d: IdeaInput): Idea {
  const cur = getIdea(db, id);
  check(d);
  if (d.project_id !== undefined) getProject(db, d.project_id);
  db.prepare('UPDATE ideas SET project_id=?, title=?, body=?, status=?, reason=?, pinned=?, updated=? WHERE id=?').run(
    d.project_id ?? cur.project_id, d.title?.trim() ?? cur.title, d.body ?? cur.body, d.status ?? cur.status,
    d.reason ?? cur.reason, (d.pinned ?? cur.pinned) ? 1 : 0, now(), id);
  return getIdea(db, id);
}

export function deleteIdea(db: DatabaseSync, id: number) {
  getIdea(db, id);
  db.prepare('DELETE FROM ideas WHERE id=?').run(id);
  return { ok: true };
}

/** A task in the idea's project with its title and notes; the idea is marked done and links to it. */
export function ideaToTask(db: DatabaseSync, id: number): { idea: Idea; task: Task } {
  const idea = getIdea(db, id);
  if (idea.task_id) throw new HttpError(400, `This idea is already task #${idea.task_id}`);
  return tx(db, () => {
    const task = createTask(db, { project_id: idea.project_id, title: idea.title, description: idea.body });
    logEvent(db, task.id, 'updated', `from idea: ${idea.title}`);
    db.prepare("UPDATE ideas SET task_id=?, status='done', updated=? WHERE id=?").run(task.id, now(), id);
    return { idea: getIdea(db, id), task: getTask(db, task.id) };
  });
}
