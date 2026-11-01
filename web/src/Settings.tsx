import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { api, fileSize, get, type Appearance, type Field, type FieldType, type Template, type Token } from './api';
import { ACCENTS, FONTS, THEMES } from './theme';
import { go, useData } from './App';
import { InlineAdd } from './ui';
import { IntegrationsTab } from './Monitor';
import { GoogleDriveCard } from './Gdrive';
import { AboutTab, NavTab } from './About';

const TABS: [string, string][] = [['appearance', 'Appearance'], ['nav', 'Navigation'], ['fields', 'Custom Fields'], ['types', 'Project Types'], ['labels', 'Labels'], ['templates', 'Templates'], ['tokens', 'API Tokens & MCP'], ['integrations', 'Integrations'], ['import', 'Import & Export'], ['backups', 'Backups'], ['account', 'Account'], ['about', 'About']];
const FIELD_TYPES: FieldType[] = ['text', 'number', 'date', 'select', 'checkbox', 'url', 'link'];

function useAction() {
  const [err, setErr] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    try { setErr(''); await fn(); } catch (e) { setErr((e as Error).message); }
  };
  return { err, run };
}

// navigator.clipboard only exists on https/localhost; fall back to a hidden textarea on plain-http LAN addresses
function copy(text: string) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

const parseOptions = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

function FieldRow({ f }: { f: Field }) {
  const { types, reload } = useData();
  const { err, run } = useAction();
  const [opts, setOpts] = useState(f.options.join(', '));
  const usedBy = types.filter(t => t.fields.some(x => x.id === f.id)).map(t => t.name);
  return (
    <tr>
      <td><input aria-label="Field name" defaultValue={f.name} onBlur={e => e.target.value !== f.name && run(() => api('PATCH', `/fields/${f.id}`, { name: e.target.value }).then(reload))} /></td>
      <td className="cap">{f.type}</td>
      <td className="cap">{f.target}</td>
      <td>{f.type === 'select'
        ? <input aria-label="Options" value={opts} placeholder="Comma-separated options" onChange={e => setOpts(e.target.value)}
            onBlur={() => run(() => api('PATCH', `/fields/${f.id}`, { options: parseOptions(opts) }).then(reload))} />
        : <span className="muted">—</span>}
        {err && <div className="error">{err}</div>}
      </td>
      <td className="muted small">{usedBy.join(', ') || 'not in any type'}</td>
      <td><button className="danger ghost" aria-label={`Delete field ${f.name}`} onClick={() => confirm(`Delete field "${f.name}" and all its values?`) && run(() => api('DELETE', `/fields/${f.id}`).then(reload))}>Delete</button></td>
    </tr>
  );
}

function FieldsTab() {
  const { fields, reload } = useData();
  const { err, run } = useAction();
  const [d, setD] = useState({ name: '', type: 'text' as FieldType, target: 'project', options: '' });
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api('POST', '/fields', { ...d, options: parseOptions(d.options) });
      setD({ ...d, name: '', options: '' });
      await reload();
    });
  };
  return (
    <>
      <p className="muted">Fields hold structured facts about projects or tasks. Add a field to a <a href="#/settings/types">project type</a> to make it appear on projects of that type (and their sub-projects).</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>On</th><th>Options</th><th>Used By</th><th /></tr></thead>
          <tbody>{fields.map(f => <FieldRow key={f.id} f={f} />)}</tbody>
        </table>
      </div>
      <form className="card row gap wrap" onSubmit={create}>
        <strong>New Field</strong>
        <input placeholder="Name" aria-label="New field name" value={d.name} onChange={e => setD({ ...d, name: e.target.value })} />
        <select aria-label="New field type" value={d.type} onChange={e => setD({ ...d, type: e.target.value as FieldType })}>{FIELD_TYPES.map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</select>
        <select aria-label="New field target" value={d.target} onChange={e => setD({ ...d, target: e.target.value })}><option value="project">On Projects</option><option value="task">On Tasks</option><option value="both">On Projects and Tasks</option></select>
        {d.type === 'select' && <input placeholder="Options, comma-separated" aria-label="New field options" value={d.options} onChange={e => setD({ ...d, options: e.target.value })} />}
        <button className="primary">Add Field</button>
        {err && <span className="error">{err}</span>}
      </form>
    </>
  );
}

function TypesTab() {
  const { types, fields, reload } = useData();
  const { err, run } = useAction();
  const setFields = (id: number, ids: number[]) => run(() => api('PATCH', `/types/${id}`, { fieldIds: ids }).then(reload));
  const create = (name: string) => run(() => api('POST', '/types', { name }).then(reload));
  return (
    <>
      <p className="muted">A project type is a set of fields. Set a type on a parent project and its sub-projects inherit it. Project fields show on the project; task fields show on its tasks.</p>
      {err && <p className="error">{err}</p>}
      {types.map(t => {
        const ids = t.fields.map(f => f.id);
        return (
          <section key={t.id} className="card type-card">
            <div className="row between">
              <input className="h-input" aria-label="Type name" defaultValue={t.name} onBlur={e => e.target.value !== t.name && run(() => api('PATCH', `/types/${t.id}`, { name: e.target.value }).then(reload))} />
              <button className="danger ghost" onClick={() => confirm(`Delete type "${t.name}"? Projects using it lose their type; values are kept.`) && run(() => api('DELETE', `/types/${t.id}`).then(reload))}>Delete Type</button>
            </div>
            <ol className="type-fields">
              {t.fields.map((f, i) => (
                <li key={f.id} className="row gap">
                  <span className="grow">{f.name} <span className="muted small">{f.type} · on {f.target}s</span></span>
                  <button className="ghost" aria-label="Move up" disabled={i === 0} onClick={() => { const n = [...ids]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setFields(t.id, n); }}>↑</button>
                  <button className="ghost" aria-label="Move down" disabled={i === ids.length - 1} onClick={() => { const n = [...ids]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setFields(t.id, n); }}>↓</button>
                  <button className="ghost" aria-label={`Remove ${f.name}`} onClick={() => setFields(t.id, ids.filter(x => x !== f.id))}>×</button>
                </li>
              ))}
            </ol>
            <select aria-label="Add field to type" value="" onChange={e => e.target.value && setFields(t.id, [...ids, +e.target.value])}>
              <option value="">+ Add Field…</option>
              {fields.filter(f => !ids.includes(f.id)).map(f => <option key={f.id} value={f.id}>{f.name} ({f.target})</option>)}
            </select>
          </section>
        );
      })}
      <InlineAdd className="primary" label="＋ New Project Type" placeholder="Type name, e.g. Proxmox host" onSubmit={create} />
    </>
  );
}

function LabelsTab() {
  const { labels, reload } = useData();
  const { err, run } = useAction();
  const [title, setTitle] = useState('');
  return (
    <>
      {err && <p className="error">{err}</p>}
      <div className="table-wrap">
        <table>
          <tbody>
            {labels.map(l => (
              <tr key={l.id}>
                <td className="swatch-cell"><input type="color" className="swatch" aria-label="Label colour" value={l.color || '#64748b'} onChange={e => run(() => api('PATCH', `/labels/${l.id}`, { color: e.target.value }).then(reload))} /></td>
                <td><input aria-label="Label name" defaultValue={l.title} onBlur={e => e.target.value !== l.title && run(() => api('PATCH', `/labels/${l.id}`, { title: e.target.value }).then(reload))} /></td>
                <td className="swatch-cell"><button className="danger ghost" onClick={() => confirm(`Delete label "${l.title}"?`) && run(() => api('DELETE', `/labels/${l.id}`).then(reload))}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="row gap" onSubmit={e => { e.preventDefault(); run(async () => { await api('POST', '/labels', { title }); setTitle(''); await reload(); }); }}>
        <input placeholder="New label" aria-label="New label name" value={title} onChange={e => setTitle(e.target.value)} />
        <button className="primary">Add Label</button>
      </form>
    </>
  );
}

function TemplatesTab() {
  const { reload } = useData();
  const { err, run } = useAction();
  const [items, setItems] = useState<Template[]>([]);
  const load = () => get<Template[]>('/templates').then(setItems);
  useEffect(() => { load(); }, []);
  const create = (t: Template) => run(async () => {
    const p = await api<{ id: number }>('POST', `/templates/${t.id}/apply`, {});
    await reload();
    go(`p/${p.id}`);
  });
  return (
    <>
      <p className="muted">Save a task or project as a template from its <b>⋯</b> menu. Task templates appear in a project's Add Task box; project templates in a project's menu
        (New Sub-Project from Template) or here. A template keeps the content, lists, labels and field values; a project template also keeps its tasks.</p>
      {err && <p className="error">{err}</p>}
      {!items.length ? <div className="empty-state"><b>No Templates Yet</b></div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Contents</th><th /></tr></thead>
            <tbody>
              {items.map(t => (
                <tr key={t.id}>
                  <td><input aria-label="Template name" defaultValue={t.name} onBlur={e => e.target.value.trim() && e.target.value !== t.name && run(() => api('PATCH', `/templates/${t.id}`, { name: e.target.value }).then(load))} /></td>
                  <td>{t.kind === 'task' ? 'Task' : 'Project'}</td>
                  <td className="small muted">{t.kind === 'project' ? `${t.data.tasks?.length ?? 0} task(s)` : t.data.title}</td>
                  <td className="row gap">
                    {t.kind === 'project' && <button onClick={() => create(t)}>Create Project</button>}
                    <button className="danger ghost" onClick={() => confirm(`Delete template "${t.name}"?`) && run(() => api('DELETE', `/templates/${t.id}`).then(load))}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function TokensTab() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [name, setName] = useState('Claude Code');
  const { err, run } = useAction();
  const load = () => get<Token[]>('/tokens').then(setTokens);
  useEffect(() => { load(); }, []);
  const cmd = created && `claude mcp add --transport http swunja ${location.origin}/mcp --header "Authorization: Bearer ${created}"`;
  return (
    <>
      <p className="muted">Tokens let API clients and Claude Code (over MCP) act as you. A token is shown only once.</p>
      {err && <p className="error">{err}</p>}
      <form className="row gap" onSubmit={e => { e.preventDefault(); run(async () => { setCreated((await api('POST', '/tokens', { name })).token); load(); }); }}>
        <input aria-label="Token name" value={name} onChange={e => setName(e.target.value)} />
        <button className="primary">Generate Token</button>
      </form>
      {created && (
        <div className="card notice">
          <p><strong>Copy this now; it won't be shown again.</strong></p>
          <code className="block">{created}</code>
          <p>Connect Claude Code:</p>
          <code className="block">{cmd}</code>
          <button onClick={() => copy(cmd!)}>Copy Command</button>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Token</th><th>Created</th><th>Last Used</th><th /></tr></thead>
          <tbody>
            {tokens.map(t => (
              <tr key={t.id}>
                <td>{t.name}</td><td><code>{t.prefix}…</code></td>
                <td className="small">{new Date(t.created).toLocaleString()}</td>
                <td className="small">{t.last_used ? new Date(t.last_used).toLocaleString() : 'never'}</td>
                <td><button className="danger ghost" onClick={() => confirm(`Revoke "${t.name}"?`) && run(() => api('DELETE', `/tokens/${t.id}`).then(load))}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">MCP endpoint: <code>{location.origin}/mcp</code> (Streamable HTTP, bearer token).</p>
      <section className="card">
        <h2 className="card-title">Logbook Webhook</h2>
        <p className="muted">Let other tools (Watchtower, Proxmox, Home Assistant, cron jobs) write to a project's logbook. Send JSON
          <code>{'{"title", "message", "kind"}'}</code> or plain text (first line is the title). <code>kind</code> is change, incident, maintenance or observation.</p>
        <code className="block">{`curl -X POST "${location.origin}/api/hooks/log?project=server1&kind=change" \\
  -H "Authorization: Bearer YOUR_TOKEN" -H "content-type: application/json" \\
  -d '{"title":"Updated containers","message":"webapp: 1.2 -> 1.3"}'`}</code>
      </section>
    </>
  );
}

function ImportTab() {
  const { reload } = useData();
  const { err, run } = useAction();
  const [result, setResult] = useState<{ format: string; counts?: Record<string, number> } & Record<string, unknown> | null>(null);
  const [force, setForce] = useState(false);
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('force', String(force));
    const file = (e.currentTarget.elements.namedItem('zip') as HTMLInputElement).files?.[0];
    if (!file) return;
    fd.append('file', file);
    run(async () => { setResult(await api('POST', '/import', fd)); await reload(); });
  };
  const counts = result ? (result.counts ?? Object.fromEntries(Object.entries(result).filter(([, v]) => typeof v === 'number'))) as Record<string, number> : null;
  return (
    <>
      <section className="card">
        <h2 className="card-title">Export</h2>
        <p className="muted">Download everything (projects, tasks, lists, fields, logbook, maintenance, attachments and appearance) as one <code>.zip</code>.
          Your password, sessions and API tokens are never included.</p>
        <a className="btn-like primary-link" href="/api/export" download>Export Data</a>
      </section>
      <form className="card" onSubmit={submit}>
        <h2 className="card-title">Import</h2>
        <p className="muted">Upload a <b>SWunja</b> (or Samunja) export, or a <b>Vikunja</b> export (Vikunja → Settings → Export your data). Imported projects are added alongside what's already here;
          fields, project types and labels with the same name are reused.</p>
        <div className="row gap wrap">
          <input type="file" name="zip" accept=".zip" aria-label="Export zip to import" />
          <label className="check small"><input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} /> Import Again Even if Already Imported (Creates Copies)</label>
          <button className="primary">Import</button>
        </div>
        {err && <p className="error">{err}</p>}
        {result && counts && <p>Imported a {result.format === 'samunja' ? 'SWunja' : 'Vikunja'} export: {Object.entries(counts).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ') || 'nothing new'}.</p>}
      </form>
    </>
  );
}

type BackupInfo = { settings: { enabled: boolean; hour: number; keep: number }; dir: string; last: string | null; backups: { name: string; size: number; created: string }[] };

function BackupsTab() {
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const { err, run } = useAction();
  const load = () => get<BackupInfo>('/backups').then(setInfo);
  useEffect(() => { load(); }, []);
  if (!info) return null;
  const save = (patch: Partial<BackupInfo['settings']>) => run(async () => { await api('PUT', '/backups/settings', patch); await load(); });
  return (
    <>
      {err && <p className="error">{err}</p>}
      <section className="card">
        <h2 className="card-title">Automatic Backups</h2>
        <p className="muted">Each backup is one <code>.zip</code> with a consistent copy of the database and every attachment. Stored in <code>{info.dir}</code>
          {' '}(set <code>BACKUP_DIR</code> in docker-compose to put them on another disk or a NAS).</p>
        <div className="row gap wrap">
          <label className="check"><input type="checkbox" checked={info.settings.enabled} onChange={e => save({ enabled: e.target.checked })} /> Back Up Every Day</label>
          <label className="row gap small">At
            <select value={info.settings.hour} onChange={e => save({ hour: +e.target.value })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </label>
          <label className="row gap small">Keep
            <select value={info.settings.keep} onChange={e => save({ keep: +e.target.value })}>
              {[3, 7, 14, 30, 60, 90].map(n => <option key={n} value={n}>{n} Backups</option>)}
            </select>
          </label>
          <button className="primary" onClick={() => run(async () => { await api('POST', '/backups'); await load(); })}>Back Up Now</button>
        </div>
        <p className="hint">Last backup: {info.last ? new Date(info.last).toLocaleString() : 'never'}. Times are the server's local time.</p>
      </section>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Backup</th><th>Size</th><th>Created</th><th /></tr></thead>
          <tbody>
            {info.backups.map(b => (
              <tr key={b.name}>
                <td><code>{b.name}</code></td>
                <td className="small">{fileSize(b.size)}</td>
                <td className="small">{new Date(b.created).toLocaleString()}</td>
                <td className="row gap">
                  <a className="btn-like" href={`/api/backups/${b.name}/download`} download>Download</a>
                  <button className="danger ghost" onClick={() => confirm(`Delete ${b.name}?`) && run(async () => { await api('DELETE', `/backups/${b.name}`); await load(); })}>Delete</button>
                </td>
              </tr>
            ))}
            {!info.backups.length && <tr><td colSpan={4} className="muted">No backups yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="hint">To restore: stop SWunja, replace <code>samunja.db</code> (delete <code>samunja.db-wal</code> and <code>-shm</code>) and the <code>files/</code> folder in the data volume with the ones from a backup, then start it again. Each zip includes these steps.</p>
      <GoogleDriveCard />
    </>
  );
}

function AccountTab() {
  const { err, run } = useAction();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [ok, setOk] = useState(false);
  return (
    <>
      <form className="card row gap wrap" onSubmit={e => { e.preventDefault(); run(async () => { await api('POST', '/password', { current: cur, password: pw }); setOk(true); setCur(''); setPw(''); }); }}>
        <strong>Change Password</strong>
        <input type="password" placeholder="Current password" aria-label="Current password" value={cur} onChange={e => setCur(e.target.value)} />
        <input type="password" placeholder="New password (8+)" aria-label="New password" value={pw} onChange={e => setPw(e.target.value)} />
        <button className="primary">Change</button>
        {ok && <span className="muted">Password changed.</span>}
        {err && <span className="error">{err}</span>}
      </form>
      <button onClick={async () => { await api('POST', '/auth/logout'); location.reload(); }}>Log Out</button>
    </>
  );
}

function AppearanceTab() {
  const { appearance: a, setAppearance } = useData();
  const { err, run } = useAction();
  const save = (patch: Partial<Appearance>) => run(async () => setAppearance(await api<Appearance>('PUT', '/appearance', patch)));
  return (
    <>
      {err && <p className="error">{err}</p>}
      <section className="card">
        <h2 className="card-title">Theme</h2>
        <div className="theme-grid">
          {THEMES.map(t => (
            <button key={t.id} className={`theme-card ${a.theme === t.id ? 'on' : ''}`} aria-pressed={a.theme === t.id} onClick={() => save({ theme: t.id })}>
              <span className="theme-preview" style={{ background: t.swatch[0] }}>
                <span style={{ background: t.swatch[1] }} /><span style={{ background: t.swatch[1] }} /><i style={{ background: t.swatch[2] }} />
              </span>
              <span className="theme-name">{t.name}{a.theme === t.id && <Check size={14} />}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <h2 className="card-title">Accent Colour</h2>
        <div className="swatches">
          <button className={`swatch-btn default ${a.accent === null ? 'on' : ''}`} onClick={() => save({ accent: null })} title="Theme default">Auto</button>
          {ACCENTS.map(c => (
            <button key={c} className={`swatch-btn ${a.accent === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Accent ${c}`} onClick={() => save({ accent: c })}>
              {a.accent === c && <Check size={14} />}
            </button>
          ))}
          <label className="swatch-btn custom" title="Custom colour">
            <input type="color" aria-label="Custom accent colour" value={a.accent ?? '#5b4fe0'} onChange={e => save({ accent: e.target.value })} />
          </label>
        </div>
      </section>
      <section className="card">
        <h2 className="card-title">Font</h2>
        <div className="font-grid">
          {FONTS.map(f => (
            <button key={f.id} className={`font-card ${a.font === f.id ? 'on' : ''}`} aria-pressed={a.font === f.id} onClick={() => save({ font: f.id })} style={{ fontFamily: `${f.family}, system-ui` }}>
              <span className="font-sample">Aa</span>
              <span>{f.name}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <h2 className="card-title">Open Tasks</h2>
        <div className="seg">
          <button className={a.taskView === 'panel' ? 'on' : ''} aria-pressed={a.taskView === 'panel'} onClick={() => save({ taskView: 'panel' })}>In a Side Panel</button>
          <button className={a.taskView === 'page' ? 'on' : ''} aria-pressed={a.taskView === 'page'} onClick={() => save({ taskView: 'page' })}>Full Page</button>
        </div>
        <p className="hint">Either way, the button at the top of a task switches to full page.</p>
      </section>
      <p className="hint">Saved on the server, so the same look applies on every device.</p>
    </>
  );
}

export function Settings({ tab = 'appearance' }: { tab?: string }) {
  const Body = { nav: NavTab, about: AboutTab, integrations: IntegrationsTab, templates: TemplatesTab, backups: BackupsTab, appearance: AppearanceTab, fields: FieldsTab, types: TypesTab, labels: LabelsTab, tokens: TokensTab, import: ImportTab, account: AccountTab }[tab] ?? AppearanceTab;
  // panes line up with the end of the tab bar, so measure it
  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabsW, setTabsW] = useState(0);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTabsW(el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className={`settings ${tab === 'fields' ? 'wide' : ''}`} style={tabsW ? { ['--tabs-w' as string]: `${tabsW}px` } : undefined}>
      <header className="page-header">
        <nav className="crumbs"><a href="#/">Home</a></nav>
        <h1 className="page-title">Settings</h1>
      </header>
      <div className="seg tabs" role="tablist" ref={tabsRef}>
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(`settings/${k}`)}>{l}</button>)}
      </div>
      <div className="settings-body"><Body /></div>
    </div>
  );
}
