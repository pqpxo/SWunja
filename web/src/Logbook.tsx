import { useCallback, useEffect, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { api, get, type LogEntry, type LogKind } from './api';
import { useData } from './App';
import { Editor } from './Editor';
import { Menu } from './ui';

export const LOG_KINDS: [LogKind, string][] = [['change', 'Change'], ['incident', 'Incident'], ['maintenance', 'Maintenance'], ['observation', 'Observation']];
const RANGES = [['today', 'Today'], ['7d', '7 Days'], ['30d', '30 Days'], ['all', 'All']] as const;
type Range = (typeof RANGES)[number][0];

// local midnight, so "Today" means the user's day, not UTC's
function sinceFor(range: Range): string | null {
  if (range === 'all') return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === '7d') d.setDate(d.getDate() - 6);
  if (range === '30d') d.setDate(d.getDate() - 29);
  return d.toISOString();
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Plain textarea text to paragraphs, so new entries render like edited ones. */
const textToHtml = (s: string) => s.trim() ? s.trim().split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('') : '';
const localNow = () => { const d = new Date(); d.setSeconds(0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

function NewEntry({ projectId, onSaved, onCancel }: { projectId: number | null; onSaved: () => void; onCancel: () => void }) {
  const { projects } = useData();
  const [d, setD] = useState({ project_id: projectId ?? projects[0]?.id ?? 0, kind: 'change' as LogKind, at: localNow(), title: '', body: '', rollback: '' });
  const [err, setErr] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', '/log', { ...d, at: new Date(d.at).toISOString(), body: textToHtml(d.body), rollback: textToHtml(d.rollback) });
      onSaved();
    } catch (x) { setErr((x as Error).message); }
  };
  return (
    <form className="card log-form" onSubmit={save}>
      <div className="log-form-row">
        <select aria-label="Type" value={d.kind} onChange={e => setD({ ...d, kind: e.target.value as LogKind })}>
          {LOG_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {projectId === null && (
          <select aria-label="Project" value={d.project_id} onChange={e => setD({ ...d, project_id: +e.target.value })}>
            {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        )}
        <input type="datetime-local" aria-label="When" value={d.at} onChange={e => setD({ ...d, at: e.target.value })} />
      </div>
      <input className="log-title-input" autoFocus placeholder="What changed? e.g. Upgraded Docker to 29 on server1" aria-label="Title" value={d.title} onChange={e => setD({ ...d, title: e.target.value })} />
      <label className="field"><span className="field-name">What Was Done</span>
        <textarea rows={3} placeholder="Commands run, versions, files touched…" value={d.body} onChange={e => setD({ ...d, body: e.target.value })} />
      </label>
      <label className="field"><span className="field-name">Rollback Steps</span>
        <textarea rows={2} placeholder="How to undo it" value={d.rollback} onChange={e => setD({ ...d, rollback: e.target.value })} />
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row gap">
        <button className="primary" disabled={!d.title.trim()}>Save Entry</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function Entry({ e, showProject, onChange }: { e: LogEntry; showProject: boolean; onChange: () => void }) {
  const patch = async (p: object) => { await api('PATCH', `/log/${e.id}`, p); onChange(); };
  return (
    <article className={`log-entry kind-${e.kind}`}>
      <div className="log-entry-head">
        <span className={`pill log-kind kind-${e.kind}`}>{LOG_KINDS.find(k => k[0] === e.kind)?.[1]}</span>
        <input className="log-entry-title" aria-label="Entry title" defaultValue={e.title} key={e.title}
          onBlur={x => x.target.value.trim() && x.target.value !== e.title && patch({ title: x.target.value })}
          onKeyDown={x => x.key === 'Enter' && (x.target as HTMLInputElement).blur()} />
        <Menu>
          {LOG_KINDS.filter(k => k[0] !== e.kind).map(([k, l]) => <button key={k} onClick={() => patch({ kind: k })}>Mark as {l}</button>)}
          <button className="danger" onClick={async () => { if (confirm('Delete this logbook entry?')) { await api('DELETE', `/log/${e.id}`); onChange(); } }}><Trash2 size={14} />Delete Entry</button>
        </Menu>
      </div>
      <div className="log-entry-meta">
        <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>{new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
        <span>· {e.actor}</span>
        {showProject && <a href={`#/p/${e.project_id}`}>· {e.project_title}</a>}
        {e.task_id && <a href={`#/t/${e.task_id}`}>· #{e.task_id} {e.task_title}</a>}
      </div>
      <div className="log-body">
        <Editor value={e.body} placeholder="Add what was done…" onSave={html => patch({ body: html })} />
        {(e.rollback || e.kind === 'change') && (
          <div className="log-rollback">
            <span className="field-name">Rollback</span>
            <Editor value={e.rollback} placeholder="Add rollback steps…" onSave={html => patch({ rollback: html })} />
          </div>
        )}
      </div>
    </article>
  );
}

/** A project's logbook (with sub-projects), or every project's when projectId is null. */
export function LogView({ projectId }: { projectId: number | null }) {
  const [range, setRange] = useState<Range>(projectId === null ? '7d' : 'all');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: '500' });
    if (projectId !== null) p.set('project_id', String(projectId));
    const since = sinceFor(range);
    if (since) p.set('since', since);
    if (kind) p.set('kind', kind);
    if (q) p.set('q', q);
    setEntries(await get<LogEntry[]>(`/log?${p}`));
  }, [projectId, range, kind, q]);
  useEffect(() => { load(); }, [load]);

  const days: [string, LogEntry[]][] = [];
  for (const e of entries) {
    const label = dayLabel(e.at);
    if (days.at(-1)?.[0] === label) days.at(-1)![1].push(e);
    else days.push([label, [e]]);
  }
  return (
    <div className="logbook">
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map(([k, l]) => <button key={k} className={range === k ? 'on' : ''} aria-pressed={range === k} onClick={() => setRange(k)}>{l}</button>)}
        </div>
        <select aria-label="Filter by type" value={kind} onChange={e => setKind(e.target.value)}>
          <option value="">All Types</option>{LOG_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <label className="search"><Search size={15} /><input type="search" placeholder="Search the log" aria-label="Search the log" value={q} onChange={e => setQ(e.target.value)} /></label>
        <button className="primary" onClick={() => setAdding(true)}><Plus size={15} />New Entry</button>
      </div>
      {adding && <NewEntry projectId={projectId} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
      {days.length === 0 && !adding && (
        <div className="empty-state"><b>Nothing Logged {range === 'all' ? 'Yet' : 'in This Range'}</b>
          <span>Record changes, incidents, maintenance and observations here, or have Claude log them over MCP as it works.</span></div>
      )}
      {days.map(([label, list]) => (
        <section key={label} className="log-day">
          <h3 className="log-day-title">{label} <span className="count">{list.length}</span></h3>
          {list.map(e => <Entry key={e.id} e={e} showProject={projectId === null || list.some(x => x.project_id !== projectId)} onChange={load} />)}
        </section>
      ))}
    </div>
  );
}

export function LogbookPage() {
  return (
    <div className="page">
      <header className="page-header">
        <nav className="crumbs"><a href="#/">Home</a></nav>
        <h1 className="page-title">Logbook</h1>
        <p className="lede">What changed, broke, was maintained or noticed, across every project. Newest first.</p>
      </header>
      <LogView projectId={null} />
    </div>
  );
}

