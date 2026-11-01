import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, CalendarDays, Columns3, List, ListChecks, Lightbulb, ListFilter, NotebookPen, PanelRight, Plus, Search, X } from 'lucide-react';
import { api, get, PRIORITIES, saveAsTemplate, type Template, type Bucket, type Field, type Filter, type Project, type Task } from './api';
import { go, useData } from './App';
import { Editor } from './Editor';
import { AddField, FieldInput, fieldText } from './FieldInput';
import { IconPicker, ProjectIcon } from './icons';
import { TaskPanel } from './TaskPanel';
import { LogView } from './Logbook';
import { MaintenanceView } from './Maintenance';
import { IdeasView } from './Ideas';
import { UsedBy } from './Infra';
import { MonitorSection } from './Monitor';
import { InlineAdd, Menu, Prio, snippet } from './ui';
import { CloseButton, ClosedPill, ClosureBanner, CLOSED_LABEL } from './Closure';

const store = {
  get: (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const OPS: [string, string][] = [['eq', '='], ['neq', '≠'], ['contains', 'contains'], ['gt', '>'], ['lt', '<'], ['empty', 'is empty'], ['notempty', 'is set']];

function Crumbs({ project }: { project: Project | null }) {
  const { projects } = useData();
  const chain: Project[] = [];
  for (let p = projects.find(x => x.id === project?.parent_id); p; p = projects.find(x => x.id === p!.parent_id)) chain.unshift(p);
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <a href="#/">Home</a>{chain.map(c => <span key={c.id}><span className="sep">/</span><a href={`#/p/${c.id}`}>{c.title}</a></span>)}
    </nav>
  );
}

function ProjectHeader({ project }: { project: Project }) {
  const { reload } = useData();
  const [err, setErr] = useState('');
  const save = async (patch: object) => {
    try { setErr(''); await api('PATCH', `/projects/${project.id}`, patch); await reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <header className="page-header">
      <Crumbs project={project} />
      <div className="title-row">
        <IconPicker icon={project.icon} color={project.color} onChange={save} />
        <input className="title-input" aria-label="Project title" defaultValue={project.title} key={project.title}
          onBlur={e => e.target.value.trim() && e.target.value !== project.title && save({ title: e.target.value })}
          onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        {project.closed ? <span className={`pill closed-pill ${project.closed}`}>{CLOSED_LABEL[project.closed]}</span> : project.archived && <span className="pill">Archived</span>}
      </div>
      {err && <p className="error">{err}</p>}
      <ClosureBanner kind="project" id={project.id} closed={project.closed} closure={project.closure} onReopen={reload} />
    </header>
  );
}

/** Sub-Project, the details toggle and the project menu, at the end of the toolbar row. */
function ProjectActions({ project, details, onToggleDetails }: { project: Project; details: boolean; onToggleDetails: () => void }) {
  const { projects, reload } = useData();
  const save = async (patch: object) => {
    try { await api('PATCH', `/projects/${project.id}`, patch); await reload(); } catch (e) { alert((e as Error).message); }
  };
  const addSub = async (title: string) => {
    const p = await api<Project>('POST', '/projects', { title, parent_id: project.id });
    await reload();
    go(`p/${p.id}`);
  };
  const [projectTemplates, setProjectTemplates] = useState<Template[]>([]);
  useEffect(() => { get<Template[]>('/templates?kind=project').then(setProjectTemplates); }, []);
  const fromTemplate = async (templateId: number) => {
    const p = await api<Project>('POST', `/templates/${templateId}/apply`, { parent_id: project.id });
    await reload();
    go(`p/${p.id}`);
  };
  const del = async () => {
    const n = projects.filter(p => p.parent_id === project.id).length;
    if (!confirm(`Delete "${project.title}"${n ? ` and its ${n} sub-project(s)` : ''} with all tasks? This cannot be undone.`)) return;
    await api('DELETE', `/projects/${project.id}`);
    await reload();
    go(project.parent_id ? `p/${project.parent_id}` : '');
  };
  return (
    <div className="title-actions toolbar-end">
      <InlineAdd label={<><Plus size={15} />Sub-Project</>} placeholder="Sub-project name, Enter" onSubmit={addSub} />
      <button className={`icon-btn ${details ? 'on' : ''}`} aria-pressed={details} onClick={onToggleDetails} title="Show project details"><PanelRight size={16} /></button>
      <Menu>
        <label className="menu-row">Move to
          <select aria-label="Move project" value={project.parent_id ?? ''} onChange={e => save({ parent_id: e.target.value ? +e.target.value : null })}>
            <option value="">Top Level</option>
            {projects.filter(p => p.id !== project.id).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </label>
        <button onClick={() => saveAsTemplate('project', project.id, project.title)}>Save as Template…</button>
        {projectTemplates.length > 0 && (
          <label className="menu-row">New Sub-Project from Template
            <select aria-label="New sub-project from template" value="" onChange={e => e.target.value && fromTemplate(+e.target.value)}>
              <option value="">Choose…</option>{projectTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        {!project.closed && <button onClick={() => save({ archived: !project.archived })}>{project.archived ? 'Unarchive Project' : 'Archive Project'}</button>}
        <button className="danger" onClick={del}>Delete Project…</button>
      </Menu>
    </div>
  );
}

/** Right-hand card: project type, custom field values and notes. */
function DetailsCard({ project }: { project: Project }) {
  const { types, fields, reload } = useData();
  const inherited = types.find(t => t.id === project.effective_type_id && project.type_id === null);
  const save = (patch: object) => api('PATCH', `/projects/${project.id}`, patch).then(reload);
  const attach = (field: number) => api('POST', `/projects/${project.id}/fields`, { field }).then(reload);
  const detach = (field: number) => api('DELETE', `/projects/${project.id}/fields/${field}`).then(reload);
  const typeTaskFields = types.find(t => t.id === project.effective_type_id)?.fields.filter(f => f.target === 'task') ?? [];
  const taskFieldIds = new Set([...project.task_fields, ...typeTaskFields].map(f => f.id));
  return (
    <aside className="details card" aria-label="Project details">
      <h2 className="card-title">Details</h2>
      <div className="kv">
        <label className="field">
          <span className="field-name">Type</span>
          <select value={project.type_id ?? ''} title={inherited ? `${inherited.name}, inherited from a parent project` : undefined} onChange={e => save({ type_id: e.target.value ? +e.target.value : null })}>
            <option value="">{inherited ? `↳ ${inherited.name}` : 'None'}</option>
            {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <span />
        </label>
        {project.fields.map(f => <FieldInput key={f.id} field={f} onCommit={v => save({ fields: { [f.id]: v } })} onRemove={() => detach(f.id)} />)}
        <label className="field" title="Write a Change entry to the logbook when a task here is completed">
          <span className="field-name">Log Completed</span>
          <select value={project.log_completed === null ? '' : project.log_completed ? 'on' : 'off'}
            onChange={e => save({ log_completed: e.target.value === '' ? null : e.target.value === 'on' })}>
            <option value="">{project.parent_id ? `↳ ${project.log_completed_effective ? 'On' : 'Off'}` : 'On (Default)'}</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
          <span />
        </label>
      </div>
      {project.task_fields.length > 0 && (
        <div className="task-fields">
          <span className="field-name">On Every Task</span>
          <div className="pills">
            {project.task_fields.map(f => (
              <span key={f.id} className="pill" title={f.source === 'own' ? 'Added here' : 'Added on a parent project'}>
                {f.name}{f.source === 'own' && <button aria-label={`Stop adding ${f.name} to tasks`} onClick={() => detach(f.id)}><X size={12} /></button>}
              </span>
            ))}
          </div>
        </div>
      )}
      <AddField onAdd={attach} groups={[
        { label: 'On This Project', fields: fields.filter(f => f.target === 'project' && !project.fields.some(x => x.id === f.id)) },
        { label: 'On Every Task in This Project', fields: fields.filter(f => f.target === 'task' && !taskFieldIds.has(f.id)) },
      ]} />
      <UsedBy projectId={project.id} />
      <MonitorSection projectId={project.id} />
      <h2 className="card-title">Notes</h2>
      <Editor value={project.description} onSave={html => save({ description: html })} placeholder="Links, how it's deployed, anything worth remembering…" />
      <CloseButton kind="project" id={project.id} title={project.title} closed={project.closed} onChange={reload} />
    </aside>
  );
}

function FilterChips({ value, onChange, fields }: { value: Filter[]; onChange: (f: Filter[]) => void; fields: Field[] }) {
  return (
    <>
      {value.map((f, i) => {
        const fd = fields.find(x => x.id === Number(f.field));
        return (
          <span key={i} className="filter-chip">
            <b>{fd?.name}</b> {OPS.find(o => o[0] === f.op)?.[1]} {f.value}
            <button aria-label="Remove filter" onClick={() => onChange(value.filter((_, j) => j !== i))}><X size={13} /></button>
          </span>
        );
      })}
    </>
  );
}

function Filters({ value, onChange, fields }: { value: Filter[]; onChange: (f: Filter[]) => void; fields: Field[] }) {
  const [draft, setDraft] = useState<Filter>({ field: '', op: 'eq', value: '' });
  const field = fields.find(f => String(f.id) === String(draft.field));
  if (!fields.length) return null;
  return (
    <>
      <select aria-label="Filter field" value={draft.field} onChange={e => setDraft({ ...draft, field: e.target.value, value: '' })}>
        <option value="">Field Filter</option>
        {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      {field && (
        <>
          <select aria-label="Filter operator" value={draft.op} onChange={e => setDraft({ ...draft, op: e.target.value })}>
            {OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {!['empty', 'notempty'].includes(draft.op) && (field.type === 'select' || field.type === 'checkbox'
            ? <select aria-label="Filter value" value={draft.value} onChange={e => setDraft({ ...draft, value: e.target.value })}>
                <option value="">Value</option>
                {(field.type === 'checkbox' ? ['true', 'false'] : field.options).map(o => <option key={o}>{o}</option>)}
              </select>
            : <input aria-label="Filter value" placeholder="Value" type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} value={draft.value}
                onChange={e => setDraft({ ...draft, value: e.target.value })} />)}
          <button className="primary" onClick={() => { onChange([...value, draft]); setDraft({ field: '', op: 'eq', value: '' }); }}>Apply</button>
        </>
      )}
    </>
  );
}

function Labels({ task }: { task: Task }) {
  return <>{task.labels.map(l => <span key={l.id} className="label" style={{ '--c': l.color || 'var(--muted)' } as React.CSSProperties}>{l.title}</span>)}</>;
}

function Progress({ task }: { task: Task }) {
  if (!task.checklist_enabled || !task.checklist.length) return null; // a switched-off list stays hidden everywhere
  const done = task.checklist.filter(i => i.done).length;
  return <span className={`progress ${done === task.checklist.length ? 'complete' : ''}`} title="Checklist"><ListChecks size={13} />{done}/{task.checklist.length}</span>;
}

function Due({ task }: { task: Task }) {
  if (!task.due_date) return null;
  const overdue = !task.done && new Date(task.due_date) < new Date();
  return <span className={`due ${overdue ? 'overdue' : ''}`}><CalendarDays size={13} />{new Date(task.due_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>;
}

function ListView({ tasks, showProject, onOpen, onToggle }: { tasks: Task[]; showProject: boolean; onOpen: (t: Task) => void; onToggle: (t: Task) => void }) {
  // union of custom fields across the shown tasks, in first-seen order
  const cols = useMemo(() => {
    const m = new Map<number, string>();
    tasks.forEach(t => t.fields.forEach(f => m.set(f.id, f.name)));
    return [...m];
  }, [tasks]);
  if (!tasks.length) return <div className="empty-state"><b>Nothing Here</b><span>No open tasks match. Add one above or loosen the filters.</span></div>;
  return (
    <div className="table-card">
      <table className="tasks">
        <thead>
          <tr><th className="check-col" aria-label="Done" /><th>Task</th><th className="col-labels">Labels</th><th>Priority</th><th>Due</th>
            {cols.map(([id, name]) => <th key={id} className="field-cell">{name}</th>)}</tr>
        </thead>
        <tbody>
          {tasks.map(t => (
            <tr key={t.id} className={`${t.done ? 'done' : ''} ${t.unseen ? 'unseen' : ''}`}>
              <td className="check-col"><input type="checkbox" className="tick" aria-label={`Mark "${t.title}" done`} checked={t.done} onChange={() => onToggle(t)} /></td>
              <td className="title-cell">
                <button className="link" onClick={() => onOpen(t)}>{t.title}</button><UnseenPill t={t} /><ClosedPill closed={t.closed} />
                <span className="sub">#{t.id}{showProject && <> · {t.project_title}</>} <Progress task={t} /></span>
              </td>
              <td className="col-labels"><div className="pills"><Labels task={t} /></div></td>
              <td><Prio p={t.priority} /></td>
              <td><Due task={t} /></td>
              {cols.map(([id]) => <td key={id} className="field-cell">{(() => { const f = t.fields.find(x => x.id === id); return f ? fieldText(f) : ''; })()}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KanbanView({ project, tasks, buckets, reloadAll, onOpen }: { project: Project; tasks: Task[]; buckets: Bucket[]; reloadAll: () => void; onOpen: (t: Task) => void }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  // Tasks from sub-projects land in the column with the same title as their own bucket (done ones in the last column otherwise).
  const columnOf = (t: Task) => {
    if (t.project_id === project.id && buckets.some(b => b.id === t.bucket_id)) return t.bucket_id;
    const hit = buckets.find(b => b.title.toLowerCase() === (t.bucket_title ?? '').toLowerCase());
    return (hit ?? (t.done ? buckets.at(-1) : buckets[0]))?.id;
  };
  const drop = async (bucket: Bucket, beforeTask?: Task) => {
    if (dragging === null) return;
    const col = tasks.filter(t => columnOf(t) === bucket.id && t.id !== dragging).sort((a, b) => a.position - b.position);
    let position: number;
    if (beforeTask) {
      const i = col.findIndex(t => t.id === beforeTask.id);
      position = i > 0 ? (col[i - 1].position + beforeTask.position) / 2 : beforeTask.position - 1;
    } else position = (col.at(-1)?.position ?? 0) + 1;
    setDragging(null);
    setOver(null);
    await api('POST', `/tasks/${dragging}/move`, { bucket_id: bucket.id, position });
    reloadAll();
  };
  const rename = async (b: Bucket, title: string) => {
    setRenaming(null);
    if (title.trim() && title !== b.title) { await api('PATCH', `/buckets/${b.id}`, { title }); reloadAll(); }
  };
  const remove = async (b: Bucket) => {
    if (!confirm(`Delete column "${b.title}"? Its tasks move to the ${b.id === buckets[0].id ? 'next' : 'first'} column.`)) return;
    try { await api('DELETE', `/buckets/${b.id}`); reloadAll(); } catch (e) { alert((e as Error).message); }
  };
  // the done column (last) stays last, so only the others can be reordered
  const shift = async (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= buckets.length - 1 || i === buckets.length - 1) return;
    const ids = buckets.map(b => b.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('PUT', `/projects/${project.id}/buckets/order`, { ids });
    reloadAll();
  };
  const addColumn = async (title: string) => { await api('POST', `/projects/${project.id}/buckets`, { title }); reloadAll(); };
  const addTask = async (b: Bucket, title: string) => {
    const t = await api<Task>('POST', '/tasks', { project_id: project.id, title });
    if (b.id !== t.bucket_id) await api('POST', `/tasks/${t.id}/move`, { bucket_id: b.id });
    reloadAll();
  };
  return (
    <div className="kanban">
      {buckets.map((b, i) => {
        const col = tasks.filter(t => columnOf(t) === b.id).sort((a, c) => a.position - c.position);
        const isDone = i === buckets.length - 1;
        return (
          <section key={b.id} className={`column ${over === b.id ? 'over' : ''}`}
            onDragOver={e => { e.preventDefault(); setOver(b.id); }} onDragLeave={() => setOver(null)} onDrop={() => drop(b)}>
            <header className="col-head">
              {renaming === b.id
                ? <input autoFocus className="col-rename" aria-label="Column name" defaultValue={b.title}
                    onBlur={e => rename(b, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                : <h3 className="col-title" onDoubleClick={() => setRenaming(b.id)} title="Double-click to rename">
                    {b.title}<span className="count">{col.length}</span>{isDone && <span className="pill done-pill">Done</span>}
                  </h3>}
              <Menu className="col-menu">
                <button onClick={() => setRenaming(b.id)}>Rename</button>
                {!isDone && <button disabled={i === 0} onClick={() => shift(i, -1)}>Move Left</button>}
                {!isDone && <button disabled={i >= buckets.length - 2} onClick={() => shift(i, 1)}>Move Right</button>}
                {!isDone && <button className="danger" onClick={() => remove(b)}>Delete Column</button>}
              </Menu>
            </header>
            {col.map(t => {
              const preview = snippet(t.description || t.issue, 110);
              return (
                <article key={t.id} className={`task-card ${t.done ? 'done' : ''} ${t.unseen ? 'unseen' : ''} ${dragging === t.id ? 'dragging' : ''}`} draggable
                  tabIndex={0} onKeyDown={e => e.key === 'Enter' && onOpen(t)}
                  onDragStart={() => setDragging(t.id)} onDragEnd={() => { setDragging(null); setOver(null); }}
                  onDrop={e => { e.stopPropagation(); drop(b, t); }} onClick={() => onOpen(t)}>
                  <div className="task-title">{t.title}<UnseenPill t={t} /><ClosedPill closed={t.closed} /></div>
                  {preview && <p className="preview">{preview}</p>}
                  {(t.labels.length > 0 || t.fields.some(f => f.value !== null)) && (
                    <div className="pills">
                      <Labels task={t} />
                      {t.fields.filter(f => f.value !== null).map(f => <span key={f.id} className="pill" title={f.name}>{fieldText(f)}</span>)}
                    </div>
                  )}
                  <footer className="card-foot">
                    <span className="sub">#{t.id}{t.project_id !== project.id && <> · {t.project_title}</>}</span>
                    <Progress task={t} />
                    <Due task={t} />
                    <Prio p={t.priority} />
                  </footer>
                </article>
              );
            })}
            <InlineAdd className="add-task" label={<><Plus size={15} />Add Task</>} placeholder="Task title, Enter" onSubmit={v => addTask(b, v)} />
          </section>
        );
      })}
      <InlineAdd className="add-column" label={<><Plus size={15} />Add Column</>} placeholder="Column name, Enter" onSubmit={addColumn} />
    </div>
  );
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return <button type="button" className={`toggle ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onChange(!on)}>{children}</button>;
}

/** "New" / "Updated": added or changed outside the browser (Claude, API, an accepted activity) and not opened since. */
function UnseenPill({ t }: { t: Task }) {
  if (!t.unseen) return null;
  return <span className="pill unseen-pill" title="Changed outside SWunja's pages since you last opened it">{t.unseen === 'new' ? 'New' : 'Updated'}</span>;
}

export function ProjectView({ projectId }: { projectId: number | null }) {
  const { projects, fields, labels, appearance, reload: reloadData } = useData();
  // opening the project clears its own "new / updated" mark (its tasks keep theirs until each is opened)
  useEffect(() => { if (projectId && projects.find(p => p.id === projectId)?.unseen) api('POST', `/projects/${projectId}/viewed`).then(reloadData); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const project = projects.find(p => p.id === projectId) ?? null;
  const [view, setView] = useState(() => store.get('smj:view', 'list'));
  const [details, setDetails] = useState(() => store.get('smj:details', window.innerWidth > 760 ? 'true' : 'false') === 'true');
  const [includeSub, setIncludeSub] = useState(() => store.get('smj:sub', 'true') === 'true');
  const [showDone, setShowDone] = useState(() => store.get('smj:done', 'false') === 'true');
  const [q, setQ] = useState('');
  const [labelId, setLabelId] = useState('');
  const [prio, setPrio] = useState('');
  const [filters, setFilters] = useState<Filter[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [taskTemplates, setTaskTemplates] = useState<Template[]>([]);
  useEffect(() => { get<Template[]>('/templates?kind=task').then(setTaskTemplates); }, []);
  const kanban = view === 'kanban' && project !== null;
  // project pages have five views; the task toolbar only applies to List and Board
  const current = project ? (['list', 'kanban', 'log', 'maint', 'ideas'].includes(view) ? view : 'list') : 'list';
  const taskView = current === 'list' || current === 'kanban';
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === '/' && !el.closest('input, textarea, select, [contenteditable="true"]')) { e.preventDefault(); searchRef.current?.focus(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const p = new URLSearchParams();
    if (projectId) { p.set('project_id', String(projectId)); p.set('include_sub', String(includeSub)); }
    if (!showDone && !kanban) p.set('done', 'false');
    if (q) p.set('q', q);
    if (labelId) p.set('label_ids', labelId);
    if (prio) p.set('priority_min', prio);
    if (filters.length) p.set('filters', JSON.stringify(filters));
    const [t, b] = await Promise.all([get<Task[]>(`/tasks?${p}`), projectId ? get<Bucket[]>(`/projects/${projectId}/buckets`) : Promise.resolve([])]);
    if (seq !== loadSeq.current) return; // a newer request (e.g. more typing in search) already won
    setTasks(t);
    setBuckets(b);
  }, [projectId, includeSub, showDone, q, labelId, prio, filters, kanban]);
  useEffect(() => { load(); }, [load]);

  if (projectId !== null && !project) return <div className="empty-state"><b>Project Not Found</b></div>;
  const toggle = async (t: Task) => { await api('PATCH', `/tasks/${t.id}`, { done: !t.done }); load(); };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !project) return;
    await api('POST', '/tasks', { project_id: project.id, title: newTitle });
    setNewTitle('');
    load();
  };
  // a typed title overrides the template's own
  const addFromTemplate = async (templateId: number) => {
    await api('POST', `/templates/${templateId}/apply`, { project_id: project!.id, title: newTitle.trim() || undefined });
    setNewTitle('');
    load();
  };
  const persist = (k: string, v: string) => store.set(k, v);
  const openTask = (t: Task) => (appearance.taskView === 'page' ? go(`t/${t.id}`) : setOpen(t.id));
  const hasKids = !!project && projects.some(p => p.parent_id === project.id);
  const taskFields = fields.filter(f => f.target === 'task');
  const activeFilters = (labelId ? 1 : 0) + (prio ? 1 : 0) + filters.length;

  return (
    <div className="page">
      {project ? <ProjectHeader project={project} /> : (
        <header className="page-header">
          <Crumbs project={null} />
          <h1 className="page-title">All Tasks</h1>
          <p className="lede">Everything open across every project.</p>
        </header>
      )}
      <div className="toolbar">
            {project && (
              <div className="seg" role="tablist">
                {([['list', 'List', List], ['ideas', 'Ideas', Lightbulb], ['kanban', 'Board', Columns3], ['log', 'Log', NotebookPen], ['maint', 'Maintenance', CalendarClock]] as const).map(([v, label, Icon]) => (
                  <button key={v} role="tab" aria-selected={current === v} className={current === v ? 'on' : ''} onClick={() => { setView(v); persist('smj:view', v); }}><Icon size={15} />{label}</button>
                ))}
              </div>
            )}
            {current === 'ideas' && hasKids && <Toggle on={includeSub} onChange={v => { setIncludeSub(v); persist('smj:sub', String(v)); }}>Sub-Projects</Toggle>}
            {taskView && <>
            <label className="search"><Search size={15} /><input ref={searchRef} type="search" placeholder="Search tasks" aria-label="Search tasks" value={q} onChange={e => setQ(e.target.value)} /><kbd>/</kbd></label>
            {hasKids && <Toggle on={includeSub} onChange={v => { setIncludeSub(v); persist('smj:sub', String(v)); }}>Sub-Projects</Toggle>}
            {!kanban && <Toggle on={showDone} onChange={v => { setShowDone(v); persist('smj:done', String(v)); }}>Show Done</Toggle>}
            <Menu className="filter-menu" ariaLabel="Filter tasks" label={<><ListFilter size={15} />Filter{activeFilters > 0 && <span className="count">{activeFilters}</span>}</>}>
              <label className="menu-row">Label
                <select aria-label="Filter by label" value={labelId} onChange={e => setLabelId(e.target.value)}>
                  <option value="">All Labels</option>{labels.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
                </select>
              </label>
              <label className="menu-row">Priority
                <select aria-label="Minimum priority" value={prio} onChange={e => setPrio(e.target.value)}>
                  <option value="">Any Priority</option>{PRIORITIES.slice(1).map((p, i) => <option key={p} value={i + 1}>{p} or Higher</option>)}
                </select>
              </label>
              {taskFields.length > 0 && <div className="menu-row">Custom Field<div className="filter-builder"><Filters value={filters} onChange={setFilters} fields={taskFields} /></div></div>}
              {activeFilters > 0 && <button onClick={() => { setLabelId(''); setPrio(''); setFilters([]); }}>Clear All Filters</button>}
            </Menu>
            {labelId && <span className="filter-chip"><b>Label</b> {labels.find(l => String(l.id) === labelId)?.title}<button aria-label="Remove label filter" onClick={() => setLabelId('')}><X size={13} /></button></span>}
            {prio && <span className="filter-chip"><b>Priority</b> ≥ {PRIORITIES[+prio]}<button aria-label="Remove priority filter" onClick={() => setPrio('')}><X size={13} /></button></span>}
            <FilterChips value={filters} onChange={setFilters} fields={taskFields} />
            </>}
            {project && <ProjectActions project={project} details={details} onToggleDetails={() => { setDetails(!details); persist('smj:details', String(!details)); }} />}
      </div>
      <div className={`project-layout ${project && details ? 'with-details' : ''}`}>
        <div className="project-main">
          {project && current === 'list' && (
            <form className="quick-add" onSubmit={create}>
              <Plus size={16} />
              <input placeholder={`Add a task to ${project.title}`} aria-label="New task title" value={newTitle} onChange={e => setNewTitle(e.target.value)} />
              <kbd>Enter</kbd>
              {taskTemplates.length > 0 && (
                <select className="from-template" aria-label="Add a task from a template" value="" onChange={e => e.target.value && addFromTemplate(+e.target.value)}>
                  <option value="">From Template…</option>{taskTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
            </form>
          )}
          {current === 'log' ? <LogView projectId={project!.id} />
            : current === 'maint' ? <MaintenanceView projectId={project!.id} />
            : current === 'ideas' ? <IdeasView projectId={project!.id} includeSub={includeSub} />
            : kanban ? <KanbanView project={project!} tasks={tasks} buckets={buckets} reloadAll={load} onOpen={openTask} />
            : <ListView tasks={[...tasks].sort((a, b) => Number(a.done) - Number(b.done) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }))} showProject={!project || (includeSub && tasks.some(t => t.project_id !== project.id))} onOpen={openTask} onToggle={toggle} />}
        </div>
        {project && details && <DetailsCard project={project} />}
      </div>
      {open !== null && <TaskPanel id={open} onClose={() => setOpen(null)} onChange={load} />}
    </div>
  );
}

/** All projects as a table, filterable by type and project field values ("which apps run on server1?"). */
export function ProjectsPage() {
  const { types, fields } = useData();
  const [typeId, setTypeId] = useState('');
  const [filters, setFilters] = useState<Filter[]>([]);
  const [rows, setRows] = useState<Project[]>([]);
  useEffect(() => {
    get<Project[]>(`/projects${filters.length ? `?filters=${encodeURIComponent(JSON.stringify(filters))}` : ''}`).then(setRows);
  }, [filters]);
  const shown = rows.filter(p => !typeId || p.effective_type_id === +typeId);
  const cols = [...new Map(shown.flatMap(p => p.fields.map(f => [f.id, f.name] as const))).entries()];
  const parentOf = (p: Project) => rows.find(x => x.id === p.parent_id)?.title ?? '';
  return (
    <div className="page">
      <header className="page-header">
        <Crumbs project={null} />
        <h1 className="page-title">Projects by Field</h1>
        <p className="lede">Every project with its custom fields. Filter by type or by a value, e.g. Host = server1.</p>
      </header>
      <div className="toolbar">
        <select aria-label="Filter by type" value={typeId} onChange={e => setTypeId(e.target.value)}>
          <option value="">All Types</option>{types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <Filters value={filters} onChange={setFilters} fields={fields.filter(f => f.target === 'project')} />
        <FilterChips value={filters} onChange={setFilters} fields={fields.filter(f => f.target === 'project')} />
      </div>
      {shown.length ? (
        <div className="table-card">
          <table className="tasks">
            <thead><tr><th>Project</th><th>Parent</th><th>Type</th>{cols.map(([id, n]) => <th key={id}>{n}</th>)}</tr></thead>
            <tbody>
              {shown.map(p => (
                <tr key={p.id} className={p.archived ? 'done' : ''}>
                  <td><a className="proj-link" href={`#/p/${p.id}`}><ProjectIcon icon={p.icon} color={p.color} />{p.title}</a></td>
                  <td className="muted">{parentOf(p)}</td>
                  <td>{types.find(t => t.id === p.effective_type_id)?.name ?? ''}</td>
                  {cols.map(([id]) => {
                    const f = p.fields.find(x => x.id === id);
                    return <td key={id} className="field-cell">{f?.type === 'url' && f.value ? <a href={f.value} target="_blank" rel="noreferrer">{f.value.replace(/^https?:\/\//, '')}</a> : f ? fieldText(f) : ''}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="empty-state"><b>No Match</b><span>No project has those values.</span></div>}
    </div>
  );
}
