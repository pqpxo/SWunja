// Closing a task or project: Completed / Abandoned / On Hold with notes, plus reason, replaced by, lessons and logbook.
import { useEffect, useState } from 'react';
import { api, get, type Closure, type ClosedStatus } from './api';
import { go } from './App';

export const CLOSED_LABEL: Record<ClosedStatus, string> = { completed: 'Completed', abandoned: 'Abandoned', on_hold: 'On Hold' };
const REASONS = [['no_longer_needed', 'No longer needed'], ['replaced', 'Replaced'], ['too_costly', 'Too costly'], ['blocked', 'Blocked'], ['other', 'Other']] as const;
type Ref = { kind: 'task' | 'project'; id: number; title: string };

export function ClosedPill({ closed }: { closed: string | null }) {
  if (closed !== 'abandoned' && closed !== 'on_hold') return null; // completed already shows as done
  return <span className={`pill closed-pill ${closed}`}>{CLOSED_LABEL[closed]}</span>;
}

/** Type a few letters to find the task or project that replaces / follows on from this one. */
function ReplacedBy({ value, onChange }: { value: Ref | null; onChange: (r: Ref | null) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Ref[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => get<{ projects: Ref[]; tasks: Ref[] }>(`/search?q=${encodeURIComponent(q)}`)
      .then(r => {
        const all = [...r.projects.map(h => ({ kind: 'project' as const, id: h.id, title: h.title })), ...r.tasks.map(h => ({ kind: 'task' as const, id: h.id, title: h.title }))];
        setHits(all.filter((h, i) => all.findIndex(x => x.kind === h.kind && x.id === h.id) === i));
      }), 200);
    return () => clearTimeout(t);
  }, [q]);
  if (value) return <div className="replaced-pick"><span>{value.kind === 'task' ? 'Task' : 'Project'}: {value.title}</span><button type="button" className="link" onClick={() => onChange(null)}>Change</button></div>;
  return (
    <div className="replaced-search">
      <input aria-label="Replaced by" placeholder="Search tasks and projects (optional)" value={q} onChange={e => setQ(e.target.value)} />
      {hits.length > 0 && <ul className="replaced-hits">{hits.slice(0, 8).map(h => (
        <li key={`${h.kind}${h.id}`}><button type="button" onClick={() => { onChange(h); setQ(''); }}>{h.kind === 'task' ? 'Task' : 'Project'} · {h.title}</button></li>
      ))}</ul>}
    </div>
  );
}

export function CloseDialog({ kind, id, title, onDone, onCancel }: { kind: 'task' | 'project'; id: number; title: string; onDone: () => void; onCancel: () => void }) {
  const [status, setStatus] = useState<ClosedStatus | null>(null);
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [lessons, setLessons] = useState('');
  const [replaced, setReplaced] = useState<Ref | null>(null);
  const [log, setLog] = useState(kind === 'project');
  const [closeTasks, setCloseTasks] = useState(true);
  const [reviewOn, setReviewOn] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onCancel]);
  const submit = async () => {
    if (!status) return;
    try {
      await api('POST', `/${kind}s/${id}/close`, {
        status, notes, log,
        ...(status === 'abandoned' && reason && { reason }),
        ...(status !== 'on_hold' && lessons.trim() && { lessons }),
        ...(replaced && { replaced_by: { kind: replaced.kind, id: replaced.id } }),
        ...(kind === 'project' && { close_tasks: closeTasks }),
        ...(status === 'on_hold' && reviewOn && { review_on: reviewOn }),
      });
      onDone();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="palette-scrim" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <form className="palette close-dialog" role="dialog" aria-label={`Close ${title}`} onSubmit={e => { e.preventDefault(); submit(); }}>
        <h3>Close {kind === 'task' ? 'Task' : 'Project'}: {title}</h3>
        <div className="close-choices" role="radiogroup" aria-label="Outcome">
          {(['completed', 'abandoned', 'on_hold'] as const).map(s => (
            <label key={s} className={`close-choice ${status === s ? 'on' : ''}`}>
              <input type="radio" name="closure" checked={status === s} onChange={() => setStatus(s)} />{CLOSED_LABEL[s]}
            </label>
          ))}
        </div>
        {status && <>
          <label className="close-field">Closure Notes
            <textarea autoFocus rows={4} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder={status === 'completed' ? 'What was done' : status === 'abandoned' ? 'Why it was stopped' : 'What it is waiting for'} />
          </label>
          {status === 'abandoned' && (
            <label className="close-field">Reason
              <select value={reason} onChange={e => setReason(e.target.value)}>
                <option value="">Choose…</option>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          )}
          <div className="close-field">{status === 'on_hold' ? 'Follow-up' : 'Replaced By / Follow-up'}<ReplacedBy value={replaced} onChange={setReplaced} /></div>
          {status === 'on_hold' && (
            <label className="close-field">Review On
              <input type="date" value={reviewOn} min={new Date().toISOString().slice(0, 10)} onChange={e => setReviewOn(e.target.value)} />
              <span className="close-hint">Optional. It comes back onto Home on this day.</span>
            </label>
          )}
          {status !== 'on_hold' && (
            <label className="close-field">Lessons Learned
              <textarea rows={3} value={lessons} onChange={e => setLessons(e.target.value)} placeholder="Optional" />
            </label>
          )}
          <label className="close-check"><input type="checkbox" checked={log} onChange={e => setLog(e.target.checked)} />Add to the logbook</label>
          {kind === 'project' && status !== 'on_hold' && (
            <label className="close-check"><input type="checkbox" checked={closeTasks} onChange={e => setCloseTasks(e.target.checked)} />Also close its open tasks (including sub-projects)</label>
          )}
        </>}
        {err && <p className="error">{err}</p>}
        <div className="close-buttons">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!status}>Close {kind === 'task' ? 'Task' : 'Project'}</button>
        </div>
      </form>
    </div>
  );
}

/** Shown at the top of a closed task or project: outcome, notes, reason, follow-up, lessons, and Reopen / Resume. */
export function ClosureBanner({ kind, id, closed, closure, onReopen }: { kind: 'task' | 'project'; id: number; closed: string | null; closure: Closure | null; onReopen: () => void }) {
  if (!closed || !closure) return null;
  const reopen = async () => { await api('POST', `/${kind}s/${id}/reopen`); onReopen(); };
  const when = new Date(closure.closed_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const reason = REASONS.find(([v]) => v === closure.reason)?.[1];
  const r = closure.replaced_by;
  return (
    <div className={`closure-banner ${closed}`}>
      <div className="closure-head">
        <strong>{CLOSED_LABEL[closed as ClosedStatus]}</strong><span className="muted">{when}{closure.closed_by !== 'web' && ` · via ${closure.closed_by}`}</span>
        <button onClick={reopen}>{closed === 'on_hold' ? 'Resume' : 'Reopen'}</button>
      </div>
      {closure.notes && <p className="closure-notes">{closure.notes}</p>}
      {reason && <p><span className="muted">Reason:</span> {reason}</p>}
      {r && <p><span className="muted">{closed === 'on_hold' ? 'Follow-up:' : 'Replaced by:'}</span> <button className="link" onClick={() => go(r.kind === 'task' ? `t/${r.id}` : `p/${r.id}`)}>{r.title}</button></p>}
      {closure.lessons && <p className="closure-notes"><span className="muted">Lessons learned:</span> {closure.lessons}</p>}
      {closure.review_on && <p><span className="muted">Review on:</span> {new Date(`${closure.review_on}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</p>}
    </div>
  );
}

/** "Close Task / Project…" (opens the dialog), or Reopen / Resume once closed. Sits under History / the details card. */
export function CloseButton({ kind, id, title, closed, onChange }: { kind: 'task' | 'project'; id: number; title: string; closed: string | null; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const noun = kind === 'task' ? 'Task' : 'Project';
  return (
    <div className="close-row">
      {closed
        ? <button type="button" onClick={() => api('POST', `/${kind}s/${id}/reopen`).then(onChange)}>{closed === 'on_hold' ? 'Resume' : 'Reopen'} {noun}</button>
        : <button type="button" onClick={() => setOpen(true)}>Close {noun}…</button>}
      {open && <CloseDialog kind={kind} id={id} title={title} onCancel={() => setOpen(false)} onDone={() => { setOpen(false); onChange(); }} />}
    </div>
  );
}
