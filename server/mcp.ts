import type { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as s from './services.ts';
import { toHtml, toMd } from './md.ts';
import { TEXT_SECTION_KEYS, type TextSectionKey } from './sections.ts';
import { search } from './search.ts';
import * as tpl from './templates.ts';
import * as rb from './runbooks.ts';
import * as idea from './ideas.ts';
import * as cz from './closure.ts';
import * as hc from './health.ts';
import * as up from './updates.ts';
import * as net from './network.ts';
import * as pve from './proxmox.ts';
import * as unifi from './unifi.ts';
import * as act from './activity.ts';
import * as cl from './claude.ts';
import './recurring.ts';

const INSTRUCTIONS = `SWunja is a task tracker: nested projects, tasks (with kanban buckets), labels, comments and typed custom fields.
Custom fields belong to project types (e.g. Application, Electronics, Home Assistant). A project's type is inherited by its sub-projects unless overridden.
Only the fields of a project's effective type can be set on it (project-target fields) or on its tasks (task-target fields); reads list them under "fields".
Set values with the "fields" object on create/update (keyed by field name) or with field_values_set. Select fields only accept their listed options.
Descriptions, the task sections (issue, workaround, resolution = "Proposed Resolution") and comments are Markdown.
Each task also has three lists: checklist ("Tasks"), requirements (parts, domains, packages, tools) and resources (links, docs); each item can have one level of sub-items. Priority: 0 unset, 1 low, 2 medium, 3 high, 4 urgent, 5 do now.
Fields can also be added by hand: fields_attach puts a field on one task, or on a project (project fields for it, task fields for all its tasks).
Each field in a read has a source: type, parent (added to a parent project) or own (added here; removable with fields_detach).
Filters: [{field, op, value}] with op one of eq, neq, lt, gt, contains, empty, notempty.
tasks_read includes the task's recent history (who changed what, via web, api or mcp).
Logbook: when you change something on a host or app, record it with log_create (kind change | incident | maintenance | observation,
what was done, and rollback steps) on the project it concerns. log_list answers "what changed today/this week".
Maintenance: recurring jobs (patching, certificate renewals, backup-restore tests, firmware) with last done / next due; maintenance_done records one.
Infrastructure: projects can point at each other with link fields such as "Runs On" (host -> VM/LXC -> container -> app).
infra_tree shows that hierarchy and infra_dependents answers "what depends on X?". Set a link with fields: { "Runs On": "server1" } (project title or id).
Monitoring: health_list shows which services are up or down (outages are logged as incidents automatically); updates_list compares each project's Version field with its latest GitHub release.
Ideas: a per-project dump of thoughts. When the user says "note an idea for X: …", call ideas_add on project X. ideas_to_task turns one into a task.
search finds anything across projects, tasks, logbook, maintenance, runbooks and ideas.
Activity: After you finish a meaningful piece of work for the user, call activity_report. If it returns a match, ask the user whether to update that task ('I found the task … — want me to update it?'), and only call activity_accept if they say yes.`;

const id = z.number().int().describe('id');
const fieldsArg = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe('Custom field values keyed by field name (or id). null clears a value.');
const filtersArg = z.array(z.object({
  field: z.union([z.string(), z.number()]).describe('field name or id'),
  op: z.enum(['eq', 'neq', 'lt', 'gt', 'contains', 'empty', 'notempty']),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
})).describe('Custom field filters, all must match');
const iconArg = z.string().describe('Icon name (server, cpu, hard-drive, database, cloud, router, wifi, house, lightbulb, code, terminal, box, ...) or an emoji; empty for the colour dot');
const typeArg = z.union([z.string(), z.number(), z.null()]).describe('Project type name or id; null to clear (inherit from parent)');

const mdProject = (p: s.Project) => ({ ...p, description: toMd(p.description) });
const mdTask = (t: s.Task) => ({ ...t, description: toMd(t.description), ...Object.fromEntries(TEXT_SECTION_KEYS.map(k => [k, toMd(t[k])])) });
const sectionsHtml = (a: Partial<Record<TextSectionKey, string>>) =>
  Object.fromEntries(TEXT_SECTION_KEYS.filter(k => a[k] !== undefined).map(k => [k, toHtml(a[k]!)])) as Partial<Record<TextSectionKey, string>>;
const mdComment = (c: s.Comment) => ({ ...c, body: toMd(c.body) });
const html = (md: string | undefined) => (md === undefined ? undefined : toHtml(md));

function labelIds(db: DatabaseSync, labels?: (string | number)[]) {
  if (!labels?.length) return undefined;
  const all = s.listLabels(db);
  return labels.map(l => {
    const hit = all.find(x => x.id === Number(l) || x.title.toLowerCase() === String(l).toLowerCase());
    if (!hit) throw new s.HttpError(400, `Unknown label "${l}". Labels: ${all.map(x => x.title).join(', ')}`);
    return hit.id;
  });
}

export function buildMcp(db: DatabaseSync, dataDir?: string): McpServer {
  const server = new McpServer({ name: 'swunja', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  // Every tool returns JSON text; service errors come back as tool errors with their message.
  const tool = <T extends z.ZodRawShape>(name: string, description: string, shape: T, fn: (a: z.infer<z.ZodObject<T>>) => unknown) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: any) => {
      try {
        const r = await fn(args);
        return { content: [{ type: 'text' as const, text: r === undefined ? 'ok' : JSON.stringify(r) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
      }
    }) as any);

  /* projects */
  tool('projects_list', 'List projects (flat; use parent_id to rebuild the tree). Filter by custom field values, e.g. which apps run on a host.', {
    archived: z.boolean().optional().describe('default: all'),
    parent_id: z.number().int().nullable().optional().describe('only direct children of this project; null for top level'),
    search: z.string().optional(),
    filters: filtersArg.optional(),
  }, a => s.listProjects(db, { archived: a.archived, parentId: a.parent_id, q: a.search, filters: a.filters })
    .map(p => ({ id: p.id, parent_id: p.parent_id, title: p.title, archived: p.archived, type_id: p.type_id, effective_type_id: p.effective_type_id, fields: p.fields })));
  tool('projects_read', 'Get one project with its description, custom fields and kanban buckets.', { id },
    a => ({ ...mdProject(s.getProject(db, a.id)), buckets: s.listBuckets(db, a.id) }));
  tool('projects_create', 'Create a project. New projects get To-Do / Doing / Done buckets.', {
    title: z.string(), description: z.string().optional(), parent_id: z.number().int().optional(),
    type: typeArg.optional(), color: z.string().optional(), icon: iconArg.optional(), fields: fieldsArg.optional(),
  }, a => mdProject(s.createProject(db, { ...a, description: html(a.description), type_id: a.type })));
  tool('projects_update', 'Update a project. Only given keys change.', {
    id, title: z.string().optional(), description: z.string().optional(), parent_id: z.number().int().nullable().optional(),
    type: typeArg.optional(), color: z.string().optional(), icon: iconArg.optional(), archived: z.boolean().optional(), fields: fieldsArg.optional(),
    log_completed: z.boolean().nullable().optional().describe('write a logbook entry when a task here is completed; null = inherit from parent (default on)'),
  }, a => {
    const { id: pid, type, ...rest } = a;
    return mdProject(s.updateProject(db, pid, { ...rest, description: html(a.description), ...(type !== undefined ? { type_id: type } : {}) }));
  });
  tool('projects_delete', 'Delete a project and everything under it (sub-projects, tasks, comments).', { id }, a => s.deleteProject(db, a.id, dataDir));
  tool('buckets_list', 'List the kanban buckets of a project. The last bucket is the done bucket.', { project_id: id }, a => s.listBuckets(db, a.project_id));

  /* tasks */
  tool('tasks_list', 'List tasks. project_id includes sub-project tasks unless include_sub_projects is false.', {
    project_id: z.number().int().optional(), include_sub_projects: z.boolean().optional(), done: z.boolean().optional(),
    labels: z.array(z.union([z.string(), z.number()])).optional().describe('label names or ids; any match'),
    priority_min: z.number().int().optional(), due_before: z.string().optional(), due_after: z.string().optional(),
    search: z.string().optional().describe('matches title or description'), filters: filtersArg.optional(),
    limit: z.number().int().optional().describe('default 200'),
  }, a => s.listTasks(db, {
    projectId: a.project_id, includeSub: a.include_sub_projects, done: a.done, labelIds: labelIds(db, a.labels),
    priorityMin: a.priority_min, dueBefore: a.due_before, dueAfter: a.due_after, q: a.search, filters: a.filters, limit: a.limit ?? 200,
  }).map(({ description, issue, workaround, resolution, resources, checklist, requirements, ...t }) => ({
    resources_count: resources.length,
    ...t,
    checklist_progress: checklist.length ? `${checklist.filter(i => i.done).length}/${checklist.length}` : null,
    requirements_progress: requirements.length ? `${requirements.filter(i => i.done).length}/${requirements.length}` : null,
  })));
  tool('tasks_read', 'Get one task with description, sections (issue, workaround, resolution), its lists (checklist, requirements, resources), labels, custom fields, attachments, comments and recent history.', { id },
    a => (s.logView(db, a.id), {
      ...mdTask(s.getTask(db, a.id)), comments: s.listComments(db, a.id).map(mdComment),
      attachments: s.listAttachments(db, a.id).map(x => ({ ...x, url: `/api/attachments/${x.id}` })),
      history: s.listEvents(db, a.id, 20).map(({ task_id, ...e }) => e),
    }));
  tool('task_history', 'Full history of a task: created, viewed, updated (what changed), moved, done/reopened, comments and attachments, newest first.', {
    id, limit: z.number().int().optional().describe('default 100'),
  }, a => s.listEvents(db, a.id, a.limit ?? 100).map(({ task_id, ...e }) => e));
  const taskShape = {
    title: z.string(), description: z.string().optional().describe('Markdown'), done: z.boolean().optional(),
    issue: z.string().optional().describe('Markdown: what is wrong'),
    workaround: z.string().optional().describe('Markdown: temporary fix'),
    resolution: z.string().optional().describe('Markdown: the "Proposed Resolution" section'),
    checklist_style: z.enum(['bullets', 'numbered']).optional().describe('how the task checklist is shown'),
    checklist_enabled: z.boolean().optional().describe('show the Tasks checklist'),
    resources_style: z.enum(['bullets', 'numbered']).optional().describe('how the resources list is shown'),
    resources_enabled: z.boolean().optional().describe('show the Resources list'),
    requirements_style: z.enum(['bullets', 'numbered']).optional().describe('how the requirements list is shown'),
    requirements_enabled: z.boolean().optional().describe('show the Requirements list (parts, domains, packages, tools the task needs)'),
    priority: z.number().int().min(0).max(5).optional(), due_date: z.string().nullable().optional().describe('ISO date or datetime'),
    repeat: z.object({ every: z.number().int().min(1).max(999), unit: z.enum(['day', 'week', 'month', 'year']), from: z.enum(['due', 'done']) }).nullable().optional()
      .describe('repeat the task: when it is done a fresh copy appears with the next due date (from the due date, or from when it was done); null stops it'),
    labels: z.array(z.union([z.string(), z.number()])).optional().describe('label names or ids; unknown names are created'),
    fields: fieldsArg.optional(),
  };
  tool('tasks_create', 'Create a task in a project.', { project_id: id, ...taskShape, checklist: z.array(z.string()).optional().describe('checklist (sub-task) lines, in order'),
    requirements: z.array(z.string()).optional().describe('requirements lines (parts, domains, packages, tools), in order'),
    resources: z.array(z.string()).optional().describe('resource lines (links, docs, references), in order') },
    a => mdTask(s.createTask(db, { ...a, description: html(a.description), ...sectionsHtml(a) })));
  tool('tasks_update', 'Update a task. Only given keys change. labels replaces the whole set. bucket_id moves it on the kanban board (the last bucket means done), so pass either bucket_id or done, not both.', {
    id, ...taskShape, title: z.string().optional(), project_id: z.number().int().optional(), bucket_id: z.number().int().optional(),
  }, a => {
    const { id: tid, ...rest } = a;
    return mdTask(s.updateTask(db, tid, { ...rest, description: html(a.description), ...sectionsHtml(a) }));
  });
  tool('tasks_delete', 'Delete a task.', { id }, a => s.deleteTask(db, a.id, dataDir));
  const closeShape = {
    id, status: z.enum(cz.STATUSES).describe('completed and abandoned mark it done (a project is archived); on_hold keeps it open'),
    notes: z.string().optional().describe('closure notes'), reason: z.enum(cz.REASONS).optional().describe('only for abandoned'),
    lessons: z.string().optional().describe('lessons learned (completed / abandoned)'),
    replaced_by: z.object({ kind: z.enum(['task', 'project']), id: z.number().int() }).optional().describe('the task or project that replaces / follows on from it'),
    log: z.boolean().optional().describe('also write a logbook entry'),
    review_on: z.string().optional().describe('on hold only: YYYY-MM-DD when it should come back onto Home for review'),
  };
  tool('tasks_close', 'Close a task as completed, abandoned or on hold, with closure notes.', closeShape, ({ id: tid, ...d }) => mdTask(cz.closeTask(db, tid, d)));
  tool('tasks_reopen', 'Reopen a closed or on-hold task.', { id }, a => mdTask(cz.reopenTask(db, a.id)));
  tool('projects_close', 'Close a project as completed, abandoned (both archive it) or on hold, with closure notes.', {
    ...closeShape, close_tasks: z.boolean().optional().describe('also close its open tasks (including sub-projects) the same way'),
  }, ({ id: pid, ...d }) => mdProject(cz.closeProject(db, pid, d)));
  tool('projects_reopen', 'Reopen (resume) a closed or on-hold project; unarchives it.', { id }, a => mdProject(cz.reopenProject(db, a.id)));

  /* checklist (the "Tasks" list under Proposed Resolution) */
  const listArg = z.enum(['tasks', 'requirements', 'resources']).optional().describe('which list: tasks (checklist, default), requirements or resources');
  tool('checklist_add', 'Add an item to one of a task\'s lists (Tasks checklist, Requirements, Resources), or a sub-item under a top-level item (parent_id; one level deep).', {
    task_id: id, text: z.string(), done: z.boolean().optional(), parent_id: z.number().int().optional().describe('top-level item to nest under'), list: listArg,
  },
    a => s.addChecklistItem(db, a.task_id, a));
  tool('checklist_update', 'Edit or tick/untick a checklist item.', { id, text: z.string().optional(), done: z.boolean().optional() },
    a => s.updateChecklistItem(db, a.id, a));
  tool('checklist_delete', 'Delete a checklist item.', { id }, a => s.deleteChecklistItem(db, a.id));
  tool('checklist_reorder', 'Order one group in one list: the top-level items, or (with parent_id) the sub-items of one item. ids must list every item in that group.', {
    task_id: id, ids: z.array(z.number().int()), parent_id: z.number().int().optional(), list: listArg,
  }, a => s.reorderChecklist(db, a.task_id, a.ids, a.parent_id ?? null, a.list ?? 'tasks'));

  /* labels */
  tool('labels_list', 'List labels.', {}, () => s.listLabels(db));
  tool('labels_create', 'Create a label.', { title: z.string(), color: z.string().optional().describe('#rrggbb') }, a => s.createLabel(db, a));
  tool('labels_update', 'Update a label.', { id, title: z.string().optional(), color: z.string().optional() }, a => s.updateLabel(db, a.id, a));
  tool('labels_delete', 'Delete a label (removes it from tasks).', { id }, a => s.deleteLabel(db, a.id));

  /* comments */
  tool('comments_list', 'List comments on a task.', { task_id: id }, a => s.listComments(db, a.task_id).map(mdComment));
  tool('comments_create', 'Add a comment to a task.', { task_id: id, comment: z.string().describe('Markdown') },
    a => mdComment(s.createComment(db, a.task_id, { body: toHtml(a.comment) })));
  tool('comments_update', 'Edit a comment.', { id, comment: z.string() }, a => mdComment(s.updateComment(db, a.id, { body: toHtml(a.comment) })));
  tool('comments_delete', 'Delete a comment.', { id }, a => s.deleteComment(db, a.id));

  /* custom fields */
  tool('fields_list', 'List custom field definitions.', { target: z.enum(['project', 'task']).optional() }, a => s.listFields(db, a.target));
  tool('fields_create', 'Create a custom field definition. Add it to project types (add_to_types) so it shows up.', {
    name: z.string(), type: z.enum(['text', 'number', 'date', 'select', 'checkbox', 'url']), target: z.enum(['project', 'task', 'both']).describe('both creates one field for projects and one for tasks'),
    options: z.array(z.string()).optional().describe('choices for select fields'),
    add_to_types: z.array(z.union([z.string(), z.number()])).optional().describe('project type names or ids'),
  }, a => {
    const made = s.createFieldForTargets(db, a);
    for (const t of a.add_to_types ?? []) {
      const tid = s.resolveTypeId(db, t)!;
      s.updateType(db, tid, { fieldIds: [...s.getType(db, tid).fields.map(x => x.id), ...made.map(f => f.id)] });
    }
    return made.length === 1 ? made[0] : made;
  });
  tool('fields_update', 'Rename a field or replace its select options.', { id, name: z.string().optional(), options: z.array(z.string()).optional() },
    a => s.updateField(db, a.id, a));
  tool('fields_attach', 'Add a field by hand: to one task (task fields), or to a project (a project field for it, or a task field for all its tasks; sub-projects inherit both).', {
    entity: z.enum(['project', 'task']), id, field: z.union([z.string(), z.number()]).describe('field name or id'),
  }, a => {
    s.attachField(db, a.entity, a.id, a.field);
    return a.entity === 'task' ? s.getTask(db, a.id).fields : { fields: s.getProject(db, a.id).fields, task_fields: s.getProject(db, a.id).task_fields };
  });
  tool('fields_detach', 'Remove a field that was added by hand (source "own"). Its values are kept and come back if re-added.', {
    entity: z.enum(['project', 'task']), id, field_id: z.number().int(),
  }, a => s.detachField(db, a.entity, a.id, a.field_id));
  tool('fields_delete', 'Delete a field definition and all its values.', { id }, a => s.deleteField(db, a.id));
  tool('field_values_set', 'Set or clear custom field values on a project or task.', {
    entity: z.enum(['project', 'task']), id, values: fieldsArg,
  }, a => {
    s.setFieldValues(db, a.entity, a.id, a.values);
    return (a.entity === 'project' ? s.getProject(db, a.id) : s.getTask(db, a.id)).fields;
  });

  /* project types */
  tool('project_types_list', 'List project types and their fields.', {}, () => s.listTypes(db));
  const fieldRefs = z.array(z.union([z.string(), z.number()])).optional().describe('field ids, or names as "target:Name" or "Name"; replaces the whole list in order');
  const resolveFields = (refs?: (string | number)[]) => refs?.map(r => {
    if (typeof r === 'number') return r;
    const [target, name] = r.includes(':') ? r.split(':') : [undefined, r];
    const hits = s.listFields(db).filter(f => f.name.toLowerCase() === name.toLowerCase() && (!target || f.target === target));
    if (hits.length !== 1) throw new s.HttpError(400, hits.length ? `"${r}" is ambiguous; use "project:${name}" or "task:${name}"` : `Unknown field "${r}"`);
    return hits[0].id;
  });
  tool('project_types_create', 'Create a project type (a named set of custom fields).', { name: z.string(), fields: fieldRefs },
    a => s.createType(db, { name: a.name, fieldIds: resolveFields(a.fields) }));
  tool('project_types_update', 'Rename a project type or set its fields.', { id, name: z.string().optional(), fields: fieldRefs },
    a => s.updateType(db, a.id, { name: a.name, fieldIds: resolveFields(a.fields) }));
  tool('project_types_delete', 'Delete a project type. Projects using it lose their type; values are kept.', { id }, a => s.deleteType(db, a.id));

  /* logbook */
  const projectArg = z.union([z.number().int(), z.string()]).describe('project id or title');
  const kindArg = z.enum(['change', 'incident', 'maintenance', 'observation']);
  const mdLog = (e: s.LogEntry) => ({ ...e, body: toMd(e.body), rollback: toMd(e.rollback) });
  tool('log_create', 'Record what was done in a project\'s logbook (use it whenever you change something on a host or app).', {
    project: projectArg, kind: kindArg, title: z.string().describe('one line: what changed'),
    body: z.string().optional().describe('Markdown: what was done, commands run, versions'),
    rollback: z.string().optional().describe('Markdown: how to undo it'),
    at: z.string().optional().describe('when it happened (ISO date-time); default now'),
    task_id: z.number().int().optional().describe('related task'),
  }, a => mdLog(s.createLog(db, { project_id: s.resolveProjectRef(db, a.project), kind: a.kind, title: a.title, body: html(a.body), rollback: html(a.rollback), at: a.at, task_id: a.task_id })));
  tool('log_list', 'List logbook entries, newest first. With no project it covers everything: "what did I change today?".', {
    project: projectArg.optional(), include_sub_projects: z.boolean().optional(), kind: kindArg.optional(),
    since: z.string().optional().describe('ISO date or date-time, inclusive'), until: z.string().optional(),
    search: z.string().optional(), task_id: z.number().int().optional(), limit: z.number().int().optional().describe('default 100'),
  }, a => s.listLog(db, {
    projectId: a.project === undefined ? undefined : s.resolveProjectRef(db, a.project), includeSub: a.include_sub_projects, kind: a.kind,
    since: a.since, until: a.until, q: a.search, taskId: a.task_id, limit: a.limit ?? 100,
  }).map(mdLog));
  tool('log_update', 'Edit a logbook entry. Only given keys change.', {
    id, kind: kindArg.optional(), title: z.string().optional(), body: z.string().optional(), rollback: z.string().optional(), at: z.string().optional(),
  }, a => mdLog(s.updateLog(db, a.id, { kind: a.kind, title: a.title, body: html(a.body), rollback: html(a.rollback), at: a.at })));
  tool('log_delete', 'Delete a logbook entry.', { id }, a => s.deleteLog(db, a.id));

  /* ideas */
  const ideaStatus = z.enum(['new', 'maybe', 'parked', 'done', 'rejected']);
  const mdIdea = (i: idea.Idea) => ({ ...i, body: toMd(i.body) });
  tool('ideas_list', 'List a project\'s ideas (and its sub-projects\', unless include_sub_projects is false): pinned first, then newest. With no project, every idea.', {
    project: projectArg.optional(), include_sub_projects: z.boolean().optional(), status: ideaStatus.optional(),
  }, a => idea.listIdeas(db, { projectId: a.project === undefined ? undefined : s.resolveProjectRef(db, a.project), includeSub: a.include_sub_projects, status: a.status }).map(mdIdea));
  tool('ideas_add', 'Note an idea or thought on a project.', {
    project: projectArg, title: z.string().describe('the idea in one line'), notes: z.string().optional().describe('Markdown: more detail'),
    status: ideaStatus.optional().describe('default new'), pinned: z.boolean().optional(),
  }, a => mdIdea(idea.createIdea(db, { project_id: s.resolveProjectRef(db, a.project), title: a.title, body: html(a.notes), status: a.status, pinned: a.pinned })));
  tool('ideas_update', 'Edit an idea. Only given keys change. A rejected idea should get a reason (why not).', {
    id, title: z.string().optional(), notes: z.string().optional().describe('Markdown'), status: ideaStatus.optional(),
    reason: z.string().optional().describe('why it was rejected or parked'), pinned: z.boolean().optional(), project: projectArg.optional(),
  }, a => mdIdea(idea.updateIdea(db, a.id, {
    title: a.title, body: html(a.notes), status: a.status, reason: a.reason, pinned: a.pinned,
    project_id: a.project === undefined ? undefined : s.resolveProjectRef(db, a.project),
  })));
  tool('ideas_to_task', 'Turn an idea into a task in the same project (title and notes carried over); the idea is marked done and links to it.', { id },
    a => { const r = idea.ideaToTask(db, a.id); return { idea: mdIdea(r.idea), task_id: r.task.id }; });
  tool('ideas_delete', 'Delete an idea.', { id }, a => idea.deleteIdea(db, a.id));

  /* recurring maintenance */
  const unitArg = z.enum(['day', 'week', 'month', 'year']);
  const mdMaint = (m: s.Maintenance) => ({ ...m, notes: toMd(m.notes) });
  tool('maintenance_list', 'List recurring maintenance (soonest due first) with status overdue | due-soon (7 days) | ok.', {
    project: projectArg.optional(), overdue: z.boolean().optional(), due_within_days: z.number().int().optional(),
  }, a => s.listMaintenance(db, { projectId: a.project === undefined ? undefined : s.resolveProjectRef(db, a.project), overdue: a.overdue, dueWithinDays: a.due_within_days }).map(mdMaint));
  tool('maintenance_create', 'Add a recurring maintenance job, e.g. "Test backup restore" every 3 month.', {
    project: projectArg, title: z.string(), every: z.number().int(), unit: unitArg,
    next_due: z.string().optional().describe('YYYY-MM-DD; default today, or last_done + interval'), last_done: z.string().optional().describe('YYYY-MM-DD'),
    notes: z.string().optional().describe('Markdown: how to do it'), runbook_id: z.number().int().optional().describe('runbook to follow'),
  }, a => mdMaint(s.createMaintenance(db, { project_id: s.resolveProjectRef(db, a.project), title: a.title, every: a.every, unit: a.unit, next_due: a.next_due, last_done: a.last_done, notes: html(a.notes), runbook_id: a.runbook_id })));
  tool('maintenance_update', 'Edit a maintenance job. Changing every/unit re-plans next_due from last_done unless next_due is given.', {
    id, title: z.string().optional(), every: z.number().int().optional(), unit: unitArg.optional(),
    next_due: z.string().optional(), last_done: z.string().optional(), notes: z.string().optional(),
  }, a => mdMaint(s.updateMaintenance(db, a.id, { title: a.title, every: a.every, unit: a.unit, next_due: a.next_due, last_done: a.last_done, notes: html(a.notes) })));
  tool('maintenance_done', 'Mark a maintenance job done: sets last_done, moves next_due on, and writes a Maintenance logbook entry.', {
    id, date: z.string().optional().describe('YYYY-MM-DD; default today'), notes: z.string().optional().describe('Markdown: what was done / found'),
    done_steps: z.array(z.number().int()).optional().describe('if the job has a runbook: its steps done (1-based); records a run'),
  }, a => {
    const r = rb.maintenanceDone(db, a.id, { date: a.date, notes: html(a.notes), runbook_ticked: a.done_steps?.map(n => n - 1) });
    return { item: mdMaint(r.item), log: mdLog(r.log) };
  });
  tool('maintenance_delete', 'Delete a maintenance job (its logbook entries stay).', { id }, a => s.deleteMaintenance(db, a.id));

  /* search, templates, runbooks */
  tool('search', 'Search projects, tasks (incl. their lists), logbook, maintenance, runbooks and ideas at once.', { query: z.string(), limit: z.number().int().optional() },
    a => search(db, a.query, a.limit ?? 8));
  tool('templates_list', 'List task and project templates.', { kind: z.enum(['task', 'project']).optional() },
    a => tpl.listTemplates(db, a.kind).map(t => ({ id: t.id, kind: t.kind, name: t.name, created: t.created })));
  tool('template_save', 'Save an existing task or project as a template.', { kind: z.enum(['task', 'project']), from_id: id, name: z.string() },
    a => { const t = tpl.saveTemplate(db, a); return { id: t.id, kind: t.kind, name: t.name }; });
  tool('template_apply', 'Create a task (needs project) or a project (optional title, parent) from a template.', {
    template_id: id, project: projectArg.optional().describe('for task templates'), parent: projectArg.optional().describe('for project templates'), title: z.string().optional(),
  }, a => tpl.applyTemplate(db, a.template_id, {
    project_id: a.project === undefined ? undefined : s.resolveProjectRef(db, a.project),
    parent_id: a.parent === undefined ? null : s.resolveProjectRef(db, a.parent), title: a.title,
  }));
  const mdRunbook = (r: rb.Runbook) => ({ ...r, steps: r.steps.map(toMd), rollback: r.rollback.map(toMd), notes: toMd(r.notes) });
  const rbLists = (a: { checklist?: string[]; requirements?: string[]; resources?: string[] }, cur?: rb.Runbook) =>
    (a.checklist ?? a.requirements ?? a.resources) === undefined ? undefined : {
      ...(cur?.lists ?? rb.cleanLists({})),
      ...(a.checklist && { tasks: rb.listFromStrings(a.checklist) }),
      ...(a.requirements && { requirements: rb.listFromStrings(a.requirements) }),
      ...(a.resources && { resources: rb.listFromStrings(a.resources) }),
    };
  const rbArgs = {
    steps: z.array(z.string()).optional().describe('Markdown, one entry per step; replaces the whole list'),
    task: z.number().int().optional().describe('task id it is about (sets project to that task\'s project)'),
    checklist: z.array(z.string()).optional().describe('the Tasks list; replaces it'),
    requirements: z.array(z.string()).optional().describe('replaces the Requirements list'),
    resources: z.array(z.string()).optional().describe('replaces the Resources list'),
    expected: z.array(z.string()).optional().describe('what each step should show when it worked, in the same order as steps ("" for none)'),
    rollback: z.array(z.string()).optional().describe('Markdown, one entry per step to undo the procedure; replaces the whole list'),
    est_minutes: z.number().int().nullable().optional().describe('how long it usually takes, in minutes'),
    risk: z.enum(['', 'low', 'medium', 'high']).optional(),
    downtime: z.boolean().optional().describe('true if it takes something offline'),
    test_every: z.number().int().min(1).max(60).nullable().optional().describe('months between test runs; once that long passes since the last run it is flagged as due a test (null: no reminder)'),
    notes: z.string().optional().describe('Markdown'),
  };
  tool('runbooks_list', 'List runbooks (reusable step-by-step procedures). With a project: the ones that apply there (its own, its parents\', global).', {
    project: projectArg.optional(),
  }, a => rb.listRunbooks(db, { projectId: a.project === undefined ? undefined : s.resolveProjectRef(db, a.project) }).map(mdRunbook));
  tool('runbooks_read', 'Get one runbook.', { id }, a => mdRunbook(rb.getRunbook(db, a.id)));
  tool('runbooks_create', 'Create a runbook: steps, plus optional Tasks / Requirements / Resources lists. Omit project and task for one that applies to nothing in particular.', {
    title: z.string(), project: projectArg.optional(), ...rbArgs,
  }, a => mdRunbook(rb.createRunbook(db, {
    title: a.title, steps: a.steps?.map(toHtml), lists: rbLists(a), task_id: a.task ?? null, expected: a.expected, rollback: a.rollback?.map(toHtml), est_minutes: a.est_minutes, risk: a.risk, downtime: a.downtime, test_every: a.test_every,
    project_id: a.project === undefined ? null : s.resolveProjectRef(db, a.project), notes: html(a.notes),
  })));
  tool('runbooks_update', 'Edit a runbook; steps and each list replace the whole list. project: null or task: null clears it.', {
    id, title: z.string().optional(), project: projectArg.nullable().optional(), ...rbArgs, task: z.number().int().nullable().optional().describe('task id it is about; null clears it'),
  }, a => mdRunbook(rb.updateRunbook(db, a.id, {
    title: a.title, steps: a.steps?.map(toHtml), lists: rbLists(a, rb.getRunbook(db, a.id)), task_id: a.task, expected: a.expected, rollback: a.rollback?.map(toHtml), est_minutes: a.est_minutes, risk: a.risk, downtime: a.downtime, test_every: a.test_every,
    project_id: a.project === undefined ? undefined : a.project === null ? null : s.resolveProjectRef(db, a.project), notes: html(a.notes),
  })));
  const mdRun = (r: rb.Run) => ({ ...r, steps: r.steps.map(toMd), done_steps: r.ticked.map(i => i + 1), ticked: undefined, notes: toMd(r.notes) });
  tool('runbook_runs_list', 'The times a runbook was followed, newest first: which steps were done, notes, who, and the logbook entry.', { runbook_id: id },
    a => rb.listRuns(db, a.runbook_id).map(mdRun));
  tool('runbook_run_record', 'Record that a runbook was followed. Writes a logbook entry (kind change by default) on its project, or on project/task if given; project: null skips the logbook.', {
    runbook_id: id, done_steps: z.array(z.number().int()).describe('step numbers done, 1-based'), notes: z.string().optional().describe('Markdown'),
    project: projectArg.nullable().optional(), task: z.number().int().optional(), kind: z.enum(s.LOG_KINDS).optional(),
  }, a => mdRun(rb.recordRun(db, a.runbook_id, {
    ticked: a.done_steps.map(n => n - 1), notes: html(a.notes), kind: a.kind, task_id: a.task,
    project_id: a.project === undefined ? undefined : a.project === null ? null : s.resolveProjectRef(db, a.project),
  })));
  /* activity: report work, suggest the task it belongs to; writing to the task needs the user's yes */
  const plainSummary = (t: string) => t.replace(/\*\*|__|`/g, '').trim();
  tool('activity_report', 'Report work you just did (summary, files, commands) for the user’s tracker. Returns the task it most likely belongs to; ask the user before calling activity_accept.', {
    folder: z.string().describe('working directory the work happened in'),
    summary: z.string().describe('one or two plain sentences, past tense'),
    files: z.array(z.string()).optional().describe('paths edited or created'),
    commands: z.array(z.string()).optional().describe('shell commands run'),
    prompts: z.array(z.string()).optional().describe('what the user asked for'),
    host: z.string().optional().describe('machine name; default claude-code'),
  }, async a => {
    const item = act.createActivity(db, {
      source: 'mcp', host: a.host || 'claude-code', folder: a.folder, summary: plainSummary(a.summary), prompts: a.prompts,
      files: a.files?.map(path => ({ path, change: 'edited' as const, count: 1 })), commands: a.commands?.map(cmd => ({ cmd })),
    });
    const m = await cl.matchActivity(db, item.id);
    return { id: m.id, suggestion: m.suggestion, note: m.suggestion ? 'Ask the user whether to add this to the suggested task before calling activity_accept.' : m.error };
  });
  tool('activity_accept', 'Add reported activity to a task (a comment marked as from the agent plus an activity record). Only after the user agreed. task: a different task id than the suggestion.', {
    id, task: z.number().int().optional(),
  }, a => act.acceptActivity(db, a.id, a.task === undefined ? {} : { task_id: a.task }));
  tool('activity_list', 'List captured activity, newest first.', { status: z.enum(['pending', 'matched', 'accepted', 'dismissed']).optional() },
    a => act.listActivity(db, { status: a.status, limit: 50 }));
  tool('runbooks_delete', 'Delete a runbook (maintenance jobs using it keep working without it).', { id }, a => rb.deleteRunbook(db, a.id));

  /* monitoring */
  tool('health_list', 'Health checks with their status (up | down | unknown), last error and response time. Optionally for one project.', { project: projectArg.optional() },
    a => hc.listChecks(db, { projectId: a.project === undefined ? undefined : s.resolveProjectRef(db, a.project) }));
  tool('health_create', 'Add a health check: http (URL; up when it answers below 500) or tcp (host:port). Two failures in a row log an incident.', {
    project: projectArg, kind: z.enum(['http', 'tcp']), target: z.string(), every_min: z.number().int().optional().describe('default 5'),
  }, a => hc.createCheck(db, { project_id: s.resolveProjectRef(db, a.project), kind: a.kind, target: a.target, every_min: a.every_min }));
  tool('health_delete', 'Delete a health check.', { id }, a => hc.deleteCheck(db, a.id));
  tool('updates_list', 'GitHub release checks: each project with a GitHub field, its Version field, the latest release and whether an update is available.', {},
    () => up.listUpdates(db));
  tool('updates_check', 'Check GitHub for new releases now (all projects, or one).', { project: projectArg.optional() }, async a => {
    await up.checkUpdates(db, { force: true, projectId: a.project === undefined ? undefined : s.resolveProjectRef(db, a.project) });
    return up.listUpdates(db);
  });

  /* network register */
  tool('network_register', 'The IP register: subnets/VLANs with the addresses in them (from each project\'s "IP Address" field), usage and next free address; addresses outside every subnet; published ports with the host they land on; and clashes (duplicate IPs, ports used twice on one host, overlapping subnets).', {},
    () => net.networkRegister(db));
  tool('networks_create', 'Add a subnet, optionally with its VLAN and gateway.', {
    name: z.string(), cidr: z.string().describe('e.g. 192.168.20.0/24'), vlan: z.number().int().optional(), gateway: z.string().optional(), notes: z.string().optional(),
  }, a => net.createNetwork(db, a));
  tool('networks_delete', 'Delete a subnet (addresses are fields on projects and stay).', { id }, a => net.deleteNetwork(db, a.id));
  tool('ports_add', 'Record a port a project publishes. It lands on the first project up its Runs On chain that has an IP Address.', {
    project: projectArg, port: z.number().int(), protocol: z.enum(['tcp', 'udp']).optional(), notes: z.string().optional(),
  }, a => net.createPort(db, { project_id: s.resolveProjectRef(db, a.project), port: a.port, protocol: a.protocol, notes: a.notes }));
  tool('ports_delete', 'Delete a recorded port.', { id }, a => net.deletePort(db, a.id));
  tool('proxmox_import', 'Import Proxmox nodes, VMs and containers as projects (Kind, IP Address, OS, Runs On). Connection is set in Settings → Integrations. Use dry_run first to preview.', {
    connection: z.union([z.string(), z.number()]).optional().describe('which Proxmox connection (name or id); needed when there are several'),
    parent: projectArg.optional().describe('project to put the nodes under'), dry_run: z.boolean().optional(),
  }, a => s.actor.run('import', () => pve.proxmoxImport(db, { connection: a.connection, parent_id: a.parent === undefined ? null : s.resolveProjectRef(db, a.parent), dryRun: a.dry_run })));

  tool('unifi_client_add', 'Create a project for a UniFi client (key from network_register clients), under a "UniFi Network" project.', { key: z.string() },
    a => unifi.addClientProject(db, a.key));
  tool('unifi_import', 'Import from UniFi Network: networks/VLANs into the IP register, UniFi devices as projects (Kind Device, IP, Model, firmware as Version, Runs On = uplink), and client addresses onto projects with the same name (only where empty). Connection is set in Settings → Integrations. Use dry_run first.', {
    parent: projectArg.optional().describe('project to put UniFi devices under'), dry_run: z.boolean().optional(),
  }, a => s.actor.run('import', () => unifi.unifiImport(db, { parent_id: a.parent === undefined ? null : s.resolveProjectRef(db, a.parent), dryRun: a.dry_run })));

  /* infrastructure */
  tool('infra_tree', 'The infrastructure hierarchy from "Runs On" links: hosts, the VMs/LXCs/containers on them, and the apps on those.', {},
    () => s.infraTree(db));
  tool('infra_dependents', 'What depends on a project (e.g. a host): everything linked to it, by default including indirect dependents with their depth.', {
    project: projectArg, transitive: z.boolean().optional().describe('default true'),
  }, a => s.dependents(db, s.resolveProjectRef(db, a.project), a.transitive ?? true));

  return server;
}
