import { Fragment, useRef, useState } from 'react';
import { CornerDownRight, ExternalLink, GripVertical, List, ListOrdered, Plus, X } from 'lucide-react';
import type { ChecklistItem } from './api';

export type ListKind = 'requirements' | 'tasks' | 'resources';
export type ListData = { items: ChecklistItem[]; style: 'bullets' | 'numbered'; enabled: boolean };
export type ListOps = {
  add: (text: string, parent_id: number | null) => Promise<unknown>;
  edit: (it: ChecklistItem, patch: { text?: string; done?: boolean }) => Promise<unknown>;
  remove: (it: ChecklistItem) => Promise<unknown>;
  reorder: (ids: number[], parent_id: number | null) => Promise<unknown>;
  setStyle: (style: ListData['style']) => Promise<unknown>;
  setEnabled: (on: boolean) => Promise<unknown>;
};
// key = the task's field prefix for that list's items/style/enabled flag
export const LIST_TEXT = {
  requirements: { key: 'requirements', title: 'Requirements', one: 'requirement', sub: 'sub-requirement', add: 'Add Requirement', addSub: 'Add Sub-Requirement' },
  tasks: { key: 'checklist', title: 'Tasks', one: 'task', sub: 'subtask', add: 'Add Task', addSub: 'Add Subtask' },
  resources: { key: 'resources', title: 'Resources', one: 'resource', sub: 'sub-resource', add: 'Add Resource', addSub: 'Add Sub-Resource' },
} as const;
const URL_IN_TEXT = /https?:\/\/[^\s)]+/;

/**
 * A list under Proposed Resolution: Requirements (parts, domains, packages, tools), Tasks (the checklist) or Resources (links, docs).
 * Items have one level of sub-items; tick, edit, delete, drag (or Alt+↑/↓) to reorder; numbered or bullets.
 * Each list can be switched off, which hides its add button and style switch (existing items stay visible).
 * Where the items live (a task, a runbook) is up to `ops`.
 */
export function Checklist({ list, data, ops }: { list: ListKind; data: ListData; ops: ListOps }) {
  const T = LIST_TEXT[list];
  const { enabled, items } = data;
  // null: no new-item input showing; 0: adding a top-level item; an item id: adding a subtask under it
  const [addingUnder, setAddingUnder] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState<ChecklistItem | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const tops = items.filter(i => i.parent_id === null);
  const subsOf = (id: number) => items.filter(i => i.parent_id === id);
  const numbered = data.style === 'numbered';
  const startAdding = (under: number) => { setDraft(''); setAddingUnder(under); setTimeout(() => newRef.current?.focus()); };
  const add = async () => {
    const text = draft.trim();
    if (!text || addingUnder === null) return;
    setDraft('');
    await ops.add(text, addingUnder || null);
    // the input stays open: type, Enter, type, Enter…
  };
  const move = async (group: ChecklistItem[], from: number, to: number) => {
    if (to < 0 || to >= group.length || from === to) return;
    const ids = group.map(i => i.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    await ops.reorder(ids, group[0].parent_id);
  };
  const remove = async (it: ChecklistItem) => {
    const n = subsOf(it.id).length;
    if (n && !confirm(`Delete “${it.text}” and its ${n} ${T.sub}${n > 1 ? 's' : ''}?`)) return;
    await ops.remove(it);
  };
  const setStyle = (style: ListData['style']) => ops.setStyle(style);
  const setEnabled = async (on: boolean) => { setAddingUnder(null); await ops.setEnabled(on); };
  const label = (top: number, sub?: number) =>
    numbered ? (sub === undefined ? `${top + 1}.` : `${top + 1}${String.fromCharCode(97 + (sub % 26))}.`) : sub === undefined ? '•' : '◦';
  const done = items.filter(i => i.done).length;

  const row = (it: ChecklistItem, group: ChecklistItem[], idx: number, marker: string) => (
    <li key={it.id} className={`ck-item ${it.parent_id ? 'ck-sub' : ''} ${it.done ? 'done' : ''} ${over === it.id ? 'over' : ''} ${drag?.id === it.id ? 'dragging' : ''}`}
      onDragOver={e => { if (drag && drag.parent_id === it.parent_id) { e.preventDefault(); setOver(it.id); } }}
      onDragLeave={() => setOver(null)}
      onDrop={e => {
        e.preventDefault();
        if (drag && drag.parent_id === it.parent_id) move(group, group.findIndex(x => x.id === drag.id), idx);
        setDrag(null); setOver(null);
      }}>
      <span className="ck-handle" draggable title="Drag to reorder (or Alt+↑ / Alt+↓)"
        onDragStart={e => { setDrag(it); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(it.id)); }}
        onDragEnd={() => { setDrag(null); setOver(null); }}><GripVertical size={14} /></span>
      <span className="ck-marker" aria-hidden>{marker}</span>
      <input type="checkbox" className="tick" checked={it.done} aria-label={`Done: ${it.text}`}
        onChange={e => ops.edit(it, { done: e.target.checked })} />
      <input className="ck-text" defaultValue={it.text} key={it.text} aria-label={`${it.parent_id ? T.sub : T.one} ${marker}`}
        onBlur={async e => {
          const v = e.target.value.trim();
          if (v === it.text) return;
          if (!v) return remove(it); // clearing the text deletes it
          await ops.edit(it, { text: v });
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(group, idx, idx - 1); }
          if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(group, idx, idx + 1); }
        }} />
      <span className="ck-actions">
        {URL_IN_TEXT.test(it.text) && (
          <a className="icon-btn" href={URL_IN_TEXT.exec(it.text)![0]} target="_blank" rel="noreferrer" aria-label={`Open link in ${it.text}`} title="Open Link"><ExternalLink size={14} /></a>
        )}
        {!it.parent_id && enabled && <button className="icon-btn" aria-label={`Add a ${T.sub} to ${it.text}`} title={T.addSub} onClick={() => startAdding(it.id)}><CornerDownRight size={14} /></button>}
        <button className="icon-btn" aria-label={`Delete ${it.text}`} title="Delete" onClick={() => remove(it)}><X size={14} /></button>
      </span>
    </li>
  );
  const newRow = (marker: string, sub: boolean) => (
    <li className={`ck-item ck-new ${sub ? 'ck-sub' : ''}`}>
      <span className="ck-handle" />
      <span className="ck-marker" aria-hidden>{marker}</span>
      <input type="checkbox" className="tick" disabled aria-hidden tabIndex={-1} />
      <input ref={newRef} className="ck-text" placeholder={`Add a ${sub ? T.sub : T.one}, press Enter`} aria-label={`New ${sub ? T.sub : T.one}`} value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') add(); if (e.key === 'Escape') { setDraft(''); setAddingUnder(null); } }}
        onBlur={() => { if (draft.trim()) add(); else setAddingUnder(null); }} />
      <span />
    </li>
  );

  return (
    <section className={`doc-section checklist ${enabled ? '' : 'is-off'}`} aria-label={T.title}>
      <div className="section-head">
        <h3>{T.title} {enabled && items.length > 0 && <span className="count">{done}/{items.length}</span>}</h3>
        <span className="section-tools">
          {enabled && (
            <div className="seg seg-sm" role="group" aria-label="List style">
              <button className={numbered ? 'on' : ''} aria-pressed={numbered} onClick={() => setStyle('numbered')}><ListOrdered size={14} />Numbered</button>
              <button className={!numbered ? 'on' : ''} aria-pressed={!numbered} onClick={() => setStyle('bullets')}><List size={14} />Bullets</button>
            </div>
          )}
          <button className={`switch ${enabled ? 'on' : ''}`} role="switch" aria-checked={enabled} aria-label={`Show ${T.title}`}
            title={enabled ? `Disable ${T.title}` : `Enable ${T.title}`} onClick={() => setEnabled(!enabled)}>
            <span className="knob" />
          </button>
        </span>
      </div>
      {enabled && (items.length > 0 || addingUnder !== null) && (
        <ol className="ck-list">
          {tops.map((top, ti) => {
            const subs = subsOf(top.id);
            return (
              <Fragment key={top.id}>
                {row(top, tops, ti, label(ti))}
                {subs.map((sub, si) => row(sub, subs, si, label(ti, si)))}
                {enabled && addingUnder === top.id && newRow(label(ti, subs.length), true)}
              </Fragment>
            );
          })}
          {enabled && addingUnder === 0 && newRow(label(tops.length), false)}
        </ol>
      )}
      {enabled && <button className="add-row" onClick={() => startAdding(0)}><Plus size={14} />{T.add}</button>}
    </section>
  );
}
