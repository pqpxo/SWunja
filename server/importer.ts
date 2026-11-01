import type { DatabaseSync } from 'node:sqlite';
import { unzipSync, strFromU8 } from 'fflate';
import { tx } from './db.ts';
import * as s from './services.ts';
import { SECTION_KEYS, htmlToLines, splitSections } from './sections.ts';

type V = Record<string, any>;
const date = (v: string | null | undefined) => (!v || v.startsWith('0001-') ? null : v);
const color = (hex: string | undefined) => (hex ? `#${hex.replace(/^#/, '')}` : '');

/** Imports a Vikunja (v2.x) export zip: projects, kanban buckets, tasks, labels, comments, attachments. */
export function importVikunja(db: DatabaseSync, dataDir: string, zip: Uint8Array, o: { force?: boolean } = {}) {
  if (!o.force && db.prepare("SELECT 1 FROM meta WHERE key='vikunja_imported'").get())
    throw new s.HttpError(409, 'A Vikunja export was already imported. Import again with force to add a second copy.');
  const files = unzipSync(zip);
  if (!files['data.json']) throw new s.HttpError(400, 'Not a Vikunja export: data.json missing');
  const data: V[] = JSON.parse(strFromU8(files['data.json']));
  const count = { projects: 0, tasks: 0, labels: 0, comments: 0, attachments: 0 };

  return s.actor.run('import', () => tx(db, () => {
    const projectIds = new Map<number, number>();
    const labelIds = new Map<number, number>();
    // parents first: keep looping until every project whose parent exists has been created
    let pending = [...data].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    while (pending.length) {
      const ready = pending.filter(p => !p.parent_project_id || projectIds.has(p.parent_project_id) || !data.some(x => x.id === p.parent_project_id));
      if (!ready.length) throw new s.HttpError(400, 'Project parent cycle in export');
      for (const p of ready) {
        const kanban = (p.views ?? []).find((v: V) => v.view_kind === 'kanban');
        const buckets = (p.buckets ?? []).filter((b: V) => !kanban || b.project_view_id === kanban.id)
          .sort((a: V, b: V) => (a.id === kanban?.done_bucket_id ? 1 : 0) - (b.id === kanban?.done_bucket_id ? 1 : 0) || a.position - b.position);
        const proj = s.createProject(db, {
          title: p.title, description: p.description ?? '', color: color(p.hex_color), archived: !!p.is_archived,
          parent_id: projectIds.get(p.parent_project_id) ?? null,
        }, buckets.length ? { buckets: buckets.map((b: V) => b.title) } : {});
        projectIds.set(p.id, proj.id);
        count.projects++;
        const newBuckets = s.listBuckets(db, proj.id);
        const bucketMap = new Map<number, number>(buckets.map((b: V, i: number) => [b.id, newBuckets[i].id]));
        const taskBucket = new Map<number, number>((p.task_buckets ?? []).map((tb: V) => [tb.task_id, tb.bucket_id]));
        const viewPos = new Map<number, number>((p.positions ?? []).filter((x: V) => !kanban || x.project_view_id === kanban.id).map((x: V) => [x.task_id, x.position]));

        for (const t of p.tasks ?? []) {
          for (const l of t.labels ?? []) {
            if (labelIds.has(l.id)) continue;
            const existing = s.listLabels(db).find(x => x.title.toLowerCase() === l.title.toLowerCase());
            labelIds.set(l.id, existing?.id ?? s.createLabel(db, { title: l.title, color: color(l.hex_color) }).id);
            if (!existing) count.labels++;
          }
          const task = s.createTask(db, {
            project_id: proj.id, title: t.title, done: !!t.done, priority: t.priority ?? 0, due_date: date(t.due_date),
            position: viewPos.get(t.id) ?? t.position ?? 0, labels: (t.labels ?? []).map((l: V) => labelIds.get(l.id)!),
          });
          const b = bucketMap.get(taskBucket.get(t.id) ?? -1);
          if (b && !t.done) s.updateTask(db, task.id, { bucket_id: b });
          db.prepare('UPDATE tasks SET created=?, updated=?, done_at=? WHERE id=?').run(t.created ?? task.created, t.updated ?? task.updated, t.done ? date(t.done_at) ?? task.done_at : null, task.id);
          count.tasks++;

          let html: string = t.description ?? '';
          for (const a of t.attachments ?? []) {
            const bytes = files[`files/${a.file.id}`];
            if (!bytes) continue;
            const att = s.createAttachment(db, dataDir, { name: a.file.name, mime: a.file.mime || 'application/octet-stream', data: bytes, taskId: task.id });
            count.attachments++;
            // Vikunja lazy-loads images via data-src; point them at our attachment URL instead
            html = html.replace(new RegExp(`<img([^>]*?)data-src="[^"]*/attachments/${a.id}"([^>]*?)>`, 'g'), (_m, pre, post) =>
              `<img${`${pre} ${post}`.replace(/\ssrc="[^"]*"/g, '').replace(/\s+/g, ' ').trimEnd()} src="/api/attachments/${att.id}">`);
          }
          // Issue / Workaround / Proposed Resolution / Resources headings become their own sections
          const parts = splitSections(html);
          const { resources, ...text } = parts;
          if (html !== task.description || SECTION_KEYS.some(k => parts[k])) s.updateTask(db, task.id, text);
          for (const line of htmlToLines(resources ?? '')) s.addChecklistItem(db, task.id, { text: line, list: 'resources' });
          for (const c of t.comments ?? []) {
            if (!c.comment?.trim()) continue;
            s.createComment(db, task.id, { body: c.comment, created: c.created });
            count.comments++;
          }
        }
      }
      pending = pending.filter(p => !ready.includes(p));
    }
    db.prepare("INSERT INTO meta VALUES ('vikunja_imported', ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(new Date().toISOString());
    return count;
  }));
}
