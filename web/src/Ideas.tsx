import { useCallback, useEffect, useState } from 'react';
import { Lightbulb, ListPlus, Pin, Trash2 } from 'lucide-react';
import { api, get, type Idea, type IdeaStatus } from './api';
import { Editor } from './Editor';
import { Menu } from './ui';

const STATUSES: [IdeaStatus, string][] = [['new', 'New'], ['maybe', 'Maybe'], ['parked', 'Parked'], ['done', 'Done'], ['rejected', 'Rejected']];
type Filter = 'active' | IdeaStatus | 'all';
const FILTERS: [Filter, string][] = [['active', 'Active'], ...STATUSES, ['all', 'All']];
const matches = (i: Idea, f: Filter) => f === 'all' || (f === 'active' ? i.status !== 'rejected' : i.status === f);

function IdeaCard({ i, showProject, onChange }: { i: Idea; showProject: boolean; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const patch = async (p: object) => { await api('PATCH', `/ideas/${i.id}`, p); onChange(); };
  const toTask = async () => { const r = await api<{ task: { id: number } }>('POST', `/ideas/${i.id}/task`); location.hash = `#/t/${r.task.id}`; };
  return (
    <article className={`log-entry idea status-${i.status}${i.pinned ? ' pinned' : ''}`}>
      <div className="log-entry-head">
        <button className={`idea-pin${i.pinned ? ' on' : ''}`} title={i.pinned ? 'Unpin' : 'Pin to top'} aria-label={i.pinned ? 'Unpin' : 'Pin'}
          aria-pressed={i.pinned} onClick={() => patch({ pinned: !i.pinned })}><Pin size={15} /></button>
        <input className="log-entry-title" aria-label="Idea" defaultValue={i.title} key={i.title}
          onBlur={x => x.target.value.trim() && x.target.value !== i.title && patch({ title: x.target.value })}
          onKeyDown={x => x.key === 'Enter' && (x.target as HTMLInputElement).blur()} />
        <select aria-label="Status" className={`idea-status status-${i.status}`} value={i.status} onChange={e => patch({ status: e.target.value })}>
          {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <Menu>
          {!i.task_id && <button onClick={toTask}><ListPlus size={14} />Make Task</button>}
          <button className="danger" onClick={async () => { if (confirm('Delete this idea?')) { await api('DELETE', `/ideas/${i.id}`); onChange(); } }}><Trash2 size={14} />Delete Idea</button>
        </Menu>
      </div>
      <div className="log-entry-meta">
        <time dateTime={i.created} title={new Date(i.created).toLocaleString()}>{new Date(i.created).toLocaleDateString()}</time>
        {showProject && <a href={`#/p/${i.project_id}`}>· {i.project_title}</a>}
        {i.task_id && <a href={`#/t/${i.task_id}`}>· Became task #{i.task_id}</a>}
        <button className="idea-notes-toggle" onClick={() => setOpen(!open)}>· {open ? 'Hide notes' : i.body ? 'Show notes' : 'Add notes'}</button>
      </div>
      {(i.status === 'rejected' || i.status === 'parked' || i.reason) && (
        <input className="idea-reason" aria-label="Reason" placeholder={i.status === 'parked' ? 'Why parked? (optional)' : 'Why not? (optional)'}
          defaultValue={i.reason} key={i.reason}
          onBlur={x => x.target.value !== i.reason && patch({ reason: x.target.value })}
          onKeyDown={x => x.key === 'Enter' && (x.target as HTMLInputElement).blur()} />
      )}
      {open && <div className="log-body"><Editor value={i.body} placeholder="Add notes…" onSave={html => patch({ body: html })} /></div>}
    </article>
  );
}

/** A project's ideas (and its sub-projects' when includeSub), pinned first then newest. */
export function IdeasView({ projectId, includeSub }: { projectId: number; includeSub: boolean }) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [filter, setFilter] = useState<Filter>('active');
  const [title, setTitle] = useState('');
  const load = useCallback(async () => {
    setIdeas(await get<Idea[]>(`/ideas?project_id=${projectId}&include_sub=${includeSub}`));
  }, [projectId, includeSub]);
  useEffect(() => { load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await api('POST', '/ideas', { project_id: projectId, title });
    setTitle('');
    if (!matches({ status: 'new' } as Idea, filter)) setFilter('active');
    load();
  };
  const shown = ideas.filter(i => matches(i, filter));
  return (
    <div className="ideas">
      <form className="quick-add" onSubmit={add}>
        <Lightbulb size={17} />
        <input placeholder="Note an idea and press Enter" aria-label="New idea" value={title} onChange={e => setTitle(e.target.value)} />
      </form>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Filter by status">
          {FILTERS.map(([k, l]) => (
            <button key={k} className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {l} <span className="count">{ideas.filter(i => matches(i, k)).length}</span>
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 && (
        <div className="empty-state"><b>{ideas.length ? 'No Ideas Here' : 'No Ideas Yet'}</b>
          <span>Dump thoughts for this project here, or ask Claude to note an idea over MCP. Turn the good ones into tasks.</span></div>
      )}
      {shown.map(i => <IdeaCard key={i.id} i={i} showProject={i.project_id !== projectId} onChange={load} />)}
    </div>
  );
}
