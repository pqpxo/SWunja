// SWunja export (everything except secrets, as one zip) and import of Samunja or Vikunja exports.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { tx } from './db.ts';
import * as s from './services.ts';
import { importVikunja } from './importer.ts';

type Row = Record<string, any>;
const FORMAT = 'samunja';
const VERSION = 1;
// never leave the instance: logins, sessions, API tokens, integration secrets, internal markers
const NOT_EXPORTED = new Set(['meta', 'sessions', 'api_tokens', 'secrets', 'update_checks', 'unifi_clients']);

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map(r => r.name).filter(t => !NOT_EXPORTED.has(t));

/** One zip: samunja.json (every data table + appearance) and files/<attachment id>. */
export function exportAll(db: DatabaseSync, dataDir: string): Uint8Array {
  const data = {
    format: FORMAT, version: VERSION, export_id: randomUUID(), exported: new Date().toISOString(),
    appearance: s.getAppearance(db),
    tables: Object.fromEntries(tables(db).map(t => [t, db.prepare(`SELECT * FROM "${t}"`).all()])),
  };
  const files: Record<string, Uint8Array> = { 'samunja.json': strToU8(JSON.stringify(data)) };
  for (const a of data.tables.attachments as Row[]) {
    const p = s.attachmentPath(dataDir, a.id);
    if (existsSync(p)) files[`files/${a.id}`] = readFileSync(p);
  }
  return zipSync(files, { level: 6 });
}

/** Detects the export format and imports it. */
// ponytail: checks the sizes the zip declares, which a hand-made zip could understate; the 100 MB upload limit still applies
const MAX_UNPACKED = 1024 ** 3;

export function importAny(db: DatabaseSync, dataDir: string, zip: Uint8Array, o: { force?: boolean } = {}) {
  let files: Record<string, Uint8Array>, total = 0;
  try {
    files = unzipSync(zip, { filter: f => (total += f.originalSize) <= MAX_UNPACKED });
  } catch { throw new s.HttpError(400, 'That file is not a zip export'); }
  if (total > MAX_UNPACKED) throw new s.HttpError(413, 'That export unpacks to more than 1 GB');
  if (files['samunja.json']) return { format: 'samunja', ...importSamunja(db, dataDir, files, o) };
  if (files['data.json']) return { format: 'vikunja', ...importVikunja(db, dataDir, zip, o) };
  throw new s.HttpError(400, 'Not a SWunja or Vikunja export (no samunja.json or data.json in the zip)');
}

/**
 * Adds a Samunja export alongside what's here: every row gets a new id and every reference is remapped
 * (parents, links between projects, attachment URLs in text, image icons, sub-items). Fields, project types
 * and labels with the same name are reused instead of duplicated.
 */
export function importSamunja(db: DatabaseSync, dataDir: string, files: Record<string, Uint8Array>, o: { force?: boolean } = {}) {
  let data: Row;
  try { data = JSON.parse(strFromU8(files['samunja.json'])); } catch { throw new s.HttpError(400, 'samunja.json is not valid JSON'); }
  if (data.format !== FORMAT || typeof data.version !== 'number') throw new s.HttpError(400, 'Not a SWunja export');
  if (data.version > VERSION) throw new s.HttpError(400, `This export is from a newer SWunja (format ${data.version}); update first`);
  const marker = `samunja_import:${data.export_id}`;
  if (!o.force && db.prepare('SELECT 1 FROM meta WHERE key=?').get(marker))
    throw new s.HttpError(409, 'This export was already imported. Import again with force to add a second copy.');
  const T: Record<string, Row[]> = data.tables ?? {};
  const rows = (t: string) => (Array.isArray(T[t]) ? T[t] : []);
  const cols = new Map<string, Set<string>>();
  const colsOf = (t: string) => {
    if (!cols.has(t)) cols.set(t, new Set((db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map(c => c.name)));
    return cols.get(t)!;
  };
  // insert the columns both sides know about (exports from older/newer versions differ slightly)
  const insert = (t: string, r: Row): number => {
    const keys = Object.keys(r).filter(k => k !== 'id' && colsOf(t).has(k));
    const res = db.prepare(`INSERT INTO "${t}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map(k => r[k] as SQLInputValue));
    return Number(res.lastInsertRowid);
  };
  const map: Record<string, Map<number, number>> = {};
  const idMap = (t: string) => (map[t] ??= new Map());
  const to = (t: string, old: unknown) => (old === null || old === undefined ? null : idMap(t).get(Number(old)) ?? null);
  const count: Record<string, number> = {};
  const bump = (t: string) => { count[t] = (count[t] ?? 0) + 1; };

  return tx(db, () => {
    // attachments first (their new ids are needed to rewrite text and icons)
    for (const a of rows('attachments')) {
      const id = insert('attachments', { ...a, task_id: null });
      idMap('attachments').set(a.id, id);
      const bytes = files[`files/${a.id}`];
      if (bytes) { mkdirSync(join(dataDir, 'files'), { recursive: true }); writeFileSync(s.attachmentPath(dataDir, id), bytes); }
      bump('attachments');
    }
    const html = (v: unknown) => typeof v === 'string'
      ? v.replace(/\/api\/attachments\/(\d+)/g, (m, n) => (idMap('attachments').has(+n) ? `/api/attachments/${idMap('attachments').get(+n)}` : m))
      : v;
    const icon = (v: unknown) => {
      const m = typeof v === 'string' ? /^img:(\d+)$/.exec(v) : null;
      return m ? (idMap('attachments').has(+m[1]) ? `img:${idMap('attachments').get(+m[1])}` : '') : v;
    };

    // fields, types, labels: reuse same-named ones
    for (const f of rows('fields')) {
      const hit = db.prepare('SELECT * FROM fields WHERE lower(name)=lower(?) AND target=?').get(f.name, f.target) as Row | undefined;
      if (hit && hit.type === f.type) {
        const opts = [...new Set([...JSON.parse(hit.options), ...JSON.parse(f.options ?? '[]')])];
        db.prepare('UPDATE fields SET options=? WHERE id=?').run(JSON.stringify(opts), hit.id);
        idMap('fields').set(f.id, hit.id);
      } else {
        idMap('fields').set(f.id, insert('fields', hit ? { ...f, name: `${f.name} (imported)` } : f));
        bump('fields');
      }
    }
    for (const t of rows('project_types')) {
      const hit = db.prepare('SELECT id FROM project_types WHERE lower(name)=lower(?)').get(t.name) as Row | undefined;
      idMap('project_types').set(t.id, hit?.id ?? insert('project_types', t));
      if (!hit) bump('project_types');
    }
    for (const tf of rows('type_fields')) {
      const type = to('project_types', tf.type_id), field = to('fields', tf.field_id);
      if (type && field) db.prepare('INSERT OR IGNORE INTO type_fields (type_id,field_id,position) VALUES (?,?,?)').run(type, field, tf.position ?? 0);
    }
    for (const l of rows('labels')) {
      const hit = db.prepare('SELECT id FROM labels WHERE lower(title)=lower(?)').get(l.title) as Row | undefined;
      idMap('labels').set(l.id, hit?.id ?? insert('labels', l));
      if (!hit) bump('labels');
    }

    // projects, parents before children
    let pending = rows('projects');
    while (pending.length) {
      const ready = pending.filter(p => p.parent_id === null || idMap('projects').has(p.parent_id) || !rows('projects').some(x => x.id === p.parent_id));
      if (!ready.length) throw new s.HttpError(400, 'Project parent cycle in export');
      for (const p of ready) {
        idMap('projects').set(p.id, insert('projects', { ...p, parent_id: to('projects', p.parent_id), type_id: to('project_types', p.type_id), description: html(p.description), icon: icon(p.icon) }));
        bump('projects');
      }
      pending = pending.filter(p => !ready.includes(p));
    }
    for (const b of rows('buckets')) idMap('buckets').set(b.id, insert('buckets', { ...b, project_id: to('projects', b.project_id) }));
    for (const t of rows('tasks')) {
      idMap('tasks').set(t.id, insert('tasks', {
        ...t, project_id: to('projects', t.project_id), bucket_id: to('buckets', t.bucket_id),
        description: html(t.description), issue: html(t.issue), workaround: html(t.workaround), resolution: html(t.resolution),
      }));
      bump('tasks');
    }
    for (const a of rows('attachments')) db.prepare('UPDATE attachments SET task_id=? WHERE id=?').run(to('tasks', a.task_id), to('attachments', a.id));
    for (const tl of rows('task_labels')) {
      const task = to('tasks', tl.task_id), label = to('labels', tl.label_id);
      if (task && label) db.prepare('INSERT OR IGNORE INTO task_labels VALUES (?,?)').run(task, label);
    }
    for (const c of rows('comments')) { insert('comments', { ...c, task_id: to('tasks', c.task_id), body: html(c.body) }); bump('comments'); }
    for (const c of [...rows('checklist_items')].sort((a, b) => (a.parent_id === null ? 0 : 1) - (b.parent_id === null ? 0 : 1))) {
      idMap('checklist_items').set(c.id, insert('checklist_items', { ...c, task_id: to('tasks', c.task_id), parent_id: to('checklist_items', c.parent_id) }));
      bump('checklist_items');
    }
    for (const e of rows('task_events')) insert('task_events', { ...e, task_id: to('tasks', e.task_id) });
    for (const r of rows('runbooks')) { idMap('runbooks').set(r.id, insert('runbooks', {
      ...r, project_id: to('projects', r.project_id), task_id: to('tasks', r.task_id), notes: html(r.notes),
      steps: JSON.stringify((JSON.parse(String(r.steps ?? '[]')) as string[]).map(x => html(x) as string)),
    })); bump('runbooks'); }
    for (const t of rows('templates')) {
      const taken = db.prepare('SELECT 1 FROM templates WHERE kind=? AND lower(name)=lower(?)').get(t.kind, t.name);
      insert('templates', taken ? { ...t, name: `${t.name} (imported)` } : t);
      bump('templates');
    }
    // checks start fresh; channels come without their tokens (re-enter them in Settings → Integrations)
    for (const h of rows('health_checks')) {
      const project = to('projects', h.project_id);
      if (project) { insert('health_checks', { project_id: project, kind: h.kind, target: h.target, every_min: h.every_min, enabled: h.enabled }); bump('health_checks'); }
    }
    for (const n of rows('networks')) { insert('networks', n); bump('networks'); }
    for (const p of rows('ports')) {
      const project = to('projects', p.project_id);
      if (project) { insert('ports', { ...p, project_id: project }); bump('ports'); }
    }
    for (const c of rows('notify_channels')) { insert('notify_channels', { name: c.name, kind: c.kind, config: c.config, events: c.events, enabled: c.enabled }); bump('notify_channels'); }
    for (const m of rows('maintenance')) {
      idMap('maintenance').set(m.id, insert('maintenance', { ...m, project_id: to('projects', m.project_id), notes: html(m.notes), runbook_id: to('runbooks', m.runbook_id) }));
      bump('maintenance');
    }
    for (const l of rows('log_entries')) {
      idMap('log_entries').set(l.id, insert('log_entries', { ...l, project_id: to('projects', l.project_id), task_id: to('tasks', l.task_id), maintenance_id: to('maintenance', l.maintenance_id), body: html(l.body), rollback: html(l.rollback) }));
      bump('log_entries');
    }
    for (const x of rows('activity')) {
      // a waiting item's suggestion points at ids from the old database: match it again here
      const open = x.status === 'pending' || x.status === 'matched';
      insert('activity', { ...x, task_id: to('tasks', x.task_id), batch_id: null, ...(open && { status: 'pending', suggestion: null }) });
      bump('activity');
    }
    for (const b of rows('folder_bindings')) {
      const project = to('projects', b.project_id);
      if (project) { db.prepare('INSERT OR IGNORE INTO folder_bindings (folder,project_id) VALUES (?,?)').run(b.folder, project); bump('folder_bindings'); }
    }
    for (const x of rows('runbook_runs')) {
      const runbook = to('runbooks', x.runbook_id);
      if (!runbook) continue;
      insert('runbook_runs', {
        ...x, runbook_id: runbook, project_id: to('projects', x.project_id), task_id: to('tasks', x.task_id),
        maintenance_id: to('maintenance', x.maintenance_id), log_id: to('log_entries', x.log_id), notes: html(x.notes),
      });
      bump('runbook_runs');
    }
    for (const x of rows('ideas')) {
      const project = to('projects', x.project_id);
      if (!project) continue;
      insert('ideas', { ...x, project_id: project, task_id: to('tasks', x.task_id), body: html(x.body) });
      bump('ideas');
    }
    for (const pf of rows('project_fields')) {
      const p = to('projects', pf.project_id), f = to('fields', pf.field_id);
      if (p && f) db.prepare('INSERT OR IGNORE INTO project_fields (project_id,field_id,position) VALUES (?,?,?)').run(p, f, pf.position ?? 0);
    }
    for (const tf of rows('task_fields')) {
      const t = to('tasks', tf.task_id), f = to('fields', tf.field_id);
      if (t && f) db.prepare('INSERT OR IGNORE INTO task_fields (task_id,field_id,position) VALUES (?,?,?)').run(t, f, tf.position ?? 0);
    }
    // values: the entity is a project or task depending on the field; link values point at projects
    const fieldInfo = new Map(rows('fields').map(f => [f.id, f]));
    for (const v of rows('field_values')) {
      const f = fieldInfo.get(v.field_id), field = to('fields', v.field_id);
      if (!f || !field) continue;
      const entity = to(f.target === 'project' ? 'projects' : 'tasks', v.entity_id);
      const value = f.type === 'link' ? to('projects', v.value) : v.value;
      if (entity && value !== null) db.prepare('INSERT OR REPLACE INTO field_values (field_id,entity_id,value) VALUES (?,?,?)').run(field, entity, String(value));
    }
    db.prepare("INSERT INTO meta VALUES (?, ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(marker, new Date().toISOString());
    return { counts: count };
  });
}
