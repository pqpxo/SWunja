// One search across projects, tasks (and their lists), logbook, maintenance, runbooks and ideas.
import type { DatabaseSync } from 'node:sqlite';
import { projectLook } from './services.ts';

type Row = Record<string, any>;
export type Hit = { id: number; title: string; snippet: string } & Row;
export type SearchResult = { projects: Hit[]; tasks: Hit[]; log: Hit[]; maintenance: Hit[]; runbooks: Hit[]; ideas: Hit[] };

const text = (html: unknown) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

/** The first source containing the query, cut to ~110 characters around the match. */
function snippet(q: string, sources: unknown[]): string {
  const needle = q.toLowerCase();
  for (const src of sources) {
    const t = text(src);
    const at = t.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    if (t.length <= 110) return t;
    const start = Math.max(0, at - 40);
    return `${start ? '…' : ''}${t.slice(start, start + 110).trim()}${start + 110 < t.length ? '…' : ''}`;
  }
  return '';
}

export function search(db: DatabaseSync, q: string, limit = 8): SearchResult {
  const query = q.trim();
  const out: SearchResult = { projects: [], tasks: [], log: [], maintenance: [], runbooks: [], ideas: [] };
  if (!query) return out;
  const like = `%${query}%`;
  const n = Math.max(1, Math.min(limit, 50));
  const all = (sql: string, ...p: string[]) => db.prepare(sql).all(...p) as Row[];

  out.projects = all(`SELECT id, title, icon, color, description FROM projects WHERE title LIKE ? OR description LIKE ?
      ORDER BY (title LIKE ?) DESC, title LIMIT ${n}`, like, like, like)
    .map(r => ({ id: r.id, title: r.title, ...projectLook(db, r.id), snippet: snippet(query, [r.description]) }));
  out.tasks = all(`SELECT t.id, t.title, t.done, t.project_id, p.title project_title, t.description, t.issue, t.workaround, t.resolution,
        (SELECT group_concat(text, '\n') FROM checklist_items ci WHERE ci.task_id=t.id AND ci.text LIKE ?) items
      FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.title LIKE ? OR t.description LIKE ? OR t.issue LIKE ? OR t.workaround LIKE ? OR t.resolution LIKE ?
        OR EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.task_id=t.id AND ci.text LIKE ?)
      ORDER BY t.done, (t.title LIKE ?) DESC, t.updated DESC LIMIT ${n}`, like, like, like, like, like, like, like, like)
    .map(r => ({
      id: r.id, title: r.title, done: !!r.done, project_id: r.project_id, project_title: r.project_title,
      snippet: snippet(query, [...String(r.items ?? '').split('\n'), r.description, r.issue, r.workaround, r.resolution]),
    }));
  out.log = all(`SELECT l.id, l.title, l.kind, l.at, l.project_id, p.title project_title, l.body, l.rollback FROM log_entries l
      JOIN projects p ON p.id=l.project_id WHERE l.title LIKE ? OR l.body LIKE ? OR l.rollback LIKE ? ORDER BY l.at DESC LIMIT ${n}`, like, like, like)
    .map(r => ({ id: r.id, title: r.title, kind: r.kind, at: r.at, project_id: r.project_id, project_title: r.project_title, snippet: snippet(query, [r.body, r.rollback]) }));
  out.maintenance = all(`SELECT m.id, m.title, m.next_due, m.project_id, p.title project_title, m.notes FROM maintenance m
      JOIN projects p ON p.id=m.project_id WHERE m.title LIKE ? OR m.notes LIKE ? ORDER BY m.next_due LIMIT ${n}`, like, like)
    .map(r => ({ id: r.id, title: r.title, next_due: r.next_due, project_id: r.project_id, project_title: r.project_title, snippet: snippet(query, [r.notes]) }));
  out.runbooks = all(`SELECT r.id, r.title, r.project_id, p.title project_title, r.steps, r.notes FROM runbooks r
      LEFT JOIN projects p ON p.id=r.project_id WHERE r.title LIKE ? OR r.steps LIKE ? OR r.lists LIKE ? OR r.notes LIKE ? ORDER BY r.title LIMIT ${n}`, like, like, like, like)
    .map(r => ({ id: r.id, title: r.title, project_id: r.project_id, project_title: r.project_title, snippet: snippet(query, [...JSON.parse(r.steps), r.notes]) }));
  out.ideas = all(`SELECT i.id, i.title, i.status, i.project_id, p.title project_title, i.body, i.reason FROM ideas i JOIN projects p ON p.id=i.project_id
      WHERE i.title LIKE ? OR i.body LIKE ? OR i.reason LIKE ? ORDER BY (i.title LIKE ?) DESC, i.created DESC LIMIT ${n}`, like, like, like, like)
    .map(r => ({ id: r.id, title: r.title, status: r.status, project_id: r.project_id, project_title: r.project_title, snippet: snippet(query, [r.body, r.reason]) }));
  return out;
}
