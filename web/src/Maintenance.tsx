import { useCallback, useEffect, useState } from 'react';
import { CheckCheck, Plus, Trash2 } from 'lucide-react';
import { api, get, type Maintenance, type Runbook, type Unit } from './api';
import { RunbookSteps } from './Runbooks';
import { useData } from './App';
import { Menu, snippet } from './ui';

const UNITS: [Unit, string][] = [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']];
const STATUS = { overdue: 'Overdue', 'due-soon': 'Due Soon', ok: 'OK' } as const;
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export const notifyMaintenance = () => window.dispatchEvent(new Event('smj:maint'));

const everyText = (m: Maintenance) => `Every ${m.every === 1 ? '' : `${m.every} `}${m.every === 1 ? m.unit : `${m.unit}s`}`;
function dueText(next: string) {
  const days = Math.round((Date.parse(next) - Date.parse(localToday())) / 86_400_000);
  if (days === 0) return 'Due today';
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} overdue`;
  return `In ${days} day${days === 1 ? '' : 's'}`;
}
const fmt = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never');

function ItemForm({ projectId, item, onDone, onCancel }: { projectId: number | null; item?: Maintenance; onDone: () => void; onCancel: () => void }) {
  const { projects } = useData();
  const [d, setD] = useState({
    project_id: item?.project_id ?? projectId ?? projects[0]?.id ?? 0, title: item?.title ?? '', every: item?.every ?? 1, unit: item?.unit ?? 'month' as Unit,
    next_due: item?.next_due ?? localToday(), notes: '', runbook_id: item?.runbook_id ?? null as number | null,
  });
  const [err, setErr] = useState('');
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  useEffect(() => { if (d.project_id) get<Runbook[]>(`/runbooks?project_id=${d.project_id}`).then(setRunbooks); }, [d.project_id]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body = { project_id: d.project_id, title: d.title, every: d.every, unit: d.unit, next_due: d.next_due, runbook_id: d.runbook_id, ...(item ? {} : { notes: d.notes ? `<p>${d.notes.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` : '' }) };
      await api(item ? 'PATCH' : 'POST', item ? `/maintenance/${item.id}` : '/maintenance', body);
      notifyMaintenance();
      onDone();
    } catch (x) { setErr((x as Error).message); }
  };
  return (
    <form className="card maint-form" onSubmit={save}>
      <input autoFocus placeholder="What needs doing? e.g. Test backup restore" aria-label="Title" value={d.title} onChange={e => setD({ ...d, title: e.target.value })} />
      <div className="maint-form-row">
        {projectId === null && (
          <label className="field"><span className="field-name">Project</span>
            <select value={d.project_id} onChange={e => setD({ ...d, project_id: +e.target.value })}>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
          </label>
        )}
        <label className="field"><span className="field-name">Every</span>
          <span className="row gap">
            <input type="number" min={1} max={1000} aria-label="Every how many" value={d.every} onChange={e => setD({ ...d, every: Math.max(1, +e.target.value || 1) })} className="num" />
            <select aria-label="Unit" value={d.unit} onChange={e => setD({ ...d, unit: e.target.value as Unit })}>{UNITS.map(([u, l]) => <option key={u} value={u}>{l}</option>)}</select>
          </span>
        </label>
        <label className="field"><span className="field-name">{item ? 'Next Due' : 'First Due'}</span>
          <input type="date" value={d.next_due} onChange={e => setD({ ...d, next_due: e.target.value })} />
        </label>
        <label className="field"><span className="field-name">Runbook</span>
          <select value={d.runbook_id ?? ''} onChange={e => setD({ ...d, runbook_id: e.target.value ? +e.target.value : null })}>
            <option value="">None</option>{runbooks.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        </label>
      </div>
      {!item && <input placeholder="Notes: how to do it (optional)" aria-label="Notes" value={d.notes} onChange={e => setD({ ...d, notes: e.target.value })} />}
      {err && <p className="error">{err}</p>}
      <div className="row gap">
        <button className="primary" disabled={!d.title.trim()}>{item ? 'Save' : 'Add Maintenance'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function DoneForm({ item, onDone, onCancel }: { item: Maintenance; onDone: () => void; onCancel: () => void }) {
  const [date, setDate] = useState(localToday());
  const [notes, setNotes] = useState('');
  const [runbook, setRunbook] = useState<Runbook | null>(null);
  const [ticked, setTicked] = useState<number[]>([]);
  useEffect(() => { if (item.runbook_id) get<Runbook>(`/runbooks/${item.runbook_id}`).then(setRunbook).catch(() => {}); }, [item.runbook_id]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    await api('POST', `/maintenance/${item.id}/done`, { date, notes: notes ? `<p>${notes.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` : '', ...(runbook && { runbook_ticked: ticked }) });
    notifyMaintenance();
    onDone();
  };
  return (
    <form className="done-form" onSubmit={save}>
      {runbook && <div className="done-runbook"><a href={`#/runbooks/${runbook.id}`} className="small">Runbook: {runbook.title}</a><RunbookSteps steps={runbook.steps} expected={runbook.expected} ticks={ticked} onTick={setTicked} /></div>}
      <input type="date" aria-label="Done on" value={date} onChange={e => setDate(e.target.value)} />
      <input autoFocus placeholder="What was done or found (goes in the logbook)" aria-label="Notes" value={notes} onChange={e => setNotes(e.target.value)} />
      <button className="primary"><CheckCheck size={15} />Mark Done</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

/** Recurring maintenance for a project (and its sub-projects), or for everything when projectId is null. */
export function MaintenanceView({ projectId }: { projectId: number | null }) {
  const [items, setItems] = useState<Maintenance[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [doing, setDoing] = useState<number | null>(null);
  const load = useCallback(async () => setItems(await get<Maintenance[]>(`/maintenance${projectId !== null ? `?project_id=${projectId}` : ''}`)), [projectId]);
  useEffect(() => { load(); }, [load]);
  const overdue = items.filter(i => i.status === 'overdue').length;
  return (
    <div className="maintenance">
      <div className="toolbar">
        <span className="muted small">{items.length ? `${items.length} item${items.length > 1 ? 's' : ''}${overdue ? `, ${overdue} overdue` : ''}` : ''}</span>
        <span className="grow" />
        <button className="primary" onClick={() => setAdding(true)}><Plus size={15} />Add Maintenance</button>
      </div>
      {adding && <ItemForm projectId={projectId} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {!items.length && !adding && (
        <div className="empty-state"><b>No Recurring Maintenance</b>
          <span>Patching, certificate renewals, backup-restore tests, firmware updates: add them here and each shows when it was last done and when it's next due.</span></div>
      )}
      {items.length > 0 && (
        <div className="table-card">
          <table className="tasks maint-table">
            <thead><tr><th>Status</th><th>Maintenance</th>{projectId === null && <th>Project</th>}<th>Every</th><th>Last Done</th><th>Next Due</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {items.map(m => editing === m.id ? (
                <tr key={m.id}><td colSpan={7}><ItemForm projectId={projectId} item={m} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} /></td></tr>
              ) : (
                <tr key={m.id} className={`maint-${m.status}`}>
                  <td><span className={`pill status-${m.status}`}>{STATUS[m.status]}</span></td>
                  <td className="title-cell"><b>{m.title}</b>{m.notes && <span className="sub">{snippet(m.notes, 90)}</span>}
                    {doing === m.id && <DoneForm item={m} onCancel={() => setDoing(null)} onDone={() => { setDoing(null); load(); }} />}</td>
                  {projectId === null && <td><a href={`#/p/${m.project_id}`}>{m.project_title}</a></td>}
                  <td className="field-cell">{everyText(m)}</td>
                  <td className="field-cell">{fmt(m.last_done)}</td>
                  <td className="field-cell"><span className={`due-${m.status}`}>{fmt(m.next_due)}</span><span className="sub">{dueText(m.next_due)}</span></td>
                  <td className="maint-actions">
                    {doing !== m.id && <button onClick={() => setDoing(m.id)}><CheckCheck size={15} />Done</button>}
                    <Menu>
                      <button onClick={() => setEditing(m.id)}>Edit</button>
                      <a className="menu-link" href={`#/p/${m.project_id}`} onClick={() => { try { localStorage.setItem('smj:view', 'log'); } catch { /* private mode */ } }}>View in Logbook</a>
                      <button className="danger" onClick={async () => { if (confirm(`Delete “${m.title}”? Its logbook entries stay.`)) { await api('DELETE', `/maintenance/${m.id}`); notifyMaintenance(); load(); } }}><Trash2 size={14} />Delete</button>
                    </Menu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function MaintenancePage() {
  return (
    <div className="page">
      <header className="page-header">
        <nav className="crumbs"><a href="#/">Home</a></nav>
        <h1 className="page-title">Maintenance</h1>
        <p className="lede">Recurring jobs across every project, soonest due first. Marking one done records it in that project's logbook.</p>
      </header>
      <MaintenanceView projectId={null} />
    </div>
  );
}
