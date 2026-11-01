import { useEffect, useRef, useState } from 'react';
import { BookOpen, CalendarClock, CheckSquare, Folder, Lightbulb, NotebookPen, Search } from 'lucide-react';
import { get } from './api';
import { go } from './App';

type Hit = { id: number; title: string; snippet: string; project_id?: number; project_title?: string | null; done?: boolean };
type Results = Record<'projects' | 'tasks' | 'log' | 'maintenance' | 'runbooks' | 'ideas', Hit[]>;
const GROUPS = [
  ['projects', 'Projects', Folder], ['tasks', 'Tasks', CheckSquare], ['log', 'Logbook', NotebookPen],
  ['maintenance', 'Maintenance', CalendarClock], ['runbooks', 'Runbooks', BookOpen], ['ideas', 'Ideas', Lightbulb],
] as const;

const setView = (v: string) => { try { localStorage.setItem('smj:view', v); } catch { /* private mode */ } };
function open(group: keyof Results, h: Hit) {
  if (group === 'projects') go(`p/${h.id}`);
  else if (group === 'tasks') go(`t/${h.id}`);
  else if (group === 'log') { setView('log'); go(`p/${h.project_id}`); }
  else if (group === 'maintenance') { setView('maint'); go(`p/${h.project_id}`); }
  else if (group === 'ideas') { setView('ideas'); go(`p/${h.project_id}`); }
  else go(`runbooks/${h.id}`);
}

/** Ctrl+K / Cmd+K: one search box over projects, tasks, logbook, maintenance, runbooks and ideas. */
export function Palette() {
  const [shown, setShown] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Results | null>(null);
  const [sel, setSel] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setShown(s => !s); }
    };
    const onOpen = () => setShown(true);
    addEventListener('keydown', onKey);
    addEventListener('smj:search', onOpen);
    return () => { removeEventListener('keydown', onKey); removeEventListener('smj:search', onOpen); };
  }, []);
  useEffect(() => {
    if (!shown) { setQ(''); setRes(null); return; }
    const n = ++seq.current;
    const t = setTimeout(() => {
      if (!q.trim()) return setRes(null);
      get<Results>(`/search?q=${encodeURIComponent(q)}`).then(r => { if (n === seq.current) { setRes(r); setSel(0); } });
    }, 150);
    return () => clearTimeout(t);
  }, [q, shown]);
  if (!shown) return null;

  const flat = res ? GROUPS.flatMap(([g]) => res[g].map(h => [g, h] as const)) : [];
  const pick = (i: number) => { const f = flat[i]; if (f) { setShown(false); open(f[0], f[1]); } };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setShown(false);
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') pick(sel);
  };
  let i = -1;
  return (
    <div className="palette-scrim" onMouseDown={e => e.target === e.currentTarget && setShown(false)}>
      <div className="palette" role="dialog" aria-label="Search everything">
        <label className="palette-input"><Search size={17} />
          <input autoFocus placeholder="Search projects, tasks, logbook, runbooks, ideas" aria-label="Search everything"
            value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} />
          <kbd>Esc</kbd>
        </label>
        <div className="palette-results" role="listbox">
          {res && !flat.length && <p className="muted palette-empty">Nothing matches “{q}”.</p>}
          {!res && <p className="muted palette-empty">Type to search. ↑ ↓ to move, Enter to open.</p>}
          {res && GROUPS.map(([g, label, Icon]) => res[g].length > 0 && (
            <div key={g}>
              <div className="palette-group">{label}</div>
              {res[g].map(h => {
                const idx = ++i;
                return (
                  <button key={`${g}${h.id}`} role="option" aria-selected={idx === sel} className={`palette-hit ${idx === sel ? 'sel' : ''}`}
                    onMouseEnter={() => setSel(idx)} onClick={() => pick(idx)}>
                    <Icon size={15} />
                    <span className="palette-text">
                      <span className={h.done ? 'done-text' : ''}>{h.title}</span>
                      {h.snippet && <span className="sub">{h.snippet}</span>}
                    </span>
                    {h.project_title && <span className="muted small">{h.project_title}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
