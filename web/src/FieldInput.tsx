import { useEffect, useState } from 'react';
import { ArrowUpRight, ExternalLink, X } from 'lucide-react';
import { go, useData } from './App';
import type { Field, FieldValue } from './api';

/** Inline editor for one custom field value. Commits on change (select/checkbox/date) or blur (text). */
export function FieldInput({ field, onCommit, onRemove }: { field: FieldValue; onCommit: (v: string | boolean | null) => Promise<unknown>; onRemove?: () => void }) {
  const { projects } = useData();
  const [v, setV] = useState(field.value ?? '');
  const [err, setErr] = useState('');
  useEffect(() => setV(field.value ?? ''), [field.value]);

  const commit = async (next: string | boolean | null) => {
    if ((next ?? '') === (field.value ?? '')) return;
    try {
      setErr('');
      await onCommit(next === '' ? null : next);
    } catch (e) {
      setErr((e as Error).message);
      setV(field.value ?? '');
    }
  };
  const label = `${field.name} value`;
  let input;
  switch (field.type) {
    case 'select':
      input = (
        <select aria-label={label} value={v} onChange={e => { setV(e.target.value); commit(e.target.value); }}>
          <option value="">—</option>
          {field.options.map(o => <option key={o}>{o}</option>)}
          {v && !field.options.includes(v) && <option>{v}</option>}
        </select>
      );
      break;
    case 'checkbox':
      input = <input aria-label={label} type="checkbox" checked={v === 'true'} onChange={e => commit(e.target.checked)} />;
      break;
    case 'link': // points at another project (e.g. Runs On: server1)
      input = (
        <span className="field-input">
          <select aria-label={label} value={v} onChange={e => { setV(e.target.value); commit(e.target.value); }}>
            <option value="">—</option>
            {projects.map(p => <option key={p.id} value={String(p.id)}>{p.title}</option>)}
          </select>
          {field.value && <a className="icon-btn" href={`#/p/${field.value}`} title={`Go to ${field.display ?? 'project'}`} aria-label={`Go to ${field.display ?? 'linked project'}`}><ArrowUpRight size={14} /></a>}
        </span>
      );
      break;
    case 'date':
      input = <input aria-label={label} type="date" value={v} onChange={e => { setV(e.target.value); commit(e.target.value); }} />;
      break;
    default:
      input = (
        <span className="field-input">
          <input aria-label={label} type={field.type === 'number' ? 'number' : 'text'} value={v} placeholder="—"
            onChange={e => setV(e.target.value)} onBlur={() => commit(v)} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          {field.type === 'url' && field.value && <a className="icon-btn" href={field.value} target="_blank" rel="noreferrer" title="Open link" aria-label={`Open ${field.name}`}><ExternalLink size={14} /></a>}
        </span>
      );
  }
  return (
    <div className="field">
      <span className="field-name" title={field.source === 'parent' ? 'Added on a parent project' : field.source === 'own' ? 'Added here' : 'From the project type'}>{field.name}</span>
      {input}
      {onRemove && field.source === 'own'
        ? <button type="button" className="icon-btn field-remove" aria-label={`Remove field ${field.name}`} title="Remove this field (its value is kept)" onClick={onRemove}><X size={13} /></button>
        : <span />}
      {err && <span className="error">{err}</span>}
    </div>
  );
}

/** "Add field" picker: groups of fields that can still be added, plus a shortcut to create a new one. */
export function AddField({ groups, onAdd }: { groups: { label: string; fields: Field[] }[]; onAdd: (fieldId: number) => void }) {
  const any = groups.some(g => g.fields.length);
  return (
    <select className="add-field" aria-label="Add a custom field" value="" onChange={e => {
      if (e.target.value === 'new') go('settings/fields');
      else if (e.target.value) onAdd(+e.target.value);
    }}>
      <option value="">+ Add Field</option>
      {groups.filter(g => g.fields.length).map(g => (
        <optgroup key={g.label} label={g.label}>
          {g.fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </optgroup>
      ))}
      <option value="new">{any ? 'Create a New Field…' : 'Create a Field…'}</option>
    </select>
  );
}

export function fieldText(f: FieldValue) {
  if (f.value === null) return '';
  if (f.type === 'checkbox') return f.value === 'true' ? '✓' : '✗';
  if (f.type === 'link') return f.display ?? '';
  return f.value;
}
