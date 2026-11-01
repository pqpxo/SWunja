import { Fragment, useCallback, useEffect, useState } from 'react';
import { Archive, ArrowLeft, ArrowRight, CheckCircle2, Repeat2, Download, Inbox, Maximize2, Eye, FileText, MessageSquare, Paperclip, Pencil, Plus, RotateCcw, Trash2, X, type LucideIcon } from 'lucide-react';
import { saveAsTemplate, api, fileSize, get, PRIORITIES, SECTIONS, upload, type Attachment, type Comment, type Repeat, type Task, type TaskEvent } from './api';
import { go, useData } from './App';
import { Editor } from './Editor';
import { Checklist, LIST_TEXT, type ListKind, type ListOps } from './Checklist';
import { AddField, FieldInput } from './FieldInput';
import { InlineAdd, Menu } from './ui';
import { CloseButton, ClosedPill, ClosureBanner } from './Closure';

function Attachments({ taskId, onChange }: { taskId: number; onChange: () => void }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(0);
  const load = useCallback(() => get<Attachment[]>(`/tasks/${taskId}/attachments`).then(setItems), [taskId]);
  useEffect(() => {
    load();
    // editors upload pasted images/files as attachments too
    addEventListener('smj:attachments', load);
    return () => removeEventListener('smj:attachments', load);
  }, [load]);
  const add = async (files: File[]) => {
    setBusy(n => n + files.length);
    for (const f of files) {
      try { await upload(f, taskId); } catch (e) { alert(`Upload of ${f.name} failed: ${(e as Error).message}`); } finally { setBusy(n => n - 1); }
    }
    load();
    onChange();
  };
  const remove = async (a: Attachment) => {
    if (!confirm(`Delete ${a.name}? Any description that embeds it will show a broken image.`)) return;
    await api('DELETE', `/attachments/${a.id}`);
    load();
    onChange();
  };
  return (
    <section className={`attachments ${over ? 'over' : ''}`} aria-label="Attachments"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setOver(false); add([...e.dataTransfer.files]); }}>
      <div className="section-head">
        <h3>Attachments {items.length > 0 && <span className="count">{items.length}</span>}</h3>
        <label className="btn-like"><Paperclip size={14} />Attach Files<input type="file" multiple hidden onChange={e => { add([...(e.target.files ?? [])]); e.target.value = ''; }} /></label>
      </div>
      {items.length > 0 ? (
        <ul className="att-grid">
          {items.map(a => {
            const url = `/api/attachments/${a.id}`;
            const isImg = /^image\/(png|jpe?g|gif|webp|avif)$/.test(a.mime);
            return (
              <li key={a.id} className="att">
                <a className="att-thumb" href={url} target="_blank" rel="noreferrer" title={a.name}>
                  {isImg ? <img src={url} alt={a.name} loading="lazy" /> : <FileText size={26} />}
                </a>
                <div className="att-meta">
                  <span className="att-name" title={a.name}>{a.name}</span>
                  <span className="sub">{fileSize(a.size)}</span>
                </div>
                <div className="att-actions">
                  <a className="icon-btn" href={url} download={a.name} aria-label={`Download ${a.name}`}><Download size={14} /></a>
                  <button className="icon-btn danger" aria-label={`Delete ${a.name}`} onClick={() => remove(a)}><Trash2 size={14} /></button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : <p className="drop-hint">Drop files or photos here, or use “Attach Files”.</p>}
      {busy > 0 && <p className="hint">Uploading {busy} file{busy > 1 ? 's' : ''}…</p>}
    </section>
  );
}

const EVENT_ICON: Record<string, LucideIcon> = {
  created: Plus, viewed: Eye, updated: Pencil, moved: ArrowRight, done: CheckCircle2, reopened: RotateCcw, commented: MessageSquare, attached: Paperclip, activity: Inbox, closed: Archive, repeated: Repeat2,
};
const EVENT_TEXT: Record<string, string> = {
  created: 'Created', viewed: 'Opened', updated: 'Changed', moved: 'Moved', done: 'Marked Done', reopened: 'Reopened', closed: 'Closed', repeated: 'Repeats', commented: 'Commented', attached: 'Attached',
};

function when(iso: string) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** An accepted activity: where it came from, with the full lists folded away. */
function ActivityRecord({ detail }: { detail: string }) {
  let d: { source: string; host: string; folder: string; files: { path: string; change: string }[]; commands: { cmd: string }[]; commits: { hash: string; message: string }[] };
  try { d = JSON.parse(detail); } catch { return <b>Activity</b>; }
  return (
    <details className="ev-activity">
      <summary><b>Activity</b> from {d.source} on {d.host} <span className="muted">· {[[d.commands.length, 'command'], [d.files.length, 'file'], [d.commits.length, 'commit']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(', ')}</span></summary>
      <div className="small muted">{d.folder}</div>
      {d.files.length > 0 && <ul>{d.files.map((f, i) => <li key={i}><code>{f.change}</code> {f.path}</li>)}</ul>}
      {d.commands.length > 0 && <ul>{d.commands.map((c, i) => <li key={i}><code>{c.cmd}</code></li>)}</ul>}
      {d.commits.length > 0 && <ul>{d.commits.map((c, i) => <li key={i}><code>{c.hash}</code> {c.message}</li>)}</ul>}
    </details>
  );
}

function History({ events }: { events: TaskEvent[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 8);
  return (
    <div className="card history">
      <h3 className="card-title">History</h3>
      <ol className="events">
        {shown.map(e => {
          const I = EVENT_ICON[e.kind] ?? Pencil;
          return (
            <li key={e.id} className={`event ev-${e.kind}`}>
              <span className="ev-icon"><I size={12} /></span>
              <div className="ev-body">
                <span className="ev-text">{e.kind === 'activity' ? <ActivityRecord detail={e.detail} /> : /^(added|removed|comment|ticked|unticked) /.test(e.detail)
                  ? <b>{e.detail[0].toUpperCase() + e.detail.slice(1)}</b>
                  : <><b>{EVENT_TEXT[e.kind] ?? e.kind}</b>{e.detail && <> {e.detail}</>}</>}</span>
                <span className="ev-meta"><time dateTime={e.at} title={new Date(e.at).toLocaleString()}>{when(e.at)}</time> · {e.actor}</span>
              </div>
            </li>
          );
        })}
      </ol>
      {events.length > 8 && <button className="link-btn" onClick={() => setAll(!all)}>{all ? 'Show Less' : `Show All ${events.length}`}</button>}
    </div>
  );
}

/** The task's own lists, stored item by item through the task API. */
function TaskChecklist({ task, onTask, list }: { task: Task; onTask: (t: Task) => void; list: ListKind }) {
  const key = LIST_TEXT[list].key;
  const refresh = async () => onTask(await get<Task>(`/tasks/${task.id}`));
  const ops: ListOps = {
    add: async (text, parent_id) => onTask(await api<Task>('POST', `/tasks/${task.id}/checklist`, { text, parent_id, list })),
    edit: async (it, patch) => { await api('PATCH', `/checklist/${it.id}`, patch); await refresh(); },
    remove: async it => { await api('DELETE', `/checklist/${it.id}`); await refresh(); },
    reorder: async (ids, parent_id) => onTask(await api<Task>('PUT', `/tasks/${task.id}/checklist/order`, { ids, parent_id, list })),
    setStyle: async style => onTask(await api<Task>('PATCH', `/tasks/${task.id}`, { [`${key}_style`]: style })),
    setEnabled: async on => onTask(await api<Task>('PATCH', `/tasks/${task.id}`, { [`${key}_enabled`]: on })),
  };
  return <Checklist list={list} data={{ items: task[key], style: task[`${key}_style`], enabled: task[`${key}_enabled`] }} ops={ops} />;
}

/** A task, either as a side panel over the project (mode "panel") or as a full page in the main area (mode "page", route #/t/:id). */
export function TaskPanel({ id, onClose, onChange, mode = 'panel' }: { id: number; onClose?: () => void; onChange: () => void; mode?: 'panel' | 'page' }) {
  const { projects, labels, fields, reload: reloadData } = useData();
  const [task, setTask] = useState<Task | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [err, setErr] = useState('');

  const loadEvents = useCallback(() => get<TaskEvent[]>(`/tasks/${id}/events?limit=200`).then(setEvents), [id]);
  const load = useCallback(async () => {
    const [t, c] = await Promise.all([get<Task>(`/tasks/${id}`), get<Comment[]>(`/tasks/${id}/comments`)]);
    setTask(t);
    setComments(c);
    loadEvents();
  }, [id, loadEvents]);
  // opening a task is what clears its "new / updated" mark, in the list and the sidebar
  useEffect(() => { api('POST', `/tasks/${id}/viewed`).finally(() => { load(); onChange(); reloadData(); }); }, [id, load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    addEventListener('smj:attachments', loadEvents);
    return () => removeEventListener('smj:attachments', loadEvents);
  }, [loadEvents]);
  useEffect(() => {
    if (mode !== 'panel') return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement).closest('.ProseMirror, input, select') && onClose?.();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose, mode]);

  if (!task) return null;
  const close = () => (mode === 'page' ? go(`p/${task.project_id}`) : onClose?.());
  const save = async (patch: object) => {
    try {
      setErr('');
      setTask(await api<Task>('PATCH', `/tasks/${id}`, patch));
      onChange();
      loadEvents();
    } catch (e) {
      setErr((e as Error).message);
      throw e;
    }
  };
  const fieldsCall = async (method: 'POST' | 'DELETE', fieldId: number) => {
    setTask(await api<Task>(method, method === 'POST' ? `/tasks/${id}/fields` : `/tasks/${id}/fields/${fieldId}`, method === 'POST' ? { field: fieldId } : undefined));
    onChange();
    loadEvents();
  };
  const del = async () => {
    if (!confirm(`Delete task "${task.title}"?`)) return;
    await api('DELETE', `/tasks/${id}`);
    onChange();
    close();
  };
  const reload = async () => { setTask(await get<Task>(`/tasks/${id}`)); onChange(); loadEvents(); };
  const free = labels.filter(l => !task.labels.some(x => x.id === l.id));
  const commentsChanged = () => { load(); };

  const content = (
    <>
        <div className="panel-top">
          <span className="crumbs">
            {mode === 'page' && <button className="icon-btn" aria-label="Back" title="Back" onClick={() => (history.length > 1 ? history.back() : close())}><ArrowLeft size={16} /></button>}
            <a href={`#/p/${task.project_id}`} onClick={() => mode === 'panel' && onClose?.()}>{task.project_title}</a><span className="sep">/</span>#{task.id}
            {task.bucket_title && <span className={`pill ${task.done ? 'done-pill' : ''}`}>{task.bucket_title}</span>}
            <ClosedPill closed={task.closed} />
          </span>
          <span className="panel-actions">
            {mode === 'panel' && <button className="icon-btn" aria-label="Open as full page" title="Open as Full Page" onClick={() => go(`t/${id}`)}><Maximize2 size={16} /></button>}
            <Menu>
              <button onClick={() => saveAsTemplate('task', id, task.title)}>Save as Template…</button>
              <button className="danger" onClick={del}><Trash2 size={14} />Delete Task</button>
            </Menu>
            <button className="icon-btn" aria-label="Close" title={mode === 'page' ? 'Back to Project' : 'Close'} onClick={close}><X size={18} /></button>
          </span>
        </div>

        <div className="panel-title">
          <input type="checkbox" className="tick big" aria-label="Done" checked={task.done} onChange={() => save({ done: !task.done })} />
          <input className="title-input task" aria-label="Task title" defaultValue={task.title} key={task.title}
            onBlur={e => e.target.value.trim() && e.target.value !== task.title && save({ title: e.target.value })}
            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </div>
        {err && <p className="error panel-error">{err}</p>}
        <ClosureBanner kind="task" id={task.id} closed={task.closed} closure={task.closure} onReopen={reload} />

        {/* full width, so the side cards line up with the first section (Issue) whatever the description's length */}
        <section className="doc-section panel-description">
          <h3>Description</h3>
          <Editor value={task.description} taskId={task.id} placeholder="Add a description…" onSave={html => save({ description: html })} />
        </section>

        <div className="panel-body">
          <div className="panel-main">
            {SECTIONS.map(([key, title]) => (
              <Fragment key={key}>
                <section className={`doc-section ${task[key] ? '' : 'is-empty'}`}>
                  <h3>{title}</h3>
                  <Editor value={task[key]} taskId={task.id} placeholder={`Add ${title.toLowerCase()}…`} onSave={html => save({ [key]: html })} />
                </section>
                {key === 'resolution' && (['requirements', 'tasks', 'resources'] as const).map(list => (
                  <TaskChecklist key={list} list={list} task={task} onTask={t => { setTask(t); onChange(); loadEvents(); }} />
                ))}
              </Fragment>
            ))}

            <section className="doc-section">
              <h3>Comments {comments.length > 0 && <span className="count">{comments.length}</span>}</h3>
              <ol className="log">
                {comments.map(c => (
                  <li key={c.id} className="comment">
                    <div className="comment-head">
                      <time dateTime={c.created}>{new Date(c.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                      {c.source === 'agent' && <span className="pill agent-pill" title="Written when you accepted a match on the Activity page">Suggestion from agent</span>}
                      {c.updated !== c.created && <span>· edited</span>}
                      <button className="icon-btn" aria-label="Delete comment" onClick={async () => { if (confirm('Delete comment?')) { await api('DELETE', `/comments/${c.id}`); commentsChanged(); } }}><Trash2 size={13} /></button>
                    </div>
                    <Editor value={c.body} taskId={task.id} onSave={async body => { await api('PATCH', `/comments/${c.id}`, { body }); commentsChanged(); }} />
                  </li>
                ))}
              </ol>
              <Editor value="" taskId={task.id} startEditing clearOnSave saveLabel="Comment"
                onSave={async body => { if (body) { await api('POST', `/tasks/${id}/comments`, { body }); commentsChanged(); } }} />
            </section>
          </div>

          <aside className="panel-side">
            <div className="card">
              <div className="kv">
                <label className="field"><span className="field-name">State</span>
                  <select value={task.done ? 'done' : 'open'} onChange={e => save({ done: e.target.value === 'done' })}>
                    <option value="open">Open</option><option value="done">Done</option>
                  </select>
                  <span />
                </label>
                <label className="field"><span className="field-name">Priority</span>
                  <select value={task.priority} onChange={e => save({ priority: +e.target.value })}>
                    {PRIORITIES.map((p, i) => <option key={p} value={i}>{p}</option>)}
                  </select>
                  <span />
                </label>
                <label className="field"><span className="field-name">Due</span>
                  <input type="date" value={task.due_date?.slice(0, 10) ?? ''} onChange={e => save({ due_date: e.target.value || null })} />
                  <span />
                </label>
                <div className="field"><span className="field-name">Repeat</span>
                  <RepeatInput value={task.repeat} onChange={repeat => save({ repeat })} />
                  <span />
                </div>
                <label className="field"><span className="field-name">Project</span>
                  <select value={task.project_id} onChange={e => save({ project_id: +e.target.value })}>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                  <span />
                </label>
                {task.fields.map(f => <FieldInput key={f.id} field={f} onRemove={() => fieldsCall('DELETE', f.id)}
                  onCommit={v => api<Task>('PATCH', `/tasks/${id}`, { fields: { [f.id]: v } }).then(t => { setTask(t); onChange(); loadEvents(); })} />)}
              </div>
              <AddField onAdd={fid => fieldsCall('POST', fid)} groups={[
                { label: 'Add to This Task', fields: fields.filter(f => f.target === 'task' && !task.fields.some(x => x.id === f.id)) },
              ]} />
            </div>

            <div className="card">
              <h3 className="card-title">Labels</h3>
              <div className="pills">
                {task.labels.map(l => (
                  <span key={l.id} className="label removable" style={{ '--c': l.color || 'var(--muted)' } as React.CSSProperties}>
                    {l.title}<button aria-label={`Remove label ${l.title}`} onClick={() => save({ labels: task.labels.filter(x => x.id !== l.id).map(x => x.id) })}><X size={12} /></button>
                  </span>
                ))}
                {!task.labels.length && <span className="hint">No labels</span>}
              </div>
              <div className="label-add">
                {free.length > 0 && (
                  <select aria-label="Add label" value="" onChange={e => e.target.value && save({ labels: [...task.labels.map(l => l.id), +e.target.value] })}>
                    <option value="">Add Label…</option>
                    {free.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
                  </select>
                )}
                <InlineAdd label="New Label" placeholder="Label name, Enter"
                  onSubmit={async name => { await save({ labels: [...task.labels.map(l => l.id), name] }); reloadData(); }} />
              </div>
            </div>

            <div className="card">
              <Attachments taskId={task.id} onChange={loadEvents} />
            </div>

            <History events={events} />
            <CloseButton kind="task" id={task.id} title={task.title} closed={task.closed} onChange={reload} />
          </aside>
        </div>
    </>
  );
  if (mode === 'page') return <div className="task-page" aria-label={`Task ${task.title}`}>{content}</div>;
  return (
    <div className="panel-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose?.()}>
      <div className="panel" role="dialog" aria-label={`Task ${task.title}`}>{content}</div>
    </div>
  );
}

/** Doesn't repeat, or every N days / weeks / months / years from the due date or from when it's done. */
function RepeatInput({ value, onChange }: { value: Repeat | null; onChange: (r: Repeat | null) => void }) {
  const r = value ?? { every: 1, unit: 'week' as const, from: 'due' as const };
  return (
    <div className="repeat-input">
      {value && <input type="number" min={1} max={999} aria-label="Repeat every" defaultValue={r.every} key={r.every}
        onBlur={e => { const n = Math.floor(+e.target.value); if (n >= 1 && n <= 999 && n !== r.every) onChange({ ...r, every: n }); else e.target.value = String(r.every); }}
        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />}
      <select aria-label="Repeat unit" value={value ? r.unit : ''} onChange={e => onChange(e.target.value ? { ...r, unit: e.target.value as Repeat['unit'] } : null)}>
        <option value="">Doesn't repeat</option>
        {(['day', 'week', 'month', 'year'] as const).map(u => <option key={u} value={u}>{value ? `${u}${r.every === 1 ? '' : 's'}` : `Every ${u}`}</option>)}
      </select>
      {value && <select aria-label="Count from" value={r.from} onChange={e => onChange({ ...r, from: e.target.value as Repeat['from'] })}>
        <option value="due">from due date</option><option value="done">from when done</option>
      </select>}
    </div>
  );
}
