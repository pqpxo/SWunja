import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Play, Plus, Square, Trash2, X } from 'lucide-react';
import { api, get, type LogKind, type Project, type Runbook, type RunbookList, type RunbookRun, type Task } from './api';
import { LOG_KINDS } from './Logbook';
import { go, useData } from './App';
import { Checklist, type ListKind, type ListOps } from './Checklist';
import { Editor } from './Editor';
import { Menu, ago, snippet } from './ui';

const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });

/** The project and its parents, top first. */
function chainOf(projects: Project[], id: number | null) {
  const chain: Project[] = [];
  for (let p = projects.find(x => x.id === id); p; p = projects.find(x => x.id === p!.parent_id)) chain.unshift(p);
  return chain;
}

export function appliesLabel(projects: Project[], r: Runbook) {
  const path = chainOf(projects, r.project_id).map(p => p.title);
  return [...path, ...(r.task_title ? [r.task_title] : [])].join(' › ') || 'N/A';
}

/** Project, then a sub-project at each level that has them, then one of that project's tasks; N/A stops at the level above. */
function AppliesTo({ projectId, taskId, onChange, label = 'Applies To' }: {
  projectId: number | null; taskId: number | null; onChange: (projectId: number | null, taskId: number | null) => void; label?: string;
}) {
  const { projects } = useData();
  const chain = chainOf(projects, projectId);
  const kids = (parent: number | null) => projects.filter(p => p.parent_id === parent && (!p.archived || chain.includes(p))).sort(byTitle);
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    if (projectId) get<Task[]>(`/tasks?project_id=${projectId}&include_sub=false`).then(ts => setTasks(ts.sort(byTitle)));
    else setTasks([]);
  }, [projectId]);
  const levels = [null, ...chain.map(p => p.id)];
  return (
    <div className="applies-to">
      {levels.map((parent, i) => {
        const opts = kids(parent);
        if (i > 0 && !opts.length) return null;
        return (
          <label key={i} className="field"><span className="field-name">{i === 0 ? label : 'Sub-Project'}</span>
            <select value={chain[i]?.id ?? ''} onChange={e => onChange(e.target.value ? +e.target.value : parent, null)}>
              <option value="">N/A</option>
              {opts.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </label>
        );
      })}
      {projectId !== null && tasks.length > 0 && (
        <label className="field"><span className="field-name">Task</span>
          <select value={taskId ?? ''} onChange={e => onChange(projectId, e.target.value ? +e.target.value : null)}>
            <option value="">N/A</option>
            {tasks.map(t => <option key={t.id} value={t.id}>{t.title}{t.done ? ' (done)' : ''}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

/** Name and what it applies to; the steps and lists are edited in place on the open runbook. */
function RunbookForm({ item, onDone, onCancel }: { item?: Runbook; onDone: (r: Runbook) => void; onCancel: () => void }) {
  const [d, setD] = useState({
    title: item?.title ?? '', project_id: item?.project_id ?? null, task_id: item?.task_id ?? null,
    est_minutes: item?.est_minutes?.toString() ?? '', risk: item?.risk ?? '', downtime: item?.downtime ?? false,
    test_every: item?.test_every ?? null,
  });
  const [err, setErr] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { ...d, est_minutes: d.est_minutes.trim() ? Number(d.est_minutes) : null };
    try { onDone(await api<Runbook>(item ? 'PATCH' : 'POST', item ? `/runbooks/${item.id}` : '/runbooks', body)); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <form className="card runbook-form" onSubmit={save}>
      <input autoFocus placeholder="Runbook name, e.g. Restore Proxmox VM from Backup" aria-label="Title" value={d.title} onChange={e => setD({ ...d, title: e.target.value })} />
      <AppliesTo projectId={d.project_id} taskId={d.task_id} onChange={(project_id, task_id) => setD({ ...d, project_id, task_id })} />
      <div className="applies-to">
        <label className="field"><span className="field-name">Usual Time (Minutes)</span>
          <input type="number" min={1} max={10080} value={d.est_minutes} placeholder="e.g. 20" onChange={e => setD({ ...d, est_minutes: e.target.value })} /></label>
        <label className="field"><span className="field-name">Risk</span>
          <select value={d.risk} onChange={e => setD({ ...d, risk: e.target.value as Runbook['risk'] })}>
            <option value="">Not set</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select></label>
        <label className="field"><span className="field-name">Test Every</span>
          <select value={d.test_every ?? ''} onChange={e => setD({ ...d, test_every: e.target.value ? +e.target.value : null })}>
            <option value="">No reminder</option>{[...new Set([1, 3, 6, 12, 24, d.test_every ?? 1])].sort((a, b) => a - b).map(m => <option key={m} value={m}>{m === 1 ? 'Month' : `${m} Months`}</option>)}
          </select></label>
        <label className="check rb-downtime"><input type="checkbox" checked={d.downtime} onChange={e => setD({ ...d, downtime: e.target.checked })} /> Needs downtime</label>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="row gap">
        <button className="primary" disabled={!d.title.trim()}>{item ? 'Save' : 'Add Runbook'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** A step's "expected result", edited in place (saved when you leave the box). */
function ExpectedInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  return (
    <label className="rb-expected-row"><b>Expected</b>
      <input key={value} className="rb-expected-input" defaultValue={value} placeholder="(optional) what you should see, e.g. all containers show healthy" aria-label="Expected result"
        onBlur={e => { if (e.target.value.trim() !== value) onSave(e.target.value.trim()); }} onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} />
    </label>
  );
}

/**
 * Steps as rich text: tick to follow along (saved only during a run); with onChange they can be edited, added, moved and deleted.
 * With `expected`, each step also has an expected result (kept in line with the steps when they move or go).
 */
export function RunbookSteps({ steps, expected, onChange, ticks, onTick, title = 'Steps', addLabel = 'Add Step' }: {
  steps: string[]; expected?: string[]; onChange?: (steps: string[], expected: string[]) => Promise<unknown>;
  ticks?: number[]; onTick?: (ticked: number[]) => void; title?: string; addLabel?: string;
}) {
  const [own, setOwn] = useState<Set<number>>(new Set());
  const ticked = ticks ? new Set(ticks) : own;
  const setTicked = (n: Set<number>) => (onTick ? onTick([...n]) : setOwn(n));
  const [adding, setAdding] = useState(false);
  const ex = steps.map((_, i) => expected?.[i] ?? '');
  const tick = (i: number) => { const n = new Set(ticked); if (n.has(i)) n.delete(i); else n.add(i); setTicked(n); };
  const set = (i: number, html: string) => (html
    ? onChange!(steps.map((x, j) => (j === i ? html : x)), ex)
    : onChange!(steps.filter((_, j) => j !== i), ex.filter((_, j) => j !== i)));
  const move = (i: number, by: number) => {
    const n = [...steps], e = [...ex];
    [n[i], n[i + by]] = [n[i + by], n[i]];
    [e[i], e[i + by]] = [e[i + by], e[i]];
    if (!ticks) setTicked(new Set());
    onChange!(n, e);
  };
  return (
    <section className="doc-section rb-steps" aria-label={title}>
      {onChange && <div className="section-head"><h3>{title} {steps.length > 0 && <span className="count">{ticked.size}/{steps.length}</span>}</h3></div>}
      {steps.length > 0 && (
        <ol className="rb-step-list">
          {steps.map((x, i) => (
            <li key={i} className={ticked.has(i) ? 'done' : ''}>
              <span className="rb-num">{i + 1}</span>
              <input type="checkbox" className="tick" aria-label={`Done: ${title.toLowerCase()} ${i + 1}`} checked={ticked.has(i)} onChange={() => tick(i)} />
              <div className="rb-step-body">
                <Editor value={x} readOnly={!onChange} placeholder="Empty step" onSave={html => set(i, html)} />
                {expected && (onChange
                  ? <ExpectedInput value={ex[i]} onSave={v => onChange(steps, ex.map((y, j) => (j === i ? v : y)))} />
                  : ex[i] && <p className="rb-expected"><b>Expected:</b> {ex[i]}</p>)}
              </div>
              {onChange && (
                <span className="ck-actions">
                  <button className="icon-btn" aria-label={`Move ${i + 1} up`} title="Move Up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                  <button className="icon-btn" aria-label={`Move ${i + 1} down`} title="Move Down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                  <button className="icon-btn" aria-label={`Delete ${i + 1}`} title="Delete" onClick={() => confirm(`Delete ${title.toLowerCase()} step ${i + 1}?`) && set(i, '')}><X size={14} /></button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {onChange && (adding
        ? <Editor value="" startEditing clearOnSave saveLabel={addLabel} placeholder="" onCancel={() => setAdding(false)} onSave={async html => { if (html) await onChange([...steps, html], [...ex, '']); }} />
        : <button className="add-row" onClick={() => setAdding(true)}><Plus size={14} />{addLabel}</button>)}
    </section>
  );
}

const fmtMinutes = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
/** "~20 min", "High Risk", "Needs Downtime" pills for a runbook's card and page. */
export function RunbookMeta({ r }: { r: Runbook }) {
  return <>
    {r.est_minutes != null && <span className="pill" title="Usual time">~{fmtMinutes(r.est_minutes)}</span>}
    {r.risk && <span className={`pill risk-${r.risk}`}>{r.risk[0].toUpperCase() + r.risk.slice(1)} Risk</span>}
    {r.downtime && <span className="pill risk-high">Needs Downtime</span>}
    {r.test_due && r.test_due <= new Date().toISOString().slice(0, 10) && <span className="pill risk-high" title={`Set to be tested every ${r.test_every} month${r.test_every === 1 ? '' : 's'}`}>Test Due</span>}
  </>;
}

/** A runbook's Tasks / Requirements / Resources list, saved as a whole with the runbook. */
function runbookOps(r: Runbook, list: ListKind, save: (lists: Runbook['lists']) => Promise<unknown>): ListOps {
  const l = r.lists[list];
  const put = (patch: Partial<RunbookList>) => save({ ...r.lists, [list]: { ...l, ...patch } });
  return {
    add: (text, parent_id) => put({ items: [...l.items, { id: Math.max(0, ...l.items.map(i => i.id)) + 1, parent_id, text, done: false, position: l.items.length }] }),
    edit: (it, p) => put({ items: l.items.map(i => (i.id === it.id ? { ...i, ...p } : i)) }),
    remove: it => put({ items: l.items.filter(i => i.id !== it.id && i.parent_id !== it.id) }),
    // the moved group gets positions 0..n; a stable sort keeps every other group's order
    reorder: ids => put({ items: l.items.map(i => (ids.includes(i.id) ? { ...i, position: ids.indexOf(i.id) } : i)).sort((a, b) => a.position - b.position) }),
    setStyle: style => put({ style }),
    setEnabled: enabled => put({ enabled }),
  };
}

const took = (r: RunbookRun) => {
  const m = Math.round((Date.parse(r.finished!) - Date.parse(r.started)) / 60_000);
  return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** Ending a run: where it goes in the logbook (N/A: nowhere), what kind of entry, and notes. */
function FinishRun({ rb, run, onDone, onCancel }: { rb: Runbook; run: RunbookRun; onDone: () => void; onCancel: () => void }) {
  const [to, setTo] = useState({ project_id: run.project_id, task_id: run.task_id });
  const [kind, setKind] = useState<LogKind>('change');
  const [err, setErr] = useState('');
  const finish = async (notes: string) => {
    try { await api('POST', `/runbook-runs/${run.id}/finish`, { notes, kind, ...to }); onDone(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="run-finish">
      <AppliesTo label="Log To" projectId={to.project_id} taskId={to.task_id} onChange={(project_id, task_id) => setTo({ project_id, task_id })} />
      {to.project_id !== null && (
        <div className="applies-to">
          <label className="field"><span className="field-name">Entry</span>
            <select value={kind} onChange={e => setKind(e.target.value as LogKind)}>{LOG_KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>
          </label>
        </div>
      )}
      <span className="field-name">Notes (Optional)</span>
      <Editor value="" startEditing saveLabel={to.project_id === null ? 'Finish Run' : 'Finish and Log'} onCancel={onCancel} onSave={finish} />
      {err && <p className="error">{err}</p>}
      <p className="hint">{run.ticked.length} of {rb.steps.length} steps ticked.{to.project_id === null && ' With Log To set to N/A the run is kept here but nothing goes in the logbook.'}</p>
    </div>
  );
}

/** Start a run, tick steps as you go (saved, so you can stop and come back), finish it into the logbook; earlier runs below. */
function RunbookRuns({ rb, onRb, children }: { rb: Runbook; onRb: () => void; children: (ticks: { ticks?: number[]; onTick?: (t: number[]) => void }) => React.ReactNode }) {
  const [runs, setRuns] = useState<RunbookRun[]>([]);
  const [finishing, setFinishing] = useState(false);
  const load = useCallback(async () => setRuns(await get<RunbookRun[]>(`/runbooks/${rb.id}/runs`)), [rb.id]);
  useEffect(() => { load(); }, [load]);
  const active = runs.find(r => !r.finished);
  const done = runs.filter(r => r.finished);
  const changed = async () => { await load(); onRb(); };
  const tick = async (ticked: number[]) => {
    const u = await api<RunbookRun>('PATCH', `/runbook-runs/${active!.id}`, { ticked });
    setRuns(rs => rs.map(r => (r.id === u.id ? u : r)));
  };
  return (
    <>
      <div className={`run-bar ${active ? 'running' : ''}`}>
        {active ? <>
          <span className="pill status-ok">Running</span>
          <span className="small">Started {ago(active.started)} · {active.ticked.length} of {rb.steps.length} steps done</span>
          <span className="grow" />
          {!finishing && <button className="primary" onClick={() => setFinishing(true)}><Square size={14} />Finish Run</button>}
          <button className="ghost danger" onClick={async () => { if (confirm('Cancel this run? Its ticks are thrown away.')) { await api('DELETE', `/runbook-runs/${active.id}`); setFinishing(false); changed(); } }}>Cancel Run</button>
        </> : <>
          <button className="primary" disabled={!rb.steps.length} title={rb.steps.length ? '' : 'Add steps first'}
            onClick={async () => { await api('POST', `/runbooks/${rb.id}/runs`); changed(); }}><Play size={14} />Start Run</button>
          <span className="muted small">{rb.last_run ? `Last run ${ago(rb.last_run)}` : 'Not run yet'}. Ticks are saved while a run is going, and finishing it writes to the logbook.</span>
        </>}
      </div>
      {active && finishing && <FinishRun rb={rb} run={active} onCancel={() => setFinishing(false)} onDone={() => { setFinishing(false); changed(); }} />}
      {children(active ? { ticks: active.ticked, onTick: tick } : {})}
      {done.length > 0 && (
        <section className="doc-section" aria-label="Run History">
          <div className="section-head"><h3>Run History <span className="count">{done.length}</span></h3></div>
          <div className="table-card">
            <table className="tasks net-table">
              <thead><tr><th>Finished</th><th>Took</th><th>Steps</th><th>By</th><th>Logged To</th><th>Notes</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {done.map(r => (
                  <tr key={r.id}>
                    <td className="small" title={new Date(r.finished!).toLocaleString()}>{new Date(r.finished!).toLocaleDateString()} <span className="muted">{ago(r.finished)}</span></td>
                    <td className="small">{r.maintenance_id ? <span className="muted">Maintenance</span> : took(r)}</td>
                    <td className="small"><span className={`pill ${r.ticked.length === r.steps.length ? 'status-ok' : ''}`}>{r.ticked.length}/{r.steps.length}</span></td>
                    <td className="small">{r.actor}</td>
                    <td className="small">{r.log_id && r.project_id ? <a href={`#/p/${r.project_id}`}>{r.project_title}</a> : <span className="muted">Not logged</span>}</td>
                    <td className="small muted">{snippet(r.notes, 80)}</td>
                    <td><button className="icon-btn" aria-label="Delete run" title="Delete from history (the logbook entry stays)"
                      onClick={async () => { if (confirm('Delete this run from the history? Its logbook entry stays.')) { await api('DELETE', `/runbook-runs/${r.id}`); changed(); } }}><Trash2 size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/** One runbook in the main area (#/runbooks/:id): run bar and steps, its lists and notes, then the run history. */
function RunbookPage({ id }: { id: number }) {
  const { projects } = useData();
  const [r, setR] = useState<Runbook | null>(null);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => get<Runbook>(`/runbooks/${id}`).then(setR).catch(e => setErr((e as Error).message)), [id]);
  useEffect(() => { load(); }, [load]);
  const crumbs = <nav className="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a><span className="sep">/</span><a href="#/runbooks">Runbooks</a></nav>;
  if (err) return <div className="page"><header className="page-header">{crumbs}</header><p className="error">{err}</p></div>;
  if (!r) return null;
  const save = async (patch: Partial<Runbook>) => setR(await api<Runbook>('PATCH', `/runbooks/${r.id}`, patch));
  return (
    <div className="page">
      <header className="page-header">
        {crumbs}
        <div className="runbook-page-title">
          <h1 className="page-title">{r.title}</h1>
          {r.active_run_id && <span className="pill status-ok">Running</span>}
          <RunbookMeta r={r} />
          <span className="grow" />
          <Menu>
            <button onClick={() => setEditing(true)}>Edit Details</button>
            <button className="danger" onClick={async () => { if (confirm(`Delete runbook “${r.title}”?`)) { await api('DELETE', `/runbooks/${r.id}`); go('runbooks'); } }}><Trash2 size={14} />Delete</button>
          </Menu>
        </div>
        <p className="lede">Applies to {appliesLabel(projects, r)} · {r.steps.length} step{r.steps.length === 1 ? '' : 's'} · {r.last_run ? `last run ${ago(r.last_run)}` : 'not run yet'}{r.test_due && ` · test every ${r.test_every === 1 ? 'month' : `${r.test_every} months`}, next by ${new Date(`${r.test_due}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`}</p>
      </header>
      {editing && <RunbookForm item={r} onCancel={() => setEditing(false)} onDone={u => { setEditing(false); setR(u); }} />}
      <div className="runbook-body">
        <RunbookRuns rb={r} onRb={load}>
          {t => <>
            <RunbookSteps steps={r.steps} expected={r.expected} onChange={(steps, expected) => save({ steps, expected })} {...t} />
            <RunbookSteps title="Rollback" addLabel="Add Rollback Step" steps={r.rollback} onChange={rollback => save({ rollback })} />
            {(['requirements', 'tasks', 'resources'] as const).map(list => (
              <Checklist key={list} list={list} data={r.lists[list]} ops={runbookOps(r, list, lists => save({ lists }))} />
            ))}
            <section className="doc-section" aria-label="Notes">
              <div className="section-head"><h3>Notes</h3></div>
              <Editor value={r.notes} placeholder="Add notes…" onSave={notes => save({ notes })} />
            </section>
          </>}
        </RunbookRuns>
      </div>
    </div>
  );
}

export function RunbooksPage({ openId }: { openId?: number }) {
  const { projects } = useData();
  const [items, setItems] = useState<Runbook[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => setItems(await get<Runbook[]>('/runbooks')), []);
  useEffect(() => { if (!openId) load(); }, [load, openId]);
  if (openId) return <RunbookPage key={openId} id={openId} />;
  return (
    <div className="page">
      <header className="page-header">
        <nav className="crumbs"><a href="#/">Home</a></nav>
        <h1 className="page-title">Runbooks</h1>
        <p className="lede">Step-by-step procedures you can follow again: restores, upgrades, failovers. Attach one to a maintenance job and its steps show when you mark it done.</p>
      </header>
      <div className="toolbar"><span className="grow" /><button className="primary" onClick={() => setAdding(true)}><Plus size={15} />Add Runbook</button></div>
      {adding && <RunbookForm onCancel={() => setAdding(false)} onDone={r => go(`runbooks/${r.id}`)} />}
      {!items.length && !adding && <div className="empty-state"><b>No Runbooks Yet</b><span>Write down how to restore a backup or upgrade a host once, and follow the same steps every time.</span></div>}
      <div className="runbooks">
        {items.map(r => (
          <a key={r.id} className="card runbook" href={`#/runbooks/${r.id}`}>
            <div className="runbook-title">
              <b>{r.title}</b>{r.active_run_id && <span className="pill status-ok">Running</span>}<RunbookMeta r={r} />
              <span className="muted small">{r.steps.length} step{r.steps.length === 1 ? '' : 's'} · {appliesLabel(projects, r)}{r.last_run && ` · last run ${ago(r.last_run)}`}</span>
            </div>
            {r.notes && <p className="muted small">{snippet(r.notes, 120)}</p>}
          </a>
        ))}
      </div>
    </div>
  );
}
