import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { PRIORITIES } from './api';

/** Priority as a soft coloured pill. */
export function Prio({ p }: { p: number }) {
  if (!p) return null;
  return <span className={`pill prio-${p}`}>{PRIORITIES[p]}</span>;
}

/** A button that turns into a one-line input; Enter submits, Escape cancels. Replaces window.prompt(). */
export function InlineAdd({ label, placeholder, onSubmit, className = '', initial = '', initialOpen = false, onClose }: {
  label: ReactNode; placeholder: string; onSubmit: (v: string) => Promise<unknown> | void; className?: string; initial?: string;
  /** start as the input; onClose runs when it would fold back to the button */
  initialOpen?: boolean; onClose?: () => void;
}) {
  const [open, setOpenState] = useState(initialOpen);
  const setOpen = (o: boolean) => { setOpenState(o); if (!o) onClose?.(); };
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className={`inline-add ${className}`} onClick={() => { setV(initial); setOpen(true); }}>{label}</button>;
  const submit = async () => {
    if (!v.trim() || busy) return;
    setBusy(true);
    try { await onSubmit(v.trim()); setOpen(false); setV(''); } finally { setBusy(false); }
  };
  return (
    <input autoFocus className={`inline-add-input ${className}`} aria-label={placeholder} placeholder={placeholder} value={v} disabled={busy}
      onChange={e => setV(e.target.value)} onBlur={() => !v.trim() && setOpen(false)}
      onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false); }} />
  );
}

/** Small overflow menu built on <details>; closes on outside click or after an item is chosen. */
export function Menu({ label = <MoreHorizontal size={16} />, children, className = '', ariaLabel = 'More actions' }: { label?: ReactNode; children: ReactNode; className?: string; ariaLabel?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  return (
    <details className={`menu ${className}`} ref={ref}>
      <summary aria-label={ariaLabel} className="icon-btn">{label}</summary>
      <div className="menu-pop" onClick={e => { if ((e.target as HTMLElement).closest('button')) ref.current!.open = false; }}>{children}</div>
    </details>
  );
}

/** Plain-text preview of stored rich text (DOMParser documents are inert: no scripts run, no images load). */
export function snippet(html: string, max = 140) {
  if (!html) return '';
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export const ago = (iso: string | null) => {
  if (!iso) return 'not yet';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** Ids the user has collapsed in a tree, remembered in this browser under `key`. */
export function useCollapsed(key: string) {
  const [collapsed, set] = useState<Set<number>>(() => { try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set(); } });
  const save = (next: Set<number>) => { set(next); try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* private mode */ } };
  const toggle = (id: number) => { const n = new Set(collapsed); if (n.has(id)) n.delete(id); else n.add(id); save(n); };
  return { collapsed, toggle, setAll: (ids: number[]) => save(new Set(ids)) };
}
