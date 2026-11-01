import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tx } from './db.ts';
import { TEXT_SECTION_KEYS } from './sections.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Row = Record<string, any>;
type Entity = 'project' | 'task';
export type FieldType = 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'url' | 'link';
export type Field = { id: number; name: string; type: FieldType; target: Entity; options: string[] };
/** Where a field on an entity comes from: its project type, a parent project it was added to, or added to this entity itself. */
export type FieldSource = 'type' | 'parent' | 'own';
/** For link fields, value is the linked project's id and display its title. */
export type FieldValue = Omit<Field, 'target'> & { value: string | null; source: FieldSource; display?: string | null };
export type Filter = { field: string | number; op: 'eq' | 'neq' | 'lt' | 'gt' | 'contains' | 'empty' | 'notempty'; value?: unknown };
type Values = Record<string, unknown>;

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const all = (db: DatabaseSync, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as Row[];
const one = (db: DatabaseSync, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as Row | undefined;
const run = (db: DatabaseSync, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);
const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new HttpError(404, `${what} not found`);
  return v;
};
const placeholders = (n: number) => Array(n).fill('?').join(',');

// Builds "SET a=?, b=?" from the allowed keys present in patch.
function patchSql(patch: Row, allowed: string[]) {
  const keys = allowed.filter(k => patch[k] !== undefined);
  return { set: keys.map(k => `${k}=?`).join(', '), vals: keys.map(k => patch[k]) as SQLInputValue[] };
}

/* ---------------- fields & types ---------------- */

const toField = (r: Row): Field => ({ id: r.id, name: r.name, type: r.type, target: r.target, options: JSON.parse(r.options) });

export function listFields(db: DatabaseSync, target?: Entity): Field[] {
  return (target ? all(db, 'SELECT * FROM fields WHERE target=? ORDER BY name', target) : all(db, 'SELECT * FROM fields ORDER BY target, name')).map(toField);
}

export function getField(db: DatabaseSync, id: number): Field {
  return toField(must(one(db, 'SELECT * FROM fields WHERE id=?', id), 'Field'));
}

const FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox', 'url', 'link'];

function cleanOptions(o: unknown): string[] {
  if (o === undefined) return [];
  if (!Array.isArray(o)) throw new HttpError(400, 'options must be a list of strings');
  return [...new Set(o.map(x => String(x).trim()).filter(Boolean))];
}

export function createField(db: DatabaseSync, d: { name: string; type: string; target: string; options?: string[] }): Field {
  const name = d.name?.trim();
  if (!name) throw new HttpError(400, 'name is required');
  if (!FIELD_TYPES.includes(d.type)) throw new HttpError(400, `type must be one of ${FIELD_TYPES.join(', ')}`);
  if (d.target !== 'project' && d.target !== 'task') throw new HttpError(400, 'target must be project or task');
  if (one(db, 'SELECT 1 FROM fields WHERE lower(name)=lower(?) AND target=?', name, d.target))
    throw new HttpError(409, `A ${d.target} field named "${name}" already exists`);
  const id = run(db, 'INSERT INTO fields (name,type,target,options) VALUES (?,?,?,?)', name, d.type, d.target, JSON.stringify(cleanOptions(d.options))).lastInsertRowid;
  return getField(db, Number(id));
}

/** Creates the field for projects, tasks, or both (two fields with the same name, made together or not at all). */
export function createFieldForTargets(db: DatabaseSync, d: { name: string; type: string; target: string; options?: string[] }): Field[] {
  if (d.target !== 'both') return [createField(db, d)];
  return tx(db, () => [createField(db, { ...d, target: 'project' }), createField(db, { ...d, target: 'task' })]);
}

export function updateField(db: DatabaseSync, id: number, d: { name?: string; options?: string[] }): Field {
  getField(db, id);
  if (d.name !== undefined && !d.name.trim()) throw new HttpError(400, 'name is required');
  run(db, 'UPDATE fields SET name=coalesce(?,name), options=coalesce(?,options) WHERE id=?',
    d.name?.trim() ?? null, d.options === undefined ? null : JSON.stringify(cleanOptions(d.options)), id);
  return getField(db, id);
}

export function deleteField(db: DatabaseSync, id: number) {
  getField(db, id);
  run(db, 'DELETE FROM fields WHERE id=?', id);
}

export type ProjectType = { id: number; name: string; fields: Field[] };

export function listTypes(db: DatabaseSync): ProjectType[] {
  return all(db, 'SELECT * FROM project_types ORDER BY name').map(t => getType(db, t.id));
}

export function getType(db: DatabaseSync, id: number): ProjectType {
  const t = must(one(db, 'SELECT * FROM project_types WHERE id=?', id), 'Project type');
  const fields = all(db, 'SELECT f.* FROM type_fields tf JOIN fields f ON f.id=tf.field_id WHERE tf.type_id=? ORDER BY tf.position', id).map(toField);
  return { id: t.id, name: t.name, fields };
}

function setTypeFields(db: DatabaseSync, id: number, fieldIds: number[]) {
  run(db, 'DELETE FROM type_fields WHERE type_id=?', id);
  [...new Set(fieldIds)].forEach((fid, i) => {
    getField(db, fid);
    run(db, 'INSERT INTO type_fields (type_id,field_id,position) VALUES (?,?,?)', id, fid, i);
  });
}

export function createType(db: DatabaseSync, d: { name: string; fieldIds?: number[] }): ProjectType {
  if (!d.name?.trim()) throw new HttpError(400, 'name is required');
  if (one(db, 'SELECT 1 FROM project_types WHERE lower(name)=lower(?)', d.name.trim())) throw new HttpError(409, `Type "${d.name}" already exists`);
  return tx(db, () => {
    const id = Number(run(db, 'INSERT INTO project_types (name) VALUES (?)', d.name.trim()).lastInsertRowid);
    setTypeFields(db, id, d.fieldIds ?? []);
    return getType(db, id);
  });
}

export function updateType(db: DatabaseSync, id: number, d: { name?: string; fieldIds?: number[] }): ProjectType {
  getType(db, id);
  return tx(db, () => {
    if (d.name?.trim()) run(db, 'UPDATE project_types SET name=? WHERE id=?', d.name.trim(), id);
    if (d.fieldIds) setTypeFields(db, id, d.fieldIds);
    return getType(db, id);
  });
}

export function deleteType(db: DatabaseSync, id: number) {
  getType(db, id);
  run(db, 'DELETE FROM project_types WHERE id=?', id);
}

export function resolveTypeId(db: DatabaseSync, v: unknown): number | null {
  if (v === null || v === '' || v === undefined) return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) return getType(db, Number(v)).id;
  const t = one(db, 'SELECT id FROM project_types WHERE lower(name)=lower(?)', String(v));
  if (!t) throw new HttpError(400, `Unknown project type "${v}". Types: ${listTypes(db).map(x => x.name).join(', ')}`);
  return t.id;
}

/* ---------------- field values ---------------- */

export function effectiveTypeId(db: DatabaseSync, projectId: number): number | null {
  const r = one(db, `WITH RECURSIVE up(id, parent_id, type_id, depth) AS (
      SELECT id, parent_id, type_id, 0 FROM projects WHERE id=?
      UNION ALL SELECT p.id, p.parent_id, p.type_id, depth+1 FROM projects p JOIN up ON p.id=up.parent_id)
    SELECT type_id FROM up WHERE type_id IS NOT NULL ORDER BY depth LIMIT 1`, projectId);
  return r?.type_id ?? null;
}

function projectOf(db: DatabaseSync, entity: Entity, id: number): number {
  if (entity === 'project') return must(one(db, 'SELECT id FROM projects WHERE id=?', id), 'Project').id;
  return must(one(db, 'SELECT project_id FROM tasks WHERE id=?', id), 'Task').project_id;
}

export function ancestorIds(db: DatabaseSync, projectId: number): number[] {
  return all(db, `WITH RECURSIVE up(id, parent_id, depth) AS (SELECT id, parent_id, 0 FROM projects WHERE id=?
      UNION ALL SELECT p.id, p.parent_id, depth+1 FROM projects p JOIN up ON p.id=up.parent_id) SELECT id FROM up ORDER BY depth`, projectId).map(r => r.id);
}

const addedTo = (db: DatabaseSync, projectId: number, target: Entity) =>
  all(db, 'SELECT f.* FROM project_fields pf JOIN fields f ON f.id=pf.field_id WHERE pf.project_id=? AND f.target=? ORDER BY pf.position, f.id', projectId, target).map(toField);

/** Type fields first, then fields added to ancestor projects (outermost first), then ones added to this entity. */
export function applicableFields(db: DatabaseSync, entity: Entity, id: number): (Field & { source: FieldSource })[] {
  const projectId = projectOf(db, entity, id);
  const out = new Map<number, Field & { source: FieldSource }>();
  const typeId = effectiveTypeId(db, projectId);
  if (typeId !== null) for (const f of getType(db, typeId).fields) if (f.target === entity) out.set(f.id, { ...f, source: 'type' });
  for (const pid of ancestorIds(db, projectId).reverse()) {
    const source: FieldSource = entity === 'project' && pid === projectId ? 'own' : 'parent';
    for (const f of addedTo(db, pid, entity)) if (!out.has(f.id)) out.set(f.id, { ...f, source });
  }
  if (entity === 'task')
    for (const f of all(db, 'SELECT f.* FROM task_fields tf JOIN fields f ON f.id=tf.field_id WHERE tf.task_id=? ORDER BY tf.position, f.id', id).map(toField))
      if (!out.has(f.id)) out.set(f.id, { ...f, source: 'own' });
  return [...out.values()];
}

// A link must point at another existing project and, for projects, must not loop back (A on B on A).
function checkLink(db: DatabaseSync, f: Field, entity: Entity, id: number, raw: unknown): number {
  let target: number;
  try { target = resolveProjectRef(db, raw); } catch (e) { throw new HttpError(400, `Invalid value for "${f.name}": ${(e as Error).message}`); }
  if (entity !== 'project') return target;
  if (target === id) throw new HttpError(400, `"${f.name}" cannot point a project at itself`);
  const seen = new Set<number>();
  for (let cur: number | null = target; cur !== null && !seen.has(cur); ) {
    if (cur === id) throw new HttpError(400, `"${f.name}" would make a loop: that project already depends on this one`);
    seen.add(cur);
    const next: string | undefined = one(db, 'SELECT value FROM field_values WHERE field_id=? AND entity_id=?', f.id, cur)?.value;
    cur = next === undefined ? null : +next;
  }
  return target;
}

function resolveField(db: DatabaseSync, ref: string | number, targets: Entity[]): Field {
  const hits = listFields(db).filter(f => targets.includes(f.target) && (f.id === Number(ref) || f.name.toLowerCase() === String(ref).toLowerCase()));
  if (hits.length > 1) throw new HttpError(400, `"${ref}" matches a project field and a task field; pass the field id`);
  if (!hits.length) throw new HttpError(400, `Unknown field "${ref}"`);
  return hits[0];
}

/**
 * Adds a field by hand. On a task: a task field for that task only.
 * On a project: a project field for that project, or a task field for all of its tasks (both inherited by sub-projects).
 */
export function attachField(db: DatabaseSync, entity: Entity, id: number, ref: string | number) {
  const f = resolveField(db, ref, entity === 'task' ? ['task'] : ['project', 'task']);
  tx(db, () => {
    if (entity === 'task') {
      if (applicableFields(db, 'task', id).some(x => x.id === f.id)) throw new HttpError(409, `"${f.name}" is already on this task`);
      run(db, 'INSERT INTO task_fields (task_id,field_id,position) VALUES (?,?,(SELECT coalesce(max(position),0)+1 FROM task_fields WHERE task_id=?))', id, f.id, id);
      logEvent(db, id, 'updated', `added field ${f.name}`);
    } else {
      getProject(db, id);
      const already = f.target === 'project' ? applicableFields(db, 'project', id).some(x => x.id === f.id) : projectTaskFields(db, id).some(x => x.id === f.id);
      if (already) throw new HttpError(409, `"${f.name}" is already on this project`);
      run(db, 'INSERT INTO project_fields (project_id,field_id,position) VALUES (?,?,(SELECT coalesce(max(position),0)+1 FROM project_fields WHERE project_id=?))', id, f.id, id);
    }
  });
}

/** Removes a hand-added field. Stored values are kept, so adding it back restores them. */
export function detachField(db: DatabaseSync, entity: Entity, id: number, fieldId: number) {
  const f = getField(db, fieldId);
  const table = entity === 'task' ? 'task_fields' : 'project_fields';
  const col = entity === 'task' ? 'task_id' : 'project_id';
  if (!one(db, `SELECT 1 FROM ${table} WHERE ${col}=? AND field_id=?`, id, fieldId)) {
    throw new HttpError(400, `"${f.name}" comes from the project type or a parent project; remove it there`);
  }
  run(db, `DELETE FROM ${table} WHERE ${col}=? AND field_id=?`, id, fieldId);
  if (entity === 'task') logEvent(db, id, 'updated', `removed field ${f.name}`);
}

export type ProjectTaskField = { id: number; name: string; type: FieldType; source: FieldSource };

/** Task fields added to this project or its ancestors, i.e. shown on every task in it. */
export function projectTaskFields(db: DatabaseSync, projectId: number): ProjectTaskField[] {
  const out = new Map<number, ProjectTaskField>();
  for (const pid of ancestorIds(db, projectId).reverse())
    for (const f of addedTo(db, pid, 'task')) out.set(f.id, { id: f.id, name: f.name, type: f.type, source: pid === projectId ? 'own' : 'parent' });
  return [...out.values()];
}

function fieldValues(db: DatabaseSync, entity: Entity, id: number): FieldValue[] {
  const fields = applicableFields(db, entity, id);
  if (!fields.length) return [];
  const vals = new Map(all(db, `SELECT field_id, value FROM field_values WHERE entity_id=? AND field_id IN (${placeholders(fields.length)})`, id, ...fields.map(f => f.id))
    .map(r => [r.field_id, r.value]));
  return fields.map(({ target, ...f }) => {
    const value = vals.get(f.id) ?? null;
    if (f.type !== 'link') return { ...f, value };
    return { ...f, value, display: value === null ? null : (one(db, 'SELECT title FROM projects WHERE id=?', +value)?.title ?? null) };
  });
}

/** A project given by id or (case-insensitive) title. */
export function resolveProjectRef(db: DatabaseSync, ref: unknown): number {
  const s = String(ref ?? '').trim();
  if (/^\d+$/.test(s) && one(db, 'SELECT 1 FROM projects WHERE id=?', +s)) return +s;
  const hits = all(db, 'SELECT id FROM projects WHERE lower(title)=lower(?)', s);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw new HttpError(400, `Several projects are called "${s}"; use the project id`);
  throw new HttpError(400, `No project "${s}"`);
}

/** Normalises a value for a field; returns null to clear. Throws a 400 explaining what's valid. */
export function normaliseValue(f: Field, v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const bad = (why: string) => new HttpError(400, `Invalid value for "${f.name}": ${why}`);
  switch (f.type) {
    case 'text': return String(v);
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) throw bad(`expected a number, got "${v}"`);
      return String(n);
    }
    case 'date': {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
      if (!m || isNaN(Date.parse(m[1]))) throw bad(`expected a date as YYYY-MM-DD, got "${v}"`);
      return m[1];
    }
    case 'checkbox': {
      const s = String(v).toLowerCase();
      if (['true', '1', 'yes'].includes(s)) return 'true';
      if (['false', '0', 'no'].includes(s)) return 'false';
      throw bad('expected true or false');
    }
    case 'url': {
      const s = String(v).trim();
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
      try {
        const u = new URL(withScheme);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        if (!u.hostname.includes('.') && u.hostname !== 'localhost' && !u.port) throw new Error();
      } catch {
        throw bad(`expected a URL (e.g. https://github.com/me/app or 192.168.1.10:8080), got "${s}"`);
      }
      return withScheme;
    }
    case 'link': return String(v); // resolved to a project id by setFieldValues
    case 'select': {
      const s = String(v).trim();
      const hit = f.options.find(o => o.toLowerCase() === s.toLowerCase());
      if (!hit) throw bad(`"${s}" is not an option. Options: ${f.options.join(', ') || '(none defined yet)'}`);
      return hit;
    }
  }
}

export function setFieldValues(db: DatabaseSync, entity: Entity, id: number, values: Values, o: { log?: boolean } = {}) {
  const fields = applicableFields(db, entity, id);
  const changed: string[] = [];
  tx(db, () => {
    for (const [key, raw] of Object.entries(values)) {
      const f = fields.find(x => String(x.id) === key || x.name.toLowerCase() === key.toLowerCase());
      if (!f) {
        const names = fields.map(x => x.name).join(', ');
        throw new HttpError(400, `Field "${key}" does not apply to this ${entity}. ${names ? `Its fields: ${names}.` : 'It has no custom fields yet.'} Add one with fields_attach.`);
      }
      let v = normaliseValue(f, raw);
      if (f.type === 'link' && v !== null) v = String(checkLink(db, f, entity, id, raw));
      changed.push(f.name);
      if (v === null) run(db, 'DELETE FROM field_values WHERE field_id=? AND entity_id=?', f.id, id);
      else run(db, 'INSERT INTO field_values (field_id,entity_id,value) VALUES (?,?,?) ON CONFLICT DO UPDATE SET value=excluded.value', f.id, id, v);
    }
    if (entity === 'task' && o.log !== false && changed.length) logEvent(db, id, 'updated', changed.join(', '));
  });
}

// Turns custom-field filters into SQL conditions on `alias.id`.
function filterSql(db: DatabaseSync, entity: Entity, alias: string, filters: Filter[] = []) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  for (const flt of filters) {
    const r = one(db, 'SELECT * FROM fields WHERE target=? AND (id=? OR lower(name)=lower(?))', entity, Number(flt.field) || -1, String(flt.field));
    if (!r) throw new HttpError(400, `Unknown ${entity} field "${flt.field}". Fields: ${listFields(db, entity).map(f => f.name).join(', ')}`);
    const f = toField(r);
    const has = (cond: string) => `EXISTS (SELECT 1 FROM field_values fv WHERE fv.field_id=${f.id} AND fv.entity_id=${alias}.id AND ${cond})`;
    const val = flt.value === undefined || flt.value === null ? '' : flt.value;
    switch (flt.op) {
      case 'empty': where.push(`NOT ${has('1')}`); break;
      case 'notempty': where.push(has('1')); break;
      case 'contains': where.push(has('fv.value LIKE ?')); params.push(`%${val}%`); break;
      case 'eq': case 'neq': {
        if (f.type === 'checkbox' && normaliseValue(f, val) === 'false') {
          where.push(flt.op === 'eq' ? `NOT ${has("fv.value='true'")}` : has("fv.value='true'"));
          break;
        }
        const v = f.type === 'link'
          ? String((() => { try { return resolveProjectRef(db, val); } catch { return -1; } })())
          : f.type === 'select' || f.type === 'text' ? String(val) : normaliseValue(f, val) ?? '';
        where.push(flt.op === 'eq' ? has('lower(fv.value)=lower(?)') : `NOT ${has('lower(fv.value)=lower(?)')}`);
        params.push(v);
        break;
      }
      case 'lt': case 'gt': {
        const cmp = flt.op === 'lt' ? '<' : '>';
        if (f.type === 'number') { where.push(has(`CAST(fv.value AS REAL) ${cmp} ?`)); params.push(Number(normaliseValue(f, val))); }
        else { where.push(has(`fv.value ${cmp} ?`)); params.push(normaliseValue(f, val) ?? ''); }
        break;
      }
      default: throw new HttpError(400, `Unknown filter op "${flt.op}". Use eq, neq, lt, gt, contains, empty, notempty`);
    }
  }
  return { where, params };
}

/* ---------------- projects ---------------- */

export type Project = {
  id: number; parent_id: number | null; type_id: number | null; effective_type_id: number | null;
  title: string; description: string; color: string; icon: string; archived: boolean; position: number;
  /** True when icon (and colour, if it has none of its own) come from the nearest ancestor with an icon. */
  icon_inherited: boolean;
  /** Log completed tasks to the logbook: true/false set here, null = inherit from the parent (default on). */
  log_completed: boolean | null; log_completed_effective: boolean;
  /** Added or changed outside the browser (Claude, API, …) and not opened since; unseen_tasks counts its own tasks in that state. */
  unseen: Unseen; unseen_tasks: number;
  /** Closed as completed / abandoned / on_hold, with its notes (see closure.ts). */
  closed: string | null; closure: Record<string, unknown> | null;
  created: string; updated: string; fields: FieldValue[]; task_fields: ProjectTaskField[];
};

/** The icon a project shows: its own, else the nearest ancestor's (with that ancestor's colour unless it has its own). */
export function projectLook(db: DatabaseSync, id: number): { icon: string; color: string; inherited: boolean } {
  const chain = all(db, `WITH RECURSIVE a(id, parent_id, icon, color, depth) AS (
      SELECT id, parent_id, icon, color, 0 FROM projects WHERE id=?
      UNION ALL SELECT p.id, p.parent_id, p.icon, p.color, a.depth+1 FROM projects p JOIN a ON p.id=a.parent_id WHERE a.depth < 50)
    SELECT icon, color FROM a ORDER BY depth`, id);
  const own = chain[0], from = chain.find(r => r.icon);
  if (!own || own.icon || !from) return { icon: own?.icon ?? '', color: own?.color ?? '', inherited: false };
  return { icon: from.icon, color: own.color || from.color, inherited: true };
}

export type Unseen = 'new' | 'updated' | null;
// ms precision so a change and an open in the same second still order correctly
const stamp = () => new Date().toISOString();
const unseenOf = (r: Row): Unseen => (r.changed_at && (!r.seen_at || r.changed_at > r.seen_at) ? (r.seen_at ? 'updated' : 'new') : null);
/** Your own changes in the browser count as seen; anyone else's (Claude, API, monitors, accepted activity) mark it changed. Imports do neither. */
function touchSeen(db: DatabaseSync, table: 'tasks' | 'projects', id: number, created = false) {
  const who = actor.getStore() ?? 'system';
  if (who === 'import') return;
  if (who === 'web') run(db, `UPDATE ${table} SET seen_at=? WHERE id=?`, stamp(), id);
  // "new" is only for something created elsewhere and never opened; a change to anything older (imported, or from before this) is "updated"
  else run(db, `UPDATE ${table} SET changed_at=?${created ? '' : ", seen_at=coalesce(seen_at, '1970-01-01T00:00:00.000Z')"} WHERE id=?`, stamp(), id);
}

const toProject = (db: DatabaseSync, r: Row): Project => ({
  id: r.id, parent_id: r.parent_id, type_id: r.type_id, effective_type_id: effectiveTypeId(db, r.id),
  title: r.title, description: r.description, ...lookOf(db, r.id), archived: !!r.archived, position: r.position,
  log_completed: r.log_completed === null ? null : !!r.log_completed, log_completed_effective: logsCompletedTasks(db, r.id),
  created: r.created, updated: r.updated, fields: fieldValues(db, 'project', r.id), task_fields: projectTaskFields(db, r.id),
  unseen: unseenOf(r), closed: r.closed ?? null, closure: r.closure ? JSON.parse(r.closure) : null,
  unseen_tasks: one(db, 'SELECT count(*) n FROM tasks WHERE project_id=? AND changed_at IS NOT NULL AND (seen_at IS NULL OR changed_at > seen_at)', r.id)!.n as number,
});

/** Opening a project in the browser clears its own highlight (its tasks keep theirs until each is opened). */
export function markProjectSeen(db: DatabaseSync, id: number) {
  getProject(db, id);
  run(db, 'UPDATE projects SET seen_at=? WHERE id=?', stamp(), id);
}

export function getProject(db: DatabaseSync, id: number): Project {
  return toProject(db, must(one(db, 'SELECT * FROM projects WHERE id=?', id), 'Project'));
}

export function listProjects(db: DatabaseSync, o: { archived?: boolean; parentId?: number | null; q?: string; filters?: Filter[] } = {}): Project[] {
  const where = ['1=1'];
  const params: SQLInputValue[] = [];
  if (o.archived !== undefined) { where.push('p.archived=?'); params.push(o.archived ? 1 : 0); }
  if (o.parentId !== undefined) { where.push(o.parentId === null ? 'p.parent_id IS NULL' : 'p.parent_id=?'); if (o.parentId !== null) params.push(o.parentId); }
  if (o.q) { where.push('p.title LIKE ?'); params.push(`%${o.q}%`); }
  const f = filterSql(db, 'project', 'p', o.filters);
  return all(db, `SELECT p.* FROM projects p WHERE ${[...where, ...f.where].join(' AND ')} ORDER BY lower(p.title), p.id`, ...params, ...f.params)
    .map(r => toProject(db, r));
}

export function descendantIds(db: DatabaseSync, id: number): number[] {
  return all(db, `WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT p.id FROM projects p JOIN d ON p.parent_id=d.id) SELECT id FROM d`, id).map(r => r.id);
}

type ProjectInput = {
  title?: string; description?: string; color?: string; icon?: string; parent_id?: number | null; type_id?: unknown; archived?: boolean;
  position?: number; fields?: Values; log_completed?: boolean | null;
};

/** Nearest project up the tree that sets log_completed decides; on when nobody does. */
export function logsCompletedTasks(db: DatabaseSync, projectId: number): boolean {
  for (const pid of ancestorIds(db, projectId)) {
    const v = one(db, 'SELECT log_completed FROM projects WHERE id=?', pid)?.log_completed;
    if (v !== null && v !== undefined) return !!v;
  }
  return true;
}

const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif)$/;

// An icon is a name from the UI's icon set, a short emoji, or "img:<attachment id>" for an uploaded image; empty means "use the colour dot".
function checkIcon(db: DatabaseSync, icon: string | undefined) {
  if (icon === undefined) return;
  if (typeof icon !== 'string' || icon.length > 24) throw new HttpError(400, 'icon must be an icon name, emoji or img:<attachment id> (24 characters max)');
  const m = /^img:(\d+)$/.exec(icon.trim());
  if (icon.trim().startsWith('img:') && !(m && INLINE_IMAGE.test(one(db, 'SELECT mime FROM attachments WHERE id=?', +m[1])?.mime ?? ''))) {
    throw new HttpError(400, 'img: icons must point at an uploaded PNG, JPEG, GIF, WebP or AVIF image');
  }
}

function checkParent(db: DatabaseSync, id: number | null, parent: number | null | undefined) {
  if (parent === undefined || parent === null) return;
  getProject(db, parent);
  if (id !== null && descendantIds(db, id).includes(parent)) throw new HttpError(400, 'A project cannot be moved inside itself');
}

export function createProject(db: DatabaseSync, d: ProjectInput, o: { buckets?: string[] } = {}): Project {
  if (!d.title?.trim()) throw new HttpError(400, 'title is required');
  checkParent(db, null, d.parent_id);
  checkIcon(db, d.icon);
  return tx(db, () => {
    const pos = d.position ?? (one(db, 'SELECT coalesce(max(position),0)+1 p FROM projects')!.p);
    const id = Number(run(db, 'INSERT INTO projects (parent_id,type_id,title,description,color,icon,archived,position) VALUES (?,?,?,?,?,?,?,?)',
      d.parent_id ?? null, resolveTypeId(db, d.type_id), d.title!.trim(), d.description ?? '', d.color ?? '', d.icon?.trim() ?? '', d.archived ? 1 : 0, pos).lastInsertRowid);
    (o.buckets ?? ['To-Do', 'Doing', 'Done']).forEach((t, i) => run(db, 'INSERT INTO buckets (project_id,title,position) VALUES (?,?,?)', id, t, i + 1));
    if (d.fields) setFieldValues(db, 'project', id, d.fields);
    touchSeen(db, 'projects', id, true);
    return getProject(db, id);
  });
}

export function updateProject(db: DatabaseSync, id: number, d: ProjectInput): Project {
  getProject(db, id);
  if (d.title !== undefined && !d.title.trim()) throw new HttpError(400, 'title cannot be empty');
  checkParent(db, id, d.parent_id);
  checkIcon(db, d.icon);
  return tx(db, () => {
    const patch: Row = { ...d, archived: d.archived === undefined ? undefined : d.archived ? 1 : 0, icon: d.icon?.trim() };
    if ('type_id' in d) patch.type_id = resolveTypeId(db, d.type_id);
    const { set, vals } = patchSql(patch, ['title', 'description', 'color', 'icon', 'parent_id', 'archived', 'position']);
    if (set) run(db, `UPDATE projects SET ${set}, updated=? WHERE id=?`, ...vals, now(), id);
    if ('type_id' in d) run(db, 'UPDATE projects SET type_id=? WHERE id=?', patch.type_id, id);
    if ('log_completed' in d) run(db, 'UPDATE projects SET log_completed=? WHERE id=?', d.log_completed === null || d.log_completed === undefined ? null : d.log_completed ? 1 : 0, id);
    if (d.fields) setFieldValues(db, 'project', id, d.fields);
    touchSeen(db, 'projects', id);
    return getProject(db, id);
  });
}

// Attachment rows outlive their task (ON DELETE SET NULL), so delete them and their files explicitly.
function deleteTaskAttachments(db: DatabaseSync, dataDir: string | undefined, where: string, ...p: SQLInputValue[]) {
  const ids = all(db, `SELECT a.id FROM attachments a JOIN tasks t ON t.id=a.task_id WHERE ${where}`, ...p).map(r => r.id as number);
  for (const aid of ids) {
    run(db, 'DELETE FROM attachments WHERE id=?', aid);
    if (dataDir) rmSync(attachmentPath(dataDir, aid), { force: true });
  }
}

export function deleteProject(db: DatabaseSync, id: number, dataDir?: string) {
  getProject(db, id);
  tx(db, () => {
    const ids = descendantIds(db, id);
    deleteTaskAttachments(db, dataDir, `t.project_id IN (${placeholders(ids.length)})`, ...ids);
    run(db, 'DELETE FROM projects WHERE id=?', id);
  });
}

/* ---------------- buckets ---------------- */

export type Bucket = { id: number; project_id: number; title: string; position: number };

export function listBuckets(db: DatabaseSync, projectId: number): Bucket[] {
  getProject(db, projectId);
  return all(db, 'SELECT * FROM buckets WHERE project_id=? ORDER BY position, id', projectId) as Bucket[];
}

const getBucket = (db: DatabaseSync, id: number) => must(one(db, 'SELECT * FROM buckets WHERE id=?', id), 'Bucket') as Bucket;

// Keeps the invariant: a task is done exactly when it sits in its project's last bucket.
function resyncProject(db: DatabaseSync, projectId: number) {
  const b = listBuckets(db, projectId);
  if (!b.length) return;
  const first = b[0].id, last = b[b.length - 1].id;
  run(db, 'UPDATE tasks SET bucket_id=? WHERE project_id=? AND done=1 AND (bucket_id IS NULL OR bucket_id<>?)', last, projectId, last);
  run(db, 'UPDATE tasks SET bucket_id=? WHERE project_id=? AND done=0 AND (bucket_id IS NULL OR bucket_id=?)', b.length > 1 ? first : last, projectId, last);
  if (b.length === 1) run(db, 'UPDATE tasks SET done=1, done_at=coalesce(done_at,?) WHERE project_id=?', now(), projectId);
}

export function createBucket(db: DatabaseSync, projectId: number, d: { title: string; position?: number }): Bucket {
  if (!d.title?.trim()) throw new HttpError(400, 'title is required');
  return tx(db, () => {
    const b = listBuckets(db, projectId);
    // new columns always go before the done (last) column; the done column only changes by renaming it
    const last = b.at(-1)!;
    const beforeLast = b.length >= 2 ? (b[b.length - 2].position + last.position) / 2 : last.position - 1;
    const pos = d.position === undefined || d.position >= last.position ? beforeLast : d.position;
    const id = Number(run(db, 'INSERT INTO buckets (project_id,title,position) VALUES (?,?,?)', projectId, d.title.trim(), pos).lastInsertRowid);
    resyncProject(db, projectId);
    return getBucket(db, id);
  });
}

export function updateBucket(db: DatabaseSync, id: number, d: { title?: string }): Bucket {
  getBucket(db, id);
  if (d.title !== undefined && !d.title.trim()) throw new HttpError(400, 'title cannot be empty');
  run(db, 'UPDATE buckets SET title=coalesce(?,title) WHERE id=?', d.title?.trim() || null, id);
  return getBucket(db, id);
}

/** Reorders all of a project's columns at once. The done (last) column has to stay last. */
export function reorderBuckets(db: DatabaseSync, projectId: number, ids: number[]): Bucket[] {
  const cur = listBuckets(db, projectId);
  if (ids.length !== cur.length || !cur.every(b => ids.includes(b.id))) throw new HttpError(400, 'ids must list every column of the project exactly once');
  if (ids.at(-1) !== cur.at(-1)!.id) throw new HttpError(400, 'The done column has to stay last. Rename columns instead to change which one means done.');
  tx(db, () => ids.forEach((bid, i) => run(db, 'UPDATE buckets SET position=? WHERE id=?', i + 1, bid)));
  return listBuckets(db, projectId);
}

export function deleteBucket(db: DatabaseSync, id: number) {
  const b = getBucket(db, id);
  const all = listBuckets(db, b.project_id);
  if (all.at(-1)!.id === id) throw new HttpError(400, 'The done column (the last one) cannot be deleted; rename it instead.');
  tx(db, () => {
    run(db, 'UPDATE tasks SET bucket_id=? WHERE bucket_id=?', all[0].id === id ? all[1].id : all[0].id, id);
    run(db, 'DELETE FROM buckets WHERE id=?', id);
  });
}

/* ---------------- labels ---------------- */

export type Label = { id: number; title: string; color: string };
export const listLabels = (db: DatabaseSync) => all(db, 'SELECT * FROM labels ORDER BY title') as Label[];

export function createLabel(db: DatabaseSync, d: { title: string; color?: string }): Label {
  if (!d.title?.trim()) throw new HttpError(400, 'title is required');
  if (one(db, 'SELECT 1 FROM labels WHERE lower(title)=lower(?)', d.title.trim())) throw new HttpError(409, `Label "${d.title}" already exists`);
  const id = run(db, 'INSERT INTO labels (title,color) VALUES (?,?)', d.title.trim(), d.color ?? '').lastInsertRowid;
  return one(db, 'SELECT * FROM labels WHERE id=?', id) as Label;
}

export function updateLabel(db: DatabaseSync, id: number, d: { title?: string; color?: string }): Label {
  must(one(db, 'SELECT 1 FROM labels WHERE id=?', id), 'Label');
  run(db, 'UPDATE labels SET title=coalesce(?,title), color=coalesce(?,color) WHERE id=?', d.title?.trim() || null, d.color ?? null, id);
  return one(db, 'SELECT * FROM labels WHERE id=?', id) as Label;
}

export function deleteLabel(db: DatabaseSync, id: number) {
  must(one(db, 'SELECT 1 FROM labels WHERE id=?', id), 'Label');
  run(db, 'DELETE FROM labels WHERE id=?', id);
}

// Labels given by id or title; unknown titles are created.
function resolveLabels(db: DatabaseSync, labels: (string | number)[]): number[] {
  return labels.map(l => {
    if (typeof l === 'number' || /^\d+$/.test(String(l))) return must(one(db, 'SELECT id FROM labels WHERE id=?', Number(l)), `Label ${l}`).id;
    return one(db, 'SELECT id FROM labels WHERE lower(title)=lower(?)', String(l))?.id ?? createLabel(db, { title: String(l) }).id;
  });
}

/* ---------------- tasks ---------------- */

/** Repeat every N days / weeks / months / years, counted from the due date or from when it was done. */
export type Repeat = { every: number; unit: 'day' | 'week' | 'month' | 'year'; from: 'due' | 'done' };

export type Task = {
  id: number; project_id: number; project_title: string; bucket_id: number | null; bucket_title: string | null; title: string; description: string;
  issue: string; workaround: string; resolution: string;
  checklist: ChecklistItem[]; checklist_style: 'bullets' | 'numbered'; checklist_enabled: boolean;
  requirements: ChecklistItem[]; requirements_style: 'bullets' | 'numbered'; requirements_enabled: boolean;
  resources: ChecklistItem[]; resources_style: 'bullets' | 'numbered'; resources_enabled: boolean;
  done: boolean; done_at: string | null; priority: number; due_date: string | null; position: number;
  created: string; updated: string; labels: Label[]; fields: FieldValue[]; repeat: Repeat | null;
  /** Added or changed outside the browser and not opened since. */
  unseen: Unseen;
  closed: string | null; closure: Record<string, unknown> | null;
};

const toTask = (db: DatabaseSync, r: Row): Task => ({
  id: r.id, project_id: r.project_id, project_title: r.project_title, bucket_id: r.bucket_id, bucket_title: r.bucket_title, title: r.title,
  description: r.description, issue: r.issue, workaround: r.workaround, resolution: r.resolution,
  checklist: listChecklist(db, r.id), checklist_style: r.checklist_style, checklist_enabled: !!r.checklist_enabled,
  requirements: listChecklist(db, r.id, 'requirements'), requirements_style: r.requirements_style, requirements_enabled: !!r.requirements_enabled,
  resources: listChecklist(db, r.id, 'resources'), resources_style: r.resources_style, resources_enabled: !!r.resources_enabled,
  done: !!r.done, done_at: r.done_at, priority: r.priority, due_date: r.due_date,
  position: r.position, created: r.created, updated: r.updated,
  labels: all(db, 'SELECT l.* FROM task_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.task_id=? ORDER BY l.title', r.id) as Label[],
  fields: fieldValues(db, 'task', r.id),
  unseen: unseenOf(r), closed: r.closed ?? null, closure: r.closure ? JSON.parse(r.closure) : null,
  repeat: r.repeat ? JSON.parse(r.repeat) : null,
});

const TASK_SELECT = 'SELECT t.*, p.title project_title, b.title bucket_title FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN buckets b ON b.id=t.bucket_id';

export function getTask(db: DatabaseSync, id: number): Task {
  return toTask(db, must(one(db, `${TASK_SELECT} WHERE t.id=?`, id), 'Task'));
}

export type TaskQuery = {
  projectId?: number; includeSub?: boolean; done?: boolean; labelIds?: number[]; priorityMin?: number;
  dueBefore?: string; dueAfter?: string; q?: string; filters?: Filter[]; limit?: number;
};

export function listTasks(db: DatabaseSync, o: TaskQuery = {}): Task[] {
  const where = ['1=1'];
  const params: SQLInputValue[] = [];
  if (o.projectId !== undefined) {
    const ids = o.includeSub === false ? [o.projectId] : descendantIds(db, o.projectId);
    where.push(`t.project_id IN (${placeholders(ids.length)})`);
    params.push(...ids);
  }
  if (o.done !== undefined) { where.push('t.done=?'); params.push(o.done ? 1 : 0); }
  if (o.labelIds?.length) { where.push(`EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id=t.id AND tl.label_id IN (${placeholders(o.labelIds.length)}))`); params.push(...o.labelIds); }
  if (o.priorityMin !== undefined) { where.push('t.priority>=?'); params.push(o.priorityMin); }
  if (o.dueBefore) { where.push('t.due_date IS NOT NULL AND t.due_date<=?'); params.push(o.dueBefore); }
  if (o.dueAfter) { where.push('t.due_date IS NOT NULL AND t.due_date>=?'); params.push(o.dueAfter); }
  if (o.q) {
    const cols = ['title', 'description', ...TEXT_SECTION_KEYS];
    where.push(`(${cols.map(c => `t.${c} LIKE ?`).join(' OR ')} OR EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.task_id=t.id AND ci.text LIKE ?))`);
    params.push(...cols.map(() => `%${o.q}%`), `%${o.q}%`);
  }
  const f = filterSql(db, 'task', 't', o.filters);
  const limit = o.limit ? ` LIMIT ${Math.max(1, Math.floor(o.limit))}` : '';
  return all(db, `${TASK_SELECT} WHERE ${[...where, ...f.where].join(' AND ')} ORDER BY t.done, t.position, t.id${limit}`, ...params, ...f.params)
    .map(r => toTask(db, r));
}

type TaskInput = {
  project_id?: number; title?: string; description?: string; done?: boolean; priority?: number;
  issue?: string; workaround?: string; resolution?: string;
  checklist?: string[]; checklist_style?: 'bullets' | 'numbered'; checklist_enabled?: boolean;
  requirements?: string[]; requirements_style?: 'bullets' | 'numbered'; requirements_enabled?: boolean;
  resources?: string[]; resources_style?: 'bullets' | 'numbered'; resources_enabled?: boolean;
  due_date?: string | null; position?: number; labels?: (string | number)[]; fields?: Values; bucket_id?: number;
  repeat?: Repeat | null;
};

function normaliseDue(v: string | null | undefined) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(v);
  if (isNaN(+d)) throw new HttpError(400, `Invalid due_date "${v}"`);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : d.toISOString();
}

function checkStyle(v: string | undefined) {
  if (v !== undefined && v !== 'bullets' && v !== 'numbered') throw new HttpError(400, 'list styles (checklist_style, requirements_style, resources_style) must be bullets or numbered');
}

function checkPriority(p: number | undefined) {
  if (p !== undefined && !(Number.isInteger(p) && p >= 0 && p <= 5)) throw new HttpError(400, 'priority must be an integer 0-5 (0 unset, 1 low, 2 medium, 3 high, 4 urgent, 5 do now)');
}

function checkRepeat(r: Repeat | null | undefined) {
  if (r == null) return;
  if (!(Number.isInteger(r.every) && r.every >= 1 && r.every <= 999) || !['day', 'week', 'month', 'year'].includes(r.unit) || !['due', 'done'].includes(r.from))
    throw new HttpError(400, 'repeat must be { every: 1-999, unit: day | week | month | year, from: due | done }');
}

export function createTask(db: DatabaseSync, d: TaskInput): Task {
  if (!d.title?.trim()) throw new HttpError(400, 'title is required');
  if (!d.project_id) throw new HttpError(400, 'project_id is required');
  checkPriority(d.priority);
  checkRepeat(d.repeat);
  [d.checklist_style, d.requirements_style, d.resources_style].forEach(checkStyle);
  return tx(db, () => {
    const b = listBuckets(db, d.project_id!);
    const done = !!d.done;
    const bucket = done ? b.at(-1)?.id : b[0]?.id;
    const pos = d.position ?? one(db, 'SELECT coalesce(max(position),0)+1 p FROM tasks WHERE project_id=?', d.project_id!)!.p;
    const id = Number(run(db, `INSERT INTO tasks (project_id,bucket_id,title,description,done,done_at,priority,due_date,position,${TEXT_SECTION_KEYS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      d.project_id!, bucket ?? null, d.title!.trim(), d.description ?? '', done ? 1 : 0, done ? now() : null, d.priority ?? 0, normaliseDue(d.due_date) ?? null, pos,
      ...TEXT_SECTION_KEYS.map(k => d[k] ?? '')).lastInsertRowid);
    if (d.labels) setTaskLabels(db, id, d.labels);
    if (d.fields) setFieldValues(db, 'task', id, d.fields, { log: false });
    if (d.repeat) run(db, 'UPDATE tasks SET repeat=? WHERE id=?', JSON.stringify(d.repeat), id);
    if (d.checklist_style) run(db, 'UPDATE tasks SET checklist_style=? WHERE id=?', d.checklist_style, id);
    d.checklist?.filter(t => String(t).trim()).forEach((t, i) => run(db, 'INSERT INTO checklist_items (task_id,text,position) VALUES (?,?,?)', id, String(t).trim(), i + 1));
    const reqs = d.requirements?.filter(t => String(t).trim()) ?? [];
    reqs.forEach((t, i) => run(db, "INSERT INTO checklist_items (task_id,list,text,position) VALUES (?,'requirements',?,?)", id, String(t).trim(), i + 1));
    d.resources?.filter(t => String(t).trim()).forEach((t, i) => run(db, "INSERT INTO checklist_items (task_id,list,text,position) VALUES (?,'resources',?,?)", id, String(t).trim(), i + 1));
    if (reqs.length || d.requirements_enabled) run(db, 'UPDATE tasks SET requirements_enabled=1 WHERE id=?', id);
    // every list starts switched off unless it was given items or explicitly enabled (older databases default these columns to 1)
    const on = (items: string[] | undefined, flag: boolean | undefined) => (flag ?? !!items?.some(t => String(t).trim())) ? 1 : 0;
    const { set: listSet, vals: listVals } = patchSql({
      requirements_style: d.requirements_style, resources_style: d.resources_style,
      checklist_enabled: on(d.checklist, d.checklist_enabled), resources_enabled: on(d.resources, d.resources_enabled),
    }, ['requirements_style', 'resources_style', 'checklist_enabled', 'resources_enabled']);
    run(db, `UPDATE tasks SET ${listSet} WHERE id=?`, ...listVals, id);
    logEvent(db, id, 'created');
    return getTask(db, id);
  });
}

function setTaskLabels(db: DatabaseSync, id: number, labels: (string | number)[]) {
  run(db, 'DELETE FROM task_labels WHERE task_id=?', id);
  for (const lid of new Set(resolveLabels(db, labels))) run(db, 'INSERT INTO task_labels VALUES (?,?)', id, lid);
}

export function updateTask(db: DatabaseSync, id: number, d: TaskInput): Task {
  const cur = getTask(db, id);
  if (d.title !== undefined && !d.title.trim()) throw new HttpError(400, 'title cannot be empty');
  checkPriority(d.priority);
  checkRepeat(d.repeat);
  [d.checklist_style, d.requirements_style, d.resources_style].forEach(checkStyle);
  return tx(db, () => {
    const flag = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);
    const patch = {
      ...d, due_date: normaliseDue(d.due_date),
      checklist_enabled: flag(d.checklist_enabled), requirements_enabled: flag(d.requirements_enabled), resources_enabled: flag(d.resources_enabled),
    };
    const { set, vals } = patchSql(patch, ['title', 'description', 'priority', 'due_date', 'position', ...TEXT_SECTION_KEYS,
      'checklist_style', 'checklist_enabled', 'requirements_style', 'requirements_enabled', 'resources_style', 'resources_enabled']);
    if (set) run(db, `UPDATE tasks SET ${set} WHERE id=?`, ...vals, id);
    if (d.repeat !== undefined) run(db, 'UPDATE tasks SET repeat=? WHERE id=?', d.repeat ? JSON.stringify(d.repeat) : null, id);
    if (d.project_id !== undefined && d.project_id !== cur.project_id) {
      const b = listBuckets(db, d.project_id);
      run(db, 'UPDATE tasks SET project_id=?, bucket_id=? WHERE id=?', d.project_id, (cur.done ? b.at(-1) : b[0])?.id ?? null, id);
    }
    if (d.bucket_id !== undefined && d.done !== undefined) throw new HttpError(400, 'Pass either done or bucket_id, not both (the last bucket means done)');
    if (d.bucket_id !== undefined) placeInBucket(db, id, d.bucket_id);
    else if (d.done !== undefined && d.done !== cur.done) setDone(db, id, d.done);
    if (d.labels) setTaskLabels(db, id, d.labels);
    if (d.fields) setFieldValues(db, 'task', id, d.fields, { log: false });
    run(db, 'UPDATE tasks SET updated=? WHERE id=?', now(), id);
    const next = getTask(db, id);
    logTaskChanges(db, cur, next, d);
    return getTask(db, id);
  });
}

const SECTION_TITLES: Record<string, string> = { issue: 'issue', workaround: 'workaround', resolution: 'proposed resolution' };
const PRIORITY_NAMES = ['Unset', 'Low', 'Medium', 'High', 'Urgent', 'Do Now'];

// One history line per update listing what changed, plus separate lines for state changes and column moves.
function logTaskChanges(db: DatabaseSync, cur: Task, next: Task, d: TaskInput) {
  const parts: string[] = [];
  if (next.title !== cur.title) parts.push('title');
  if (next.description !== cur.description) parts.push('description');
  for (const k of TEXT_SECTION_KEYS) if (next[k] !== cur[k]) parts.push(SECTION_TITLES[k]);
  if (next.priority !== cur.priority) parts.push(`priority → ${PRIORITY_NAMES[next.priority]}`);
  if (next.due_date !== cur.due_date) parts.push(next.due_date ? `due ${next.due_date.slice(0, 10)}` : 'due date cleared');
  if (next.project_id !== cur.project_id) parts.push(`moved to ${next.project_title}`);
  if (d.labels && next.labels.map(l => l.id).join() !== cur.labels.map(l => l.id).join()) parts.push('labels');
  const fieldsChanged = next.fields.filter(f => f.value !== (cur.fields.find(x => x.id === f.id)?.value ?? null)).map(f => f.name);
  if (fieldsChanged.length) parts.push(fieldsChanged.join(', '));
  if (d.repeat !== undefined && JSON.stringify(next.repeat) !== JSON.stringify(cur.repeat)) parts.push(next.repeat ? `repeats every ${next.repeat.every} ${next.repeat.unit}${next.repeat.every === 1 ? '' : 's'} from ${next.repeat.from === 'due' ? 'the due date' : 'when done'}` : 'stopped repeating');
  if (parts.length) logEvent(db, next.id, 'updated', parts.join(', '));
  if (next.done !== cur.done) logEvent(db, next.id, next.done ? 'done' : 'reopened');
  else if (next.bucket_id !== cur.bucket_id && next.project_id === cur.project_id) logEvent(db, next.id, 'moved', `to ${next.bucket_title}`);
  if (next.done && !cur.done) completed(db, next);
}

/** Run when a task becomes done (recurring.ts adds the next copy of a repeating task). */
export const onCompleted: ((db: DatabaseSync, t: Task) => void)[] = [];
export function completed(db: DatabaseSync, t: Task) {
  logCompletion(db, t);
  for (const f of onCompleted) f(db, getTask(db, t.id));
}

// A finished task becomes a Change entry in its project's logbook (projects can opt out; imports never log).
function logCompletion(db: DatabaseSync, t: Task) {
  if (actor.getStore() === 'import' || !logsCompletedTasks(db, t.project_id)) return;
  // the task's own history already says "Marked Done", so no extra "logged" line there
  createLog(db, { project_id: t.project_id, task_id: t.id, kind: 'change', title: t.title, body: t.resolution || t.description }, { taskHistory: false });
}

export function setDone(db: DatabaseSync, id: number, done: boolean) {
  const t = one(db, 'SELECT project_id, bucket_id FROM tasks WHERE id=?', id)!;
  const b = listBuckets(db, t.project_id);
  const last = b.at(-1)?.id;
  const bucket = done ? last : t.bucket_id === last ? b[0]?.id : t.bucket_id;
  run(db, 'UPDATE tasks SET done=?, done_at=?, bucket_id=? WHERE id=?', done ? 1 : 0, done ? now() : null, bucket ?? null, id);
  if (!done) reopenClosure(db, id);
}

/** Undoing done also undoes a completed / abandoned closure (on hold isn't done, so it stays). */
const reopenClosure = (db: DatabaseSync, id: number) => run(db, "UPDATE tasks SET closed=NULL, closure=NULL WHERE id=? AND closed IN ('completed','abandoned')", id);

function placeInBucket(db: DatabaseSync, id: number, bucketId: number) {
  const t = one(db, 'SELECT project_id, done FROM tasks WHERE id=?', id)!;
  const bucket = getBucket(db, bucketId);
  if (bucket.project_id !== t.project_id) throw new HttpError(400, 'Bucket belongs to a different project');
  const isLast = listBuckets(db, t.project_id).at(-1)!.id === bucketId;
  run(db, 'UPDATE tasks SET bucket_id=?, done=?, done_at=CASE WHEN ? THEN coalesce(done_at,?) ELSE NULL END WHERE id=?', bucketId, isLast ? 1 : 0, isLast ? 1 : 0, now(), id);
  if (!isLast) reopenClosure(db, id);
}

/**
 * Moves a task to a kanban column. The column may belong to an ancestor project (combined view):
 * then the task goes to its own project's bucket with the same title, created at the matching spot if missing.
 */
export function moveTask(db: DatabaseSync, id: number, d: { bucketId: number; position?: number }): Task {
  const t = getTask(db, id);
  const col = getBucket(db, d.bucketId);
  return tx(db, () => {
    let target = col.id;
    if (col.project_id !== t.project_id) {
      if (!descendantIds(db, col.project_id).includes(t.project_id)) throw new HttpError(400, 'That column belongs to a project whose board does not show this task');
      const own = listBuckets(db, t.project_id);
      const viewCols = listBuckets(db, col.project_id);
      const match = viewCols.at(-1)!.id === col.id ? own.at(-1) : own.find(b => b.title.toLowerCase() === col.title.toLowerCase());
      if (match) target = match.id;
      else {
        const idx = viewCols.findIndex(b => b.id === col.id);
        const at = Math.min(idx, own.length - 1);
        const before = at > 0 ? own[at - 1].position : own[0].position - 1;
        target = createBucket(db, t.project_id, { title: col.title, position: (before + own[at].position) / 2 }).id;
      }
    }
    placeInBucket(db, id, target);
    if (d.position !== undefined) run(db, 'UPDATE tasks SET position=? WHERE id=?', d.position, id);
    run(db, 'UPDATE tasks SET updated=? WHERE id=?', now(), id);
    const next = getTask(db, id);
    if (next.done !== t.done) logEvent(db, id, next.done ? 'done' : 'reopened');
    else if (next.bucket_id !== t.bucket_id) logEvent(db, id, 'moved', `to ${next.bucket_title}`);
    if (next.done && !t.done) completed(db, next);
    return next;
  });
}

export function deleteTask(db: DatabaseSync, id: number, dataDir?: string) {
  getTask(db, id);
  tx(db, () => {
    deleteTaskAttachments(db, dataDir, 't.id=?', id);
    run(db, 'DELETE FROM tasks WHERE id=?', id);
  });
}

/* ---------------- checklists: "tasks" and "requirements" ---------------- */

export type ChecklistList = 'tasks' | 'requirements' | 'resources';
export type ChecklistItem = { id: number; parent_id: number | null; text: string; done: boolean; position: number };
const LISTS: ChecklistList[] = ['tasks', 'requirements', 'resources'];
const NOUN = { tasks: ['checklist item', 'subtask'], requirements: ['requirement', 'sub-requirement'], resources: ['resource', 'sub-resource'] } as const;
const ENABLED_COLUMN = { tasks: 'checklist_enabled', requirements: 'requirements_enabled', resources: 'resources_enabled' } as const;

function checkList(list: unknown): ChecklistList {
  if (list === undefined || list === null) return 'tasks';
  if (!LISTS.includes(list as ChecklistList)) throw new HttpError(400, 'list must be tasks, requirements or resources');
  return list as ChecklistList;
}

/** One list of a task: top-level items in order, each followed by its sub-items in order. */
function listChecklist(db: DatabaseSync, taskId: number, list: ChecklistList = 'tasks'): ChecklistItem[] {
  const rows = all(db, 'SELECT id, parent_id, text, done, position FROM checklist_items WHERE task_id=? AND list=? ORDER BY position, id', taskId, list)
    .map(r => ({ id: r.id, parent_id: r.parent_id ?? null, text: r.text, done: !!r.done, position: r.position }) as ChecklistItem);
  return rows.filter(r => r.parent_id === null).flatMap(top => [top, ...rows.filter(r => r.parent_id === top.id)]);
}

const getItem = (db: DatabaseSync, id: number) => must(one(db, 'SELECT * FROM checklist_items WHERE id=?', id), 'Checklist item');

export function addChecklistItem(db: DatabaseSync, taskId: number, d: { text: string; done?: boolean; parent_id?: number | null; list?: ChecklistList }): ChecklistItem {
  getTask(db, taskId);
  const list = checkList(d.list);
  const text = String(d.text ?? '').trim();
  if (!text) throw new HttpError(400, 'text is required');
  const parent = d.parent_id ? getItem(db, d.parent_id) : null;
  if (parent && parent.task_id !== taskId) throw new HttpError(400, 'parent_id belongs to another task');
  if (parent && parent.list !== list) throw new HttpError(400, 'parent_id is in the other list');
  if (parent && parent.parent_id !== null) throw new HttpError(400, 'Sub-items go one level deep: add it to the top-level item instead');
  return tx(db, () => {
    const id = Number(run(db, `INSERT INTO checklist_items (task_id,parent_id,list,text,done,position)
        VALUES (?,?,?,?,?,(SELECT coalesce(max(position),0)+1 FROM checklist_items WHERE task_id=? AND list=? AND parent_id IS ?))`,
      taskId, parent?.id ?? null, list, text, d.done ? 1 : 0, taskId, list, parent?.id ?? null).lastInsertRowid);
    run(db, `UPDATE tasks SET ${ENABLED_COLUMN[list]}=1 WHERE id=?`, taskId); // adding to a list switches it on
    logEvent(db, taskId, 'updated', `added ${NOUN[list][parent ? 1 : 0]} “${text}”`);
    return listChecklist(db, taskId, list).find(i => i.id === id)!;
  });
}

export function updateChecklistItem(db: DatabaseSync, id: number, d: { text?: string; done?: boolean }): ChecklistItem {
  const cur = getItem(db, id);
  if (d.text !== undefined && !String(d.text).trim()) throw new HttpError(400, 'text cannot be empty');
  run(db, 'UPDATE checklist_items SET text=coalesce(?,text), done=coalesce(?,done) WHERE id=?', d.text?.trim() ?? null, d.done === undefined ? null : d.done ? 1 : 0, id);
  if (d.done !== undefined && d.done !== !!cur.done) logEvent(db, cur.task_id, 'updated', `${d.done ? 'ticked' : 'unticked'} “${d.text?.trim() ?? cur.text}”`);
  return listChecklist(db, cur.task_id, cur.list).find(i => i.id === id)!;
}

export function deleteChecklistItem(db: DatabaseSync, id: number) {
  const cur = getItem(db, id);
  run(db, 'DELETE FROM checklist_items WHERE id=?', id);
  logEvent(db, cur.task_id, 'updated', `removed ${NOUN[cur.list as ChecklistList][cur.parent_id ? 1 : 0]} “${cur.text}”`);
}

/** Orders one group of siblings in one list: its top-level items (parentId null) or the sub-items of one item. */
export function reorderChecklist(db: DatabaseSync, taskId: number, ids: number[], parentId: number | null = null, list: ChecklistList = 'tasks'): ChecklistItem[] {
  const cur = listChecklist(db, taskId, checkList(list)).filter(i => i.parent_id === parentId);
  if (!Array.isArray(ids) || ids.length !== cur.length || !cur.every(i => ids.includes(i.id))) {
    throw new HttpError(400, `ids must list every ${parentId === null ? 'top-level item' : 'sub-item of that item'} in that list exactly once`);
  }
  tx(db, () => ids.forEach((id, i) => run(db, 'UPDATE checklist_items SET position=? WHERE id=?', i + 1, id)));
  return listChecklist(db, taskId, list);
}

/* ---------------- comments ---------------- */

/** source 'agent': written by an accepted activity suggestion (shown with a badge). */
export type Comment = { id: number; task_id: number; body: string; source: string; created: string; updated: string };

export function listComments(db: DatabaseSync, taskId: number): Comment[] {
  getTask(db, taskId);
  return all(db, 'SELECT * FROM comments WHERE task_id=? ORDER BY created, id', taskId) as Comment[];
}

const getComment = (db: DatabaseSync, id: number) => must(one(db, 'SELECT * FROM comments WHERE id=?', id), 'Comment') as Comment;

export function createComment(db: DatabaseSync, taskId: number, d: { body: string; created?: string; source?: 'agent' }): Comment {
  getTask(db, taskId);
  if (!d.body?.trim()) throw new HttpError(400, 'body is required');
  const ts = d.created ?? now();
  const c = getComment(db, Number(run(db, 'INSERT INTO comments (task_id,body,source,created,updated) VALUES (?,?,?,?,?)', taskId, d.body, d.source ?? '', ts, ts).lastInsertRowid));
  if (!d.source) logEvent(db, taskId, 'commented'); // an agent comment comes with its own activity record
  else touchSeen(db, 'tasks', taskId);
  return c;
}

export function updateComment(db: DatabaseSync, id: number, d: { body: string }): Comment {
  getComment(db, id);
  if (!d.body?.trim()) throw new HttpError(400, 'body is required');
  run(db, 'UPDATE comments SET body=?, updated=? WHERE id=?', d.body, now(), id);
  const c = getComment(db, id);
  logEvent(db, c.task_id, 'updated', 'comment edited');
  return c;
}

export function deleteComment(db: DatabaseSync, id: number) {
  const c = getComment(db, id);
  run(db, 'DELETE FROM comments WHERE id=?', id);
  logEvent(db, c.task_id, 'updated', 'comment deleted');
}

/* ---------------- attachments ---------------- */

export type Attachment = { id: number; task_id: number | null; name: string; mime: string; size: number; created: string };

export function createAttachment(db: DatabaseSync, dataDir: string, d: { name: string; mime: string; data: Uint8Array; taskId?: number | null }): Attachment {
  const dir = join(dataDir, 'files');
  mkdirSync(dir, { recursive: true });
  const id = Number(run(db, 'INSERT INTO attachments (task_id,name,mime,size) VALUES (?,?,?,?)', d.taskId ?? null, d.name, d.mime, d.data.length).lastInsertRowid);
  writeFileSync(join(dir, String(id)), d.data);
  if (d.taskId) logEvent(db, d.taskId, 'attached', d.name);
  return getAttachment(db, id);
}

export const getAttachment = (db: DatabaseSync, id: number) => must(one(db, 'SELECT * FROM attachments WHERE id=?', id), 'Attachment') as Attachment;
export const attachmentPath = (dataDir: string, id: number) => join(dataDir, 'files', String(Math.floor(id)));

export function listAttachments(db: DatabaseSync, taskId: number): Attachment[] {
  getTask(db, taskId);
  return all(db, 'SELECT * FROM attachments WHERE task_id=? ORDER BY id', taskId) as Attachment[];
}

export function deleteAttachment(db: DatabaseSync, dataDir: string, id: number) {
  const a = getAttachment(db, id);
  run(db, 'DELETE FROM attachments WHERE id=?', id);
  if (a.task_id) logEvent(db, a.task_id, 'updated', `removed attachment ${a.name}`);
  rmSync(attachmentPath(dataDir, id), { force: true });
}

/* ---------------- infrastructure links ---------------- */

export type Dependent = { id: number; title: string; icon: string; color: string; field: string; depth: number };
const lookOf = (db: DatabaseSync, id: number) => { const l = projectLook(db, id); return { icon: l.icon, color: l.color, icon_inherited: l.inherited }; };

/** Projects that point at this one through a project link field (e.g. Runs On); with transitive, their dependents too. */
export function dependents(db: DatabaseSync, projectId: number, transitive = false): Dependent[] {
  getProject(db, projectId);
  const direct = (pid: number) => all(db, `SELECT p.id, p.title, p.icon, p.color, f.name field FROM field_values fv
      JOIN fields f ON f.id=fv.field_id AND f.type='link' AND f.target='project'
      JOIN projects p ON p.id=fv.entity_id WHERE fv.value=? ORDER BY p.title`, String(pid));
  const out: Dependent[] = [];
  const seen = new Set([projectId]);
  let frontier = [projectId];
  for (let depth = 1; frontier.length; depth++) {
    const next: number[] = [];
    for (const pid of frontier) for (const r of direct(pid)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const { icon, color } = projectLook(db, r.id);
      out.push({ id: r.id, title: r.title, icon, color, field: r.field, depth });
      next.push(r.id);
    }
    frontier = transitive ? next : [];
  }
  return out;
}

export type InfraNode = { id: number; title: string; icon: string; color: string; type: string | null; kind: string | null; children: InfraNode[] };

/** The host → VM/LXC → container → app tree, built from "Runs On" (or, if there is none, every project link field). */
export function infraTree(db: DatabaseSync): InfraNode[] {
  let ids = all(db, "SELECT id FROM fields WHERE type='link' AND target='project' AND lower(name)='runs on'").map(r => r.id);
  if (!ids.length) ids = all(db, "SELECT id FROM fields WHERE type='link' AND target='project'").map(r => r.id);
  if (!ids.length) return [];
  const edges = all(db, `SELECT entity_id child, CAST(value AS INTEGER) parent FROM field_values WHERE field_id IN (${placeholders(ids.length)})`, ...ids)
    .filter(e => one(db, 'SELECT 1 FROM projects WHERE id=?', e.parent));
  const parentOf = new Map<number, number>(edges.map(e => [e.child, e.parent]));
  const members = new Set(edges.flatMap(e => [e.child, e.parent]));
  const kindField = one(db, "SELECT id FROM fields WHERE lower(name)='kind' AND target='project'")?.id;
  const node = (pid: number, seen: Set<number>): InfraNode => {
    const p = getProject(db, pid);
    const kids = [...parentOf].filter(([c, par]) => par === pid && !seen.has(c)).map(([c]) => c);
    return {
      id: p.id, title: p.title, icon: p.icon, color: p.color,
      type: p.effective_type_id ? getType(db, p.effective_type_id).name : null,
      kind: kindField ? (one(db, 'SELECT value FROM field_values WHERE field_id=? AND entity_id=?', kindField, pid)?.value ?? null) : null,
      children: kids.map(c => node(c, new Set([...seen, c]))).sort((a, b) => a.title.localeCompare(b.title)),
    };
  };
  return [...members].filter(m => !parentOf.has(m)).map(r => node(r, new Set([r]))).sort((a, b) => a.title.localeCompare(b.title));
}

/* ---------------- logbook ---------------- */

export const LOG_KINDS = ['change', 'incident', 'maintenance', 'observation'] as const;
export type LogKind = (typeof LOG_KINDS)[number];
export type LogEntry = {
  id: number; project_id: number; project_title: string; task_id: number | null; task_title: string | null; maintenance_id: number | null;
  kind: LogKind; title: string; body: string; rollback: string; actor: string; at: string; created: string; updated: string;
};
type LogInput = { project_id?: number; task_id?: number | null; maintenance_id?: number | null; kind?: LogKind; title?: string; body?: string; rollback?: string; at?: string };

const LOG_SELECT = `SELECT l.*, p.title project_title, t.title task_title FROM log_entries l
  JOIN projects p ON p.id=l.project_id LEFT JOIN tasks t ON t.id=l.task_id`;
const getLogRow = (db: DatabaseSync, id: number) => must(one(db, `${LOG_SELECT} WHERE l.id=?`, id), 'Log entry') as LogEntry;
export const getLog = getLogRow;

function checkKind(kind: unknown) {
  if (!LOG_KINDS.includes(kind as LogKind)) throw new HttpError(400, `kind must be one of ${LOG_KINDS.join(', ')}`);
}

function isoTime(v: string | undefined, what: string): string | undefined {
  if (v === undefined || v === '') return undefined;
  const d = new Date(v);
  if (isNaN(+d)) throw new HttpError(400, `Invalid ${what} "${v}"`);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

export function listLog(db: DatabaseSync, o: { projectId?: number; includeSub?: boolean; kind?: string; since?: string; until?: string; q?: string; taskId?: number; maintenanceId?: number; limit?: number } = {}): LogEntry[] {
  const where = ['1=1'];
  const params: SQLInputValue[] = [];
  if (o.projectId !== undefined) {
    const ids = o.includeSub === false ? [o.projectId] : descendantIds(db, o.projectId);
    where.push(`l.project_id IN (${placeholders(ids.length)})`);
    params.push(...ids);
  }
  if (o.kind) { checkKind(o.kind); where.push('l.kind=?'); params.push(o.kind); }
  if (o.since) { where.push('l.at>=?'); params.push(isoTime(o.since, 'since')!); }
  if (o.until) { where.push('l.at<=?'); params.push(isoTime(o.until, 'until')!); }
  if (o.q) { where.push('(l.title LIKE ? OR l.body LIKE ? OR l.rollback LIKE ?)'); params.push(`%${o.q}%`, `%${o.q}%`, `%${o.q}%`); }
  if (o.taskId !== undefined) { where.push('l.task_id=?'); params.push(o.taskId); }
  if (o.maintenanceId !== undefined) { where.push('l.maintenance_id=?'); params.push(o.maintenanceId); }
  const limit = Math.max(1, Math.min(Math.floor(o.limit ?? 200), 1000));
  return all(db, `${LOG_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.at DESC, l.id DESC LIMIT ${limit}`, ...params) as LogEntry[];
}

export function createLog(db: DatabaseSync, d: LogInput, o: { taskHistory?: boolean } = {}): LogEntry {
  if (!d.project_id) throw new HttpError(400, 'project_id is required');
  getProject(db, d.project_id);
  checkKind(d.kind);
  if (!d.title?.trim()) throw new HttpError(400, 'title is required');
  if (d.task_id) getTask(db, d.task_id);
  const who = actor.getStore() ?? 'system';
  return tx(db, () => {
    const id = Number(run(db, 'INSERT INTO log_entries (project_id,task_id,maintenance_id,kind,title,body,rollback,actor,at) VALUES (?,?,?,?,?,?,?,?,?)',
      d.project_id!, d.task_id ?? null, d.maintenance_id ?? null, d.kind!, d.title!.trim(), d.body ?? '', d.rollback ?? '', who, isoTime(d.at, 'at') ?? now()).lastInsertRowid);
    if (d.task_id && o.taskHistory !== false) logEvent(db, d.task_id, 'updated', `logged ${d.kind} “${d.title!.trim()}”`);
    return getLogRow(db, id);
  });
}

export function updateLog(db: DatabaseSync, id: number, d: LogInput): LogEntry {
  getLogRow(db, id);
  if (d.kind !== undefined) checkKind(d.kind);
  if (d.title !== undefined && !d.title.trim()) throw new HttpError(400, 'title cannot be empty');
  if (d.project_id) getProject(db, d.project_id);
  if (d.task_id) getTask(db, d.task_id);
  const { set, vals } = patchSql({ ...d, title: d.title?.trim(), at: isoTime(d.at, 'at') }, ['project_id', 'task_id', 'kind', 'title', 'body', 'rollback', 'at']);
  if (set) run(db, `UPDATE log_entries SET ${set}, updated=? WHERE id=?`, ...vals, now(), id);
  return getLogRow(db, id);
}

export function deleteLog(db: DatabaseSync, id: number) {
  getLogRow(db, id);
  run(db, 'DELETE FROM log_entries WHERE id=?', id);
}

/* ---------------- recurring maintenance ---------------- */

export const UNITS = ['day', 'week', 'month', 'year'] as const;
export type Unit = (typeof UNITS)[number];
export type Maintenance = {
  id: number; project_id: number; project_title: string; title: string; notes: string; every: number; unit: Unit;
  last_done: string | null; next_due: string; status: 'overdue' | 'due-soon' | 'ok'; runbook_id: number | null; created: string; updated: string;
};
type MaintInput = { project_id?: number; title?: string; notes?: string; every?: number; unit?: Unit; last_done?: string | null; next_due?: string; runbook_id?: number | null };

function checkRunbook(db: DatabaseSync, id: number | null | undefined) {
  if (id && !one(db, 'SELECT 1 FROM runbooks WHERE id=?', id)) throw new HttpError(400, `No runbook ${id}`);
}

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Adds an interval to a YYYY-MM-DD date; months and years clamp to the month's last day (31 Jan + 1 month = 28 Feb). */
export function addInterval(date: string, every: number, unit: Unit): string {
  if (unit === 'day') return plusDays(date, every);
  if (unit === 'week') return plusDays(date, every * 7);
  const [y, m, d] = date.split('-').map(Number);
  const months = (y * 12 + (m - 1)) + every * (unit === 'year' ? 12 : 1);
  const ny = Math.floor(months / 12), nm = months % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

function checkDate(v: string | null | undefined, what: string) {
  if (v === undefined || v === null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) throw new HttpError(400, `${what} must be a date as YYYY-MM-DD`);
}

function checkInterval(every: unknown, unit: unknown) {
  if (every !== undefined && !(Number.isInteger(every) && (every as number) >= 1 && (every as number) <= 1000)) throw new HttpError(400, 'every must be a whole number from 1 to 1000');
  if (unit !== undefined && !UNITS.includes(unit as Unit)) throw new HttpError(400, `unit must be one of ${UNITS.join(', ')}`);
}

const MAINT_SELECT = 'SELECT m.*, p.title project_title FROM maintenance m JOIN projects p ON p.id=m.project_id';
const toMaint = (r: Row): Maintenance => {
  const t = today();
  const status = r.next_due < t ? 'overdue' : r.next_due <= plusDays(t, 7) ? 'due-soon' : 'ok';
  return { ...(r as Maintenance), status };
};
export const getMaintenance = (db: DatabaseSync, id: number) => toMaint(must(one(db, `${MAINT_SELECT} WHERE m.id=?`, id), 'Maintenance item'));

export function listMaintenance(db: DatabaseSync, o: { projectId?: number; includeSub?: boolean; overdue?: boolean; dueWithinDays?: number } = {}): Maintenance[] {
  const where = ['1=1'];
  const params: SQLInputValue[] = [];
  if (o.projectId !== undefined) {
    const ids = o.includeSub === false ? [o.projectId] : descendantIds(db, o.projectId);
    where.push(`m.project_id IN (${placeholders(ids.length)})`);
    params.push(...ids);
  }
  if (o.overdue) { where.push('m.next_due<?'); params.push(today()); }
  if (o.dueWithinDays !== undefined) { where.push('m.next_due<=?'); params.push(plusDays(today(), Math.floor(o.dueWithinDays))); }
  return all(db, `${MAINT_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.next_due, m.title`, ...params).map(toMaint);
}

export function createMaintenance(db: DatabaseSync, d: MaintInput): Maintenance {
  if (!d.project_id) throw new HttpError(400, 'project_id is required');
  getProject(db, d.project_id);
  if (!d.title?.trim()) throw new HttpError(400, 'title is required');
  if (d.every === undefined || d.unit === undefined) throw new HttpError(400, 'every and unit are required (e.g. every 3 month)');
  checkInterval(d.every, d.unit);
  checkDate(d.last_done, 'last_done');
  checkDate(d.next_due, 'next_due');
  checkRunbook(db, d.runbook_id);
  const next = d.next_due ?? (d.last_done ? addInterval(d.last_done, d.every, d.unit) : today());
  const id = Number(run(db, 'INSERT INTO maintenance (project_id,title,notes,every,unit,last_done,next_due,runbook_id) VALUES (?,?,?,?,?,?,?,?)',
    d.project_id, d.title.trim(), d.notes ?? '', d.every, d.unit, d.last_done ?? null, next, d.runbook_id ?? null).lastInsertRowid);
  return getMaintenance(db, id);
}

export function updateMaintenance(db: DatabaseSync, id: number, d: MaintInput): Maintenance {
  const cur = getMaintenance(db, id);
  if (d.title !== undefined && !d.title.trim()) throw new HttpError(400, 'title cannot be empty');
  if (d.project_id) getProject(db, d.project_id);
  checkInterval(d.every, d.unit);
  checkDate(d.last_done, 'last_done');
  checkDate(d.next_due, 'next_due');
  checkRunbook(db, d.runbook_id);
  const every = d.every ?? cur.every, unit = d.unit ?? cur.unit, last = d.last_done === undefined ? cur.last_done : d.last_done;
  // a new interval (or last-done date) re-plans the next due date from the last time it was done, unless one is given
  const replan = d.next_due === undefined && last && (d.every !== undefined || d.unit !== undefined || d.last_done !== undefined);
  const { set, vals } = patchSql({ ...d, title: d.title?.trim(), next_due: replan ? addInterval(last!, every, unit) : d.next_due },
    ['project_id', 'title', 'notes', 'every', 'unit', 'last_done', 'next_due']);
  if ('runbook_id' in d) run(db, 'UPDATE maintenance SET runbook_id=? WHERE id=?', d.runbook_id ?? null, id);
  if (set) run(db, `UPDATE maintenance SET ${set}, updated=? WHERE id=?`, ...vals, now(), id);
  return getMaintenance(db, id);
}

/** Records that it was done: moves the dates on and writes a Maintenance entry to the project's logbook. */
export function markMaintenanceDone(db: DatabaseSync, id: number, d: { date?: string; notes?: string } = {}): { item: Maintenance; log: LogEntry } {
  const cur = getMaintenance(db, id);
  const date = d.date || today();
  checkDate(date, 'date');
  return tx(db, () => {
    run(db, 'UPDATE maintenance SET last_done=?, next_due=?, updated=? WHERE id=?', date, addInterval(date, cur.every, cur.unit), now(), id);
    const log = createLog(db, { project_id: cur.project_id, maintenance_id: id, kind: 'maintenance', title: cur.title, body: d.notes ?? '', at: `${date}T12:00:00Z` });
    return { item: getMaintenance(db, id), log };
  });
}

export function deleteMaintenance(db: DatabaseSync, id: number) {
  getMaintenance(db, id);
  run(db, 'DELETE FROM maintenance WHERE id=?', id);
}

/* ---------------- history ---------------- */

/** Who is acting for the current request: 'web' (logged-in browser), 'api' (token on REST), 'mcp', 'import'. */
export const actor = new AsyncLocalStorage<string>();
export type TaskEvent = { id: number; task_id: number; kind: string; detail: string; actor: string; at: string };

export function logEvent(db: DatabaseSync, taskId: number, kind: string, detail = '') {
  const who = actor.getStore() ?? 'system';
  if (who === 'import' && kind !== 'created') return; // an import is one "created" line, not every step of it
  run(db, 'INSERT INTO task_events (task_id,kind,detail,actor,at) VALUES (?,?,?,?,?)', taskId, kind, who === 'import' ? 'imported from Vikunja' : detail, who, now());
  if (kind !== 'viewed') touchSeen(db, 'tasks', taskId, kind === 'created');
}

/** Opening a task counts once per 10 minutes per actor, so the log isn't flooded. */
export function logView(db: DatabaseSync, taskId: number) {
  getTask(db, taskId);
  const who = actor.getStore() ?? 'system';
  if (who === 'web') run(db, 'UPDATE tasks SET seen_at=? WHERE id=?', stamp(), taskId); // every open counts, even when not logged again
  const since = new Date(Date.now() - 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  if (one(db, "SELECT 1 FROM task_events WHERE task_id=? AND kind='viewed' AND actor=? AND at>=?", taskId, who, since)) return;
  logEvent(db, taskId, 'viewed');
}

export function listEvents(db: DatabaseSync, taskId: number, limit = 100): TaskEvent[] {
  getTask(db, taskId);
  return all(db, 'SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT ?', taskId, Math.max(1, Math.min(limit, 500))) as TaskEvent[];
}

/* ---------------- appearance ---------------- */

export const THEMES = ['light', 'dark', 'system', 'midnight', 'paper', 'nord', 'dracula', 'solarized-light', 'solarized-dark',
  'forest', 'ocean', 'rose', 'sand', 'graphite', 'catppuccin', 'contrast', 'gruvbox-dark', 'gruvbox-light', 'tokyo-night', 'one-dark',
  'monokai', 'everforest', 'kanagawa', 'rose-pine', 'rose-pine-dawn', 'ayu-mirage', 'night-owl', 'github-light', 'github-dark', 'synthwave'] as const;
export const FONTS = ['jakarta', 'figtree', 'plex', 'atkinson', 'inter', 'manrope', 'dm-sans', 'outfit', 'nunito', 'lexend', 'source-sans', 'system'] as const;
/** nav: the sidebar's menu items in order (ids the UI defines) and the ones hidden; showArchived: archived projects in the sidebar. */
export type Appearance = {
  theme: (typeof THEMES)[number]; accent: string | null; font: (typeof FONTS)[number]; taskView: 'panel' | 'page';
  nav: { order: string[]; hidden: string[] }; showArchived: boolean;
};
const DEFAULT_APPEARANCE: Appearance = { theme: 'light', accent: null, font: 'jakarta', taskView: 'panel', nav: { order: [], hidden: ['projects'] }, showArchived: false };

export function getAppearance(db: DatabaseSync): Appearance {
  const r = one(db, "SELECT value FROM meta WHERE key='appearance'");
  const saved = r ? JSON.parse(r.value) : {};
  return { ...DEFAULT_APPEARANCE, ...saved, nav: { ...DEFAULT_APPEARANCE.nav, ...saved.nav } };
}
const navIds = (v: unknown, what: string) => {
  if (!Array.isArray(v) || v.length > 30 || !v.every(x => typeof x === 'string' && /^[a-z-]{1,30}$/.test(x))) throw new HttpError(400, `nav.${what} must be a list of menu item ids`);
  return [...new Set(v as string[])];
};

/** Stored server-side so the look follows the user to any device. The accent is injected into CSS, so it must be a plain hex colour. */
export function setAppearance(db: DatabaseSync, d: Partial<Appearance>): Appearance {
  const next = { ...getAppearance(db) };
  if (d.theme !== undefined) {
    if (!THEMES.includes(d.theme)) throw new HttpError(400, `theme must be one of ${THEMES.join(', ')}`);
    next.theme = d.theme;
  }
  if (d.accent !== undefined) {
    if (d.accent !== null && !/^#[0-9a-f]{6}$/i.test(d.accent)) throw new HttpError(400, 'accent must be a #rrggbb colour or null');
    next.accent = d.accent?.toLowerCase() ?? null;
  }
  if (d.font !== undefined) {
    if (!FONTS.includes(d.font)) throw new HttpError(400, `font must be one of ${FONTS.join(', ')}`);
    next.font = d.font;
  }
  if (d.nav !== undefined) {
    if (!d.nav || typeof d.nav !== 'object') throw new HttpError(400, 'nav must be { order, hidden }');
    next.nav = { order: d.nav.order === undefined ? next.nav.order : navIds(d.nav.order, 'order'), hidden: d.nav.hidden === undefined ? next.nav.hidden : navIds(d.nav.hidden, 'hidden') };
  }
  if (d.showArchived !== undefined) next.showArchived = !!d.showArchived;
  if (d.taskView !== undefined) {
    if (d.taskView !== 'panel' && d.taskView !== 'page') throw new HttpError(400, 'taskView must be panel or page');
    next.taskView = d.taskView;
  }
  run(db, "INSERT INTO meta VALUES ('appearance',?) ON CONFLICT DO UPDATE SET value=excluded.value", JSON.stringify(next));
  return next;
}

/* ---------------- auth ---------------- */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const hasPassword = (db: DatabaseSync) => !!one(db, "SELECT 1 FROM meta WHERE key='password'");

export function setPassword(db: DatabaseSync, pw: string) {
  if (!pw || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  run(db, "INSERT INTO meta VALUES ('password',?) ON CONFLICT DO UPDATE SET value=excluded.value", `${salt}:${hash}`);
  run(db, 'DELETE FROM sessions');
}

export function checkPassword(db: DatabaseSync, pw: string): boolean {
  const r = one(db, "SELECT value FROM meta WHERE key='password'");
  if (!r || typeof pw !== 'string') return false;
  const [salt, hash] = r.value.split(':');
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(pw, salt, 64));
}

// a login lasts until it goes 90 days unused; last_used is written at most once a day
const SESSION_DAYS = 90;
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');

export function createSession(db: DatabaseSync): string {
  const token = randomBytes(32).toString('hex');
  run(db, 'DELETE FROM sessions WHERE coalesce(last_used, created) < ?', daysAgo(SESSION_DAYS));
  run(db, 'INSERT INTO sessions (hash, last_used) VALUES (?, ?)', sha(token), now());
  return token;
}

export function checkSession(db: DatabaseSync, token: string | undefined): boolean {
  if (!token) return false;
  const r = one(db, 'SELECT coalesce(last_used, created) used FROM sessions WHERE hash=?', sha(token));
  if (!r) return false;
  if (r.used < daysAgo(SESSION_DAYS)) { deleteSession(db, token); return false; }
  if (r.used < daysAgo(1)) run(db, 'UPDATE sessions SET last_used=? WHERE hash=?', now(), sha(token));
  return true;
}
export const deleteSession = (db: DatabaseSync, token: string) => run(db, 'DELETE FROM sessions WHERE hash=?', sha(token));

export function createToken(db: DatabaseSync, name: string): { id: number; token: string } {
  const token = `smj_${randomBytes(24).toString('base64url')}`;
  const id = Number(run(db, 'INSERT INTO api_tokens (name,hash,prefix) VALUES (?,?,?)', name?.trim() || 'token', sha(token), token.slice(0, 8)).lastInsertRowid);
  return { id, token };
}

export const listTokens = (db: DatabaseSync) => all(db, 'SELECT id,name,prefix,created,last_used FROM api_tokens ORDER BY id') as { id: number; name: string; prefix: string; created: string; last_used: string | null }[];

export function deleteToken(db: DatabaseSync, id: number) {
  must(one(db, 'SELECT 1 FROM api_tokens WHERE id=?', id), 'Token');
  run(db, 'DELETE FROM api_tokens WHERE id=?', id);
}

export function checkToken(db: DatabaseSync, token: string | undefined): boolean {
  if (!token) return false;
  const r = one(db, 'SELECT id FROM api_tokens WHERE hash=?', sha(token));
  if (r) run(db, 'UPDATE api_tokens SET last_used=? WHERE id=?', now(), r.id);
  return !!r;
}
