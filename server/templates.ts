// Templates: a saved task (content, labels, fields, lists) or project (type, fields, tasks) to create new ones from.
import type { DatabaseSync } from 'node:sqlite';
import { tx } from './db.ts';
import * as s from './services.ts';

type Item = { text: string; children: Item[] };
type ListKey = 'tasks' | 'requirements' | 'resources';
const LIST_FIELD = { tasks: 'checklist', requirements: 'requirements', resources: 'resources' } as const;

export type TaskData = {
  title: string; description: string; issue: string; workaround: string; resolution: string; priority: number;
  labels: string[]; fields: Record<string, string>; lists: Record<ListKey, Item[]>;
  styles: Record<ListKey, 'bullets' | 'numbered'>; enabled: Record<ListKey, boolean>;
};
export type ProjectData = { title: string; description: string; type: string | null; color: string; icon: string; fields: Record<string, string>; tasks: TaskData[] };
export type Template = { id: number; kind: 'task' | 'project'; name: string; created: string; data: TaskData | ProjectData };

const tree = (flat: s.ChecklistItem[]): Item[] =>
  flat.filter(i => i.parent_id === null).map(top => ({ text: top.text, children: flat.filter(c => c.parent_id === top.id).map(c => ({ text: c.text, children: [] })) }));
// link fields are stored by the linked project's title, so a template works in another instance too
const fieldMap = (fields: s.FieldValue[]) =>
  Object.fromEntries(fields.filter(f => f.value !== null).map(f => [f.name, f.type === 'link' ? f.display ?? '' : f.value!]).filter(([, v]) => v !== ''));

function taskData(t: s.Task): TaskData {
  return {
    title: t.title, description: t.description, issue: t.issue, workaround: t.workaround, resolution: t.resolution, priority: t.priority,
    labels: t.labels.map(l => l.title), fields: fieldMap(t.fields),
    lists: { tasks: tree(t.checklist), requirements: tree(t.requirements), resources: tree(t.resources) },
    styles: { tasks: t.checklist_style, requirements: t.requirements_style, resources: t.resources_style },
    enabled: { tasks: t.checklist_enabled, requirements: t.requirements_enabled, resources: t.resources_enabled },
  };
}

// Sets what applies; a task field the target doesn't have yet is added to that one task. Unknown fields are skipped.
function setFieldsLeniently(db: DatabaseSync, entity: 'project' | 'task', id: number, fields: Record<string, string>) {
  for (const [name, value] of Object.entries(fields)) {
    try { s.setFieldValues(db, entity, id, { [name]: value }, { log: false }); continue; } catch { /* not on this entity yet */ }
    if (entity !== 'task') continue;
    try { s.attachField(db, 'task', id, name); s.setFieldValues(db, 'task', id, { [name]: value }, { log: false }); } catch { /* no such field here */ }
  }
}

function createTaskFrom(db: DatabaseSync, d: TaskData, projectId: number, title?: string): s.Task {
  const t = s.createTask(db, {
    project_id: projectId, title: title?.trim() || d.title, description: d.description, issue: d.issue, workaround: d.workaround,
    resolution: d.resolution, priority: d.priority, labels: d.labels,
  });
  for (const list of ['tasks', 'requirements', 'resources'] as ListKey[]) {
    for (const top of d.lists[list] ?? []) {
      const parent = s.addChecklistItem(db, t.id, { text: top.text, list });
      for (const c of top.children) s.addChecklistItem(db, t.id, { text: c.text, list, parent_id: parent.id });
    }
  }
  setFieldsLeniently(db, 'task', t.id, d.fields ?? {});
  const flags: Record<string, unknown> = {};
  for (const list of ['tasks', 'requirements', 'resources'] as ListKey[]) {
    flags[`${LIST_FIELD[list]}_style`] = d.styles?.[list] ?? 'bullets';
    flags[`${LIST_FIELD[list]}_enabled`] = d.enabled?.[list] ?? false;
  }
  return s.updateTask(db, t.id, flags);
}

/** A fresh copy of a task (lists unticked) in the same project, for repeating tasks. */
export const copyTask = (db: DatabaseSync, t: s.Task): s.Task => createTaskFrom(db, taskData(t), t.project_id);

const toTemplate = (r: Record<string, any>): Template => ({ id: r.id, kind: r.kind, name: r.name, created: r.created, data: JSON.parse(r.data) });

export function getTemplate(db: DatabaseSync, id: number): Template {
  const r = db.prepare('SELECT * FROM templates WHERE id=?').get(id);
  if (!r) throw new s.HttpError(404, 'Template not found');
  return toTemplate(r);
}

export const listTemplates = (db: DatabaseSync, kind?: 'task' | 'project'): Template[] =>
  (kind ? db.prepare('SELECT * FROM templates WHERE kind=? ORDER BY name').all(kind) : db.prepare('SELECT * FROM templates ORDER BY kind, name').all()).map(toTemplate);

export function saveTemplate(db: DatabaseSync, d: { kind: 'task' | 'project'; from_id: number; name: string }): Template {
  if (d.kind !== 'task' && d.kind !== 'project') throw new s.HttpError(400, 'kind must be task or project');
  const name = d.name?.trim();
  if (!name) throw new s.HttpError(400, 'name is required');
  if (db.prepare('SELECT 1 FROM templates WHERE kind=? AND lower(name)=lower(?)').get(d.kind, name)) throw new s.HttpError(409, `A ${d.kind} template called "${name}" already exists`);
  let data: TaskData | ProjectData;
  if (d.kind === 'task') data = taskData(s.getTask(db, d.from_id));
  else {
    const p = s.getProject(db, d.from_id);
    data = {
      title: p.title, description: p.description, color: p.color, icon: p.icon.startsWith('img:') ? '' : p.icon,
      type: p.type_id ? s.getType(db, p.type_id).name : null, fields: fieldMap(p.fields),
      tasks: s.listTasks(db, { projectId: p.id, includeSub: false }).map(taskData),
    };
  }
  const id = Number(db.prepare('INSERT INTO templates (kind,name,data) VALUES (?,?,?)').run(d.kind, name, JSON.stringify(data)).lastInsertRowid);
  return getTemplate(db, id);
}

/** A task template needs project_id; a project template takes an optional title and parent_id. */
export function applyTemplate(db: DatabaseSync, id: number, o: { project_id?: number; parent_id?: number | null; title?: string }): s.Task | s.Project {
  const t = getTemplate(db, id);
  return tx(db, () => {
    if (t.kind === 'task') {
      if (!o.project_id) throw new s.HttpError(400, 'project_id is required for a task template');
      return createTaskFrom(db, t.data as TaskData, o.project_id, o.title);
    }
    const d = t.data as ProjectData;
    let typeId: number | null = null;
    try { typeId = s.resolveTypeId(db, d.type); } catch { /* type no longer exists */ }
    const p = s.createProject(db, { title: o.title?.trim() || d.title, description: d.description, color: d.color, icon: d.icon, parent_id: o.parent_id ?? null, type_id: typeId });
    setFieldsLeniently(db, 'project', p.id, d.fields ?? {});
    for (const task of d.tasks ?? []) createTaskFrom(db, task, p.id);
    return s.getProject(db, p.id);
  });
}

export function renameTemplate(db: DatabaseSync, id: number, name: string): Template {
  const t = getTemplate(db, id);
  if (!name?.trim()) throw new s.HttpError(400, 'name is required');
  if (db.prepare('SELECT 1 FROM templates WHERE kind=? AND lower(name)=lower(?) AND id<>?').get(t.kind, name.trim(), id)) throw new s.HttpError(409, `A ${t.kind} template called "${name}" already exists`);
  db.prepare('UPDATE templates SET name=? WHERE id=?').run(name.trim(), id);
  return getTemplate(db, id);
}

export function deleteTemplate(db: DatabaseSync, id: number) {
  getTemplate(db, id);
  db.prepare('DELETE FROM templates WHERE id=?').run(id);
}
