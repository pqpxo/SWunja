import { useCallback, useEffect, useState } from 'react';
import { Check, RefreshCw, Search, Trash2, Undo2, X } from 'lucide-react';
import { api, get, type Activity, type ActivityTarget, type ClaudeSettings, type Task } from './api';
import { useData } from './App';
import { ago } from './ui';

const notifyActivity = () => window.dispatchEvent(new Event('smj:activity'));
const SOURCE = { 'claude-code': 'Claude Code', swjtrack: 'swjtrack', mcp: 'Claude (chat)' } as const;
const confidence = (c: number) => (c >= 0.75 ? 'High' : c >= 0.45 ? 'Medium' : 'Low');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const counts = (a: Activity) => [a.commands.length && plural(a.commands.length, 'command'), a.files.length && plural(a.files.length, 'file'),
  a.commits.length && plural(a.commits.length, 'commit'), a.prompts.length && plural(a.prompts.length, 'request')].filter(Boolean).join(' · ');

/** One captured batch: what happened, where SWunja thinks it belongs, and the choices. Nothing is written to a task until Accept. */
function ActivityCard({ a, onChange }: { a: Activity; onChange: () => void }) {
  const { projects } = useData();
  const sug = a.suggestion;
  const [chosen, setChosen] = useState<ActivityTarget | null>(sug?.target ?? null);
  const [title, setTitle] = useState(sug?.task_title ?? '');
  const [mode, setMode] = useState<'pick' | 'create' | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Task[]>([]);
  const [newIn, setNewIn] = useState<number | ''>(sug?.target.project_id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const path = (projectId: number) => {
    const t: string[] = [];
    for (let p = projects.find(x => x.id === projectId); p; p = projects.find(x => x.id === p!.parent_id)) t.unshift(p.title);
    return t.join(' › ');
  };
  useEffect(() => {
    if (mode !== 'pick' || q.trim().length < 2) { setHits([]); return; }
    const h = setTimeout(() => get<Task[]>(`/tasks?q=${encodeURIComponent(q.trim())}&done=false&limit=10`).then(setHits).catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [q, mode]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(''); setBusy(true);
    try { await fn(); notifyActivity(); onChange(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const accept = (body: object) => act(() => api('POST', `/activity/${a.id}/accept`, body));
  const acceptChosen = () => accept(chosen?.kind === 'task' ? { task_id: chosen.id } : { project_id: chosen!.id, task_title: title.trim() || undefined });
  const waiting = a.status === 'pending' || a.status === 'matched';
  return (
    <section className={`card activity-card ${waiting ? '' : 'done'}`}>
      <div className="activity-head">
        <span className="pill">{SOURCE[a.source]}</span>
        <b>{a.host}</b><code className="activity-folder" title={a.folder}>{a.folder}</code>
        <span className="grow" />
        <span className="muted small" title={new Date(a.created).toLocaleString()}>{ago(a.created)}</span>
        {!waiting && <span className={`pill ${a.status === 'accepted' ? 'status-ok' : ''}`}>{a.status === 'accepted' ? 'Accepted' : 'Dismissed'}</span>}
      </div>
      <p className="activity-summary">{sug?.summary || a.summary || 'Activity recorded.'}</p>
      {counts(a) && (
        <details className="activity-lists">
          <summary className="small muted">{counts(a)}</summary>
          {a.prompts.length > 0 && <><div className="field-name">Asked</div><ul>{a.prompts.map((p, i) => <li key={i}>{p}</li>)}</ul></>}
          {a.files.length > 0 && <><div className="field-name">Files</div><ul>{a.files.map((f, i) => <li key={i}><code>{f.change}</code> {f.path}{f.count > 1 && <span className="muted"> ×{f.count}</span>}</li>)}</ul></>}
          {a.commands.length > 0 && <><div className="field-name">Commands</div><ul>{a.commands.map((c, i) => <li key={i}><code>{c.cmd}</code>{c.exit ? <span className="muted"> (exit {c.exit})</span> : null}</li>)}</ul></>}
          {a.commits.length > 0 && <><div className="field-name">Commits</div><ul>{a.commits.map((c, i) => <li key={i}><code>{c.hash}</code> {c.message}</li>)}</ul></>}
        </details>
      )}

      {a.status === 'accepted' && a.task_id && <p className="small">Added to <a href={`#/t/${a.task_id}`}>the task</a>.</p>}
      {a.status === 'dismissed' && (
        <div className="row gap wrap">
          <button disabled={busy} onClick={() => act(() => api('POST', `/activity/${a.id}/restore`))}><Undo2 size={15} />Restore</button>
          <span className="muted small">Moves it back to Waiting so you can accept it. Dismissed items are deleted after 30 days.</span>
          {err && <p className="error">{err}</p>}
        </div>
      )}
      {waiting && (
        <div className="activity-match">
          {!sug && <p className="muted small">{a.error ?? 'Not matched yet.'} <button className="link-btn" disabled={busy} onClick={() => act(() => api('POST', `/activity/${a.id}/match`))}>Match Now</button></p>}
          {chosen && (
            <div className="activity-target">
              <span className="field-name">{chosen.kind === 'task' ? 'Task' : 'Project (a new task will be created)'}</span>
              <div><span className="muted">{chosen.path}{chosen.kind === 'task' && ' › '}</span><b>{chosen.kind === 'task' ? chosen.title : ''}</b>
                {sug && chosen.id === sug.target.id && chosen.kind === sug.target.kind && <>
                  {sug.ai ? <span className="pill">{confidence(sug.confidence)} Match</span> : <span className="pill" title={sug.error ?? 'No Claude API key set'}>AI Unavailable</span>}
                  <span className="muted small"> {sug.reason}</span>
                  {!sug.ai && <> · <button className="link-btn" disabled={busy} onClick={() => act(() => api('POST', `/activity/${a.id}/match`))}>Match Again</button></>}</>}
              </div>
              {chosen.kind === 'project' && <input className="activity-title" aria-label="New task title" placeholder="New task title" value={title} onChange={e => setTitle(e.target.value)} />}
            </div>
          )}
          {sug && sug.alternatives.length > 0 && (
            <div className="activity-alts"><span className="muted small">Or:</span>
              {[sug.target, ...sug.alternatives].filter(t => !(chosen && t.id === chosen.id && t.kind === chosen.kind)).map(t => (
                <button key={`${t.kind}${t.id}`} className="chip" onClick={() => { setChosen(t); if (t.kind === 'project') setTitle(sug.task_title ?? ''); }}>
                  {t.kind === 'task' ? t.title : `${t.title} (new task)`}</button>
              ))}
            </div>
          )}
          {mode === 'pick' && (
            <div className="activity-pick">
              <label className="search"><Search size={14} /><input autoFocus placeholder="Search tasks" aria-label="Search tasks" value={q} onChange={e => setQ(e.target.value)} /></label>
              {hits.map(t => (
                <button key={t.id} className="pick-hit" onClick={() => { setChosen({ kind: 'task', id: t.id, title: t.title, project_id: t.project_id, path: path(t.project_id) }); setMode(null); }}>
                  <span className="muted">{path(t.project_id)} › </span>{t.title}</button>
              ))}
            </div>
          )}
          {mode === 'create' && (
            <form className="activity-create" onSubmit={e => { e.preventDefault(); if (newIn) accept({ project_id: newIn, task_title: title.trim() || undefined }); }}>
              <input autoFocus aria-label="Task title" placeholder="Task title" value={title} onChange={e => setTitle(e.target.value)} />
              <select aria-label="Project" value={newIn} onChange={e => setNewIn(e.target.value ? +e.target.value : '')}>
                <option value="">Choose a project…</option>
                {[...projects].filter(p => !p.archived).map(p => ({ p, label: path(p.id) })).sort((x, y) => x.label.localeCompare(y.label))
                  .map(({ p, label }) => <option key={p.id} value={p.id}>{label}</option>)}
              </select>
              <button className="primary" disabled={busy || !newIn || !title.trim()}>Create and Accept</button>
            </form>
          )}
          {err && <p className="error">{err}</p>}
          <div className="row gap wrap">
            <button className="primary" disabled={busy || !chosen || (chosen.kind === 'project' && !title.trim())} onClick={acceptChosen}><Check size={15} />Accept</button>
            <button disabled={busy} onClick={() => setMode(mode === 'pick' ? null : 'pick')}>Pick Another</button>
            <button disabled={busy} onClick={() => setMode(mode === 'create' ? null : 'create')}>Create Task</button>
            <button className="ghost" disabled={busy} onClick={() => act(() => api('POST', `/activity/${a.id}/dismiss`))}><X size={15} />Dismiss</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Folders SWunja has learned belong to a project (set when you accept); later activity there only looks inside that project. */
function FolderMemory() {
  const [rows, setRows] = useState<{ folder: string; project_id: number; project_title: string }[]>([]);
  useEffect(() => { get<typeof rows>('/folder-bindings').then(setRows); }, []);
  if (!rows.length) return null;
  return (
    <section className="card">
      <h2 className="card-title">Folder Memory</h2>
      <p className="muted small">Accepting activity remembers which project its folder belongs to, so later activity there is matched inside that project. Remove a row to let SWunja look everywhere again.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Folder</th><th>Project</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.folder}>
                <td><code>{r.folder}</code></td><td><a href={`#/p/${r.project_id}`}>{r.project_title}</a></td>
                <td className="swatch-cell"><button className="icon-btn" aria-label={`Forget ${r.folder}`} title="Forget"
                  onClick={async () => setRows(await api('DELETE', `/folder-bindings?folder=${encodeURIComponent(r.folder)}`))}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** How to connect Claude Code and Linux hosts, and when to be reminded about unsynced activity. */
function Connect() {
  const [hours, setHours] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { get<{ remind_hours: number }>('/activity/settings').then(s => setHours(String(s.remind_hours))); }, []);
  return (
    <section className="card connect-card">
      <h2 className="card-title">Connect</h2>
      <p className="muted small"><b>Linux hosts:</b> run this on the host, ideally from inside the folder you want tracked. It walks you through the setup:
        your API token (it shows a link to <a href="#/settings/tokens">Settings → API Tokens &amp; MCP</a>), which folders to track, how often to ask about syncing,
        and, if Claude Code is installed there, whether to report its sessions too.</p>
      <pre className="cmd">curl -fsSL {location.origin}/swjtrack/install | sh</pre>
      <p className="muted small">At the end it asks you to run <code>exec bash</code>, which starts tracking in that shell. Run the same command again later to add folders or change the token.</p>
      <p className="muted small"><b>Claude Code on Windows</b> (optional, reports each session when it ends): download <a href="/swjtrack" download>swjtrack</a> and, in the folder you saved it to,
        run <code>python swjtrack _setup {location.origin}</code> (it asks for an API token) and then <code>python swjtrack claude-setup</code>.
        Claude also offers to update matching tasks during a chat, without any of this.</p>
      <form className="row gap wrap" onSubmit={async e => {
        e.preventDefault(); setMsg('');
        try { const s = await api<{ remind_hours: number }>('PUT', '/activity/settings', { remind_hours: Number(hours) }); setHours(String(s.remind_hours)); setMsg('Saved'); } catch (x) { setMsg((x as Error).message); }
      }}>
        <label className="row gap small">Remind me when activity is unsynced for
          <input type="number" min={1} max={720} className="num" aria-label="Hours" value={hours} onChange={e => setHours(e.target.value)} /> hours</label>
        <button>Save</button>{msg && <span className="muted small">{msg}</span>}
      </form>
      <p className="hint">Reminders go to notification channels with <b>Activity Reminders</b> ticked (Settings → Integrations).</p>
    </section>
  );
}

export function ActivityPage() {
  const [items, setItems] = useState<Activity[]>([]);
  const [tab, setTab] = useState<'waiting' | 'accepted' | 'dismissed'>('waiting');
  const [source, setSource] = useState('');
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [claude, setClaude] = useState<ClaudeSettings | null>(null);
  const load = useCallback(() => get<Activity[]>('/activity?limit=500').then(setItems), []);
  useEffect(() => { load(); get<ClaudeSettings>('/claude').then(setClaude).catch(() => {}); }, [load]);
  const inTab = (a: Activity) => (tab === 'waiting' ? a.status === 'pending' || a.status === 'matched' : a.status === tab);
  const shown = items.filter(a => inTab(a) && (!source || a.source === source) && (!host || a.host === host));
  const waitingCount = items.filter(a => a.status === 'pending' || a.status === 'matched').length;
  const hosts = [...new Set(items.map(a => a.host))].sort();
  return (
    <div className="page">
      <header className="page-header">
        <nav className="crumbs"><a href="#/">Home</a></nav>
        <h1 className="page-title">Activity</h1>
        <p className="lede">Work captured from Claude Code and from folders tracked with <code>swjtrack</code>, matched to the task it belongs to.
          Nothing changes on a task until you accept: that adds a comment marked <b>Suggestion from agent</b> and an activity record to its history.</p>
      </header>
      {claude && !claude.has_key && <p className="hint">Matching uses word overlap only. Add a Claude API key in <a href="#/settings/integrations">Settings → Integrations</a> for sharper matches and summaries.</p>}
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Show">
          {(['waiting', 'accepted', 'dismissed'] as const).map(t => (
            <button key={t} className={tab === t ? 'on' : ''} aria-pressed={tab === t} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}{t === 'waiting' && waitingCount > 0 && <span className="count">{waitingCount}</span>}</button>
          ))}
        </div>
        <select aria-label="Source" value={source} onChange={e => setSource(e.target.value)}>
          <option value="">All Sources</option>{Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {hosts.length > 1 && <select aria-label="Host" value={host} onChange={e => setHost(e.target.value)}><option value="">All Hosts</option>{hosts.map(h => <option key={h}>{h}</option>)}</select>}
        <span className="grow" />
        <button disabled={busy} title="Match everything that is still waiting" onClick={async () => { setBusy(true); try { await api('POST', '/activity/sync'); await load(); notifyActivity(); } finally { setBusy(false); } }}>
          <RefreshCw size={14} />Sync</button>
      </div>
      {!shown.length && <div className="empty-state"><b>{tab === 'waiting' ? 'Nothing Waiting' : `Nothing ${tab[0].toUpperCase() + tab.slice(1)}`}</b>
        <span>Claude Code reports its sessions here once its hook is set up, and <code>swjtrack</code> sends activity from tracked folders on your Linux hosts.</span></div>}
      <div className="activity-list">{shown.map(a => <ActivityCard key={`${a.id}-${a.status}-${a.updated}`} a={a} onChange={load} />)}</div>
      <FolderMemory />
      <Connect />
    </div>
  );
}
