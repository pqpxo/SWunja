import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, Play, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { api, get, type Channel, type ChannelKind, type ClaudeSettings, type HealthCheck, type Update } from './api';
import { ago } from './ui';
import { useData } from './App';
import { ProxmoxCard, UnifiCard } from './Proxmox';

const STATUS = { up: 'Up', down: 'Down', unknown: 'Pending' } as const;
export const notifyHealth = () => window.dispatchEvent(new Event('smj:health'));

/** Ids of projects with a check that is down, refreshed every minute and after changes. */
export function useDownProjects() {
  const [down, setDown] = useState<Set<number>>(new Set());
  useEffect(() => {
    const load = () => get<HealthCheck[]>('/health-checks').then(l => setDown(new Set(l.filter(c => c.status === 'down').map(c => c.project_id)))).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    addEventListener('smj:health', load);
    return () => { clearInterval(t); removeEventListener('smj:health', load); };
  }, []);
  return down;
}

/** Details card section: this project's health checks and its GitHub release status. */
export function MonitorSection({ projectId }: { projectId: number }) {
  const { projects } = useData();
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [update, setUpdate] = useState<Update | null>(null);
  const [adding, setAdding] = useState(false);
  const [d, setD] = useState({ kind: 'http' as 'http' | 'tcp', target: '', every_min: 5 });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const project = projects.find(p => p.id === projectId);
  const hasGithub = !!project?.fields.some(f => f.name.toLowerCase() === 'github' && f.value);
  const load = useCallback(async () => {
    setChecks(await get<HealthCheck[]>(`/health-checks?project_id=${projectId}`));
    setUpdate((await get<Update[]>('/updates')).find(u => u.project_id === projectId) ?? null);
  }, [projectId]);
  useEffect(() => { load(); }, [load, projects]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(''); setBusy(true);
    try { await fn(); await load(); notifyHealth(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => { await api('POST', '/health-checks', { project_id: projectId, ...d }); setAdding(false); setD({ ...d, target: '' }); });
  };
  return (
    <div className="monitor">
      <span className="field-name">Health</span>
      {checks.map(c => (
        <div key={c.id} className="check-row" title={c.last_error || undefined}>
          <span className={`pill health-${c.status}`}>{STATUS[c.status]}</span>
          <span className="check-target"><span className="t" title={c.target}><code>{c.kind.toUpperCase()}</code> {c.target.replace(/^https?:\/\//, '')}</span>
            <span className="sub">{c.status === 'down' ? c.last_error : c.last_ms !== null ? `${c.last_ms} ms` : ''} · checked {ago(c.last_checked)} · every {c.every_min} min</span></span>
          <button className="icon-btn" aria-label="Check now" title="Check Now" disabled={busy} onClick={() => act(() => api('POST', `/health-checks/${c.id}/run`))}><Play size={14} /></button>
          <button className="icon-btn" aria-label="Delete check" title="Delete" onClick={() => confirm(`Stop checking ${c.target}?`) && act(() => api('DELETE', `/health-checks/${c.id}`))}><Trash2 size={14} /></button>
        </div>
      ))}
      {adding ? (
        <form className="check-form" onSubmit={add}>
          <select aria-label="Check type" value={d.kind} onChange={e => setD({ ...d, kind: e.target.value as 'http' | 'tcp' })}><option value="http">HTTP</option><option value="tcp">TCP Port</option></select>
          <input autoFocus aria-label="Target" placeholder={d.kind === 'http' ? 'http://server1:7760' : 'server1:22'} value={d.target} onChange={e => setD({ ...d, target: e.target.value })} />
          <label className="row gap small">Every<input type="number" min={1} max={1440} className="num" aria-label="Minutes between checks" value={d.every_min} onChange={e => setD({ ...d, every_min: Math.max(1, +e.target.value || 5) })} />min</label>
          <div className="row gap"><button className="primary" disabled={!d.target.trim() || busy}>Add Check</button><button type="button" onClick={() => setAdding(false)}>Cancel</button></div>
        </form>
      ) : <button className="inline-add" onClick={() => setAdding(true)}><Plus size={14} />Add Health Check</button>}
      {hasGithub && (
        <div className="update-row">
          {update?.update_available ? <a className="pill update-pill" href={update.url ?? '#'} target="_blank" rel="noreferrer"><ArrowUpCircle size={13} />{update.latest} available</a>
            : update?.latest ? <span className="small muted">Latest release {update.latest}{update.current ? '' : ' (set Version to compare)'}</span>
            : <span className="small muted">{update?.error || (update?.checked ? `No releases or tags on GitHub yet (checked ${ago(update.checked)})` : 'Release not checked yet')}</span>}
          <button className="icon-btn" aria-label="Check GitHub now" title="Check GitHub Now" disabled={busy} onClick={() => act(() => api('POST', '/updates/check', { project_id: projectId }))}><RefreshCw size={14} /></button>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

// the settings form for each channel kind: [config key, label, placeholder]
const KIND_FORM: Record<ChannelKind, { label: string; fields: [string, string, string][]; secret: string; secretRequired?: boolean }> = {
  ntfy: { label: 'ntfy', fields: [['url', 'Server', 'https://ntfy.sh'], ['topic', 'Topic', 'homelab-alerts']], secret: 'Access Token (Optional)' },
  gotify: { label: 'Gotify', fields: [['url', 'Server', 'http://gotify.lan']], secret: 'App Token', secretRequired: true },
  homeassistant: { label: 'Home Assistant', fields: [['url', 'Server', 'http://homeassistant.local:8123'], ['service', 'Service', 'notify.mobile_app_phone']], secret: 'Long-Lived Access Token', secretRequired: true },
  pushover: { label: 'Pushover', fields: [['user', 'User or Group Key', 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG']], secret: 'Application API Token', secretRequired: true },
  email: { label: 'Email (SMTP)', fields: [['host', 'SMTP Server', 'smtp.gmail.com'], ['port', 'Port (587 STARTTLS, 465 SSL)', '587'], ['user', 'Username (Optional)', ''], ['from', 'From', 'swunja@example.com'], ['to', 'To', 'you@example.com']], secret: 'SMTP Password' },
  webhook: { label: 'Webhook', fields: [['url', 'URL', 'https://example.com/hook']], secret: 'Bearer Token (Optional)' },
};
const EVENT_LABEL: Record<string, string> = { health: 'Up / Down', maintenance: 'Overdue Maintenance', update: 'New Releases', activity: 'Activity Reminders' };

function ChannelForm({ item, onDone, onCancel }: { item?: Channel; onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<ChannelKind>(item?.kind ?? 'ntfy');
  const [name, setName] = useState(item?.name ?? '');
  const [config, setConfig] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(item?.config ?? { url: 'https://ntfy.sh', service: 'persistent_notification.create', port: '587' }).map(([k, v]) => [k, String(v)])));
  const [events, setEvents] = useState<string[]>(item?.events ?? ['health', 'maintenance', 'update', 'activity']);
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState('');
  const form = KIND_FORM[kind];
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const cfg = Object.fromEntries(form.fields.map(([k]) => [k, config[k] ?? '']).filter(([, v]) => v !== ''));
    try {
      await api(item ? 'PATCH' : 'POST', item ? `/channels/${item.id}` : '/channels', { name: name || form.label, kind, config: cfg, events, secret: secret || undefined });
      onDone();
    } catch (x) { setErr((x as Error).message); }
  };
  return (
    <form className="card channel-form" onSubmit={save}>
      <div className="channel-grid">
        <label className="field"><span className="field-name">Type</span>
          <select value={kind} disabled={!!item} onChange={e => setKind(e.target.value as ChannelKind)}>
            {Object.entries(KIND_FORM).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
          </select></label>
        <label className="field"><span className="field-name">Name</span><input value={name} placeholder={form.label} onChange={e => setName(e.target.value)} /></label>
        {form.fields.map(([k, label, ph]) => (
          <label key={k} className="field"><span className="field-name">{label}</span><input value={config[k] ?? ''} placeholder={ph} onChange={e => setConfig({ ...config, [k]: e.target.value })} /></label>
        ))}
        <label className="field"><span className="field-name">{form.secret}</span>
          <input type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)}
            placeholder={item?.has_secret ? 'Saved; leave blank to keep' : form.secretRequired ? 'Required' : ''} /></label>
      </div>
      <div className="row gap wrap"><span className="field-name">Send</span>
        {Object.entries(EVENT_LABEL).map(([ev, label]) => (
          <label key={ev} className="check"><input type="checkbox" checked={events.includes(ev)} onChange={e => setEvents(e.target.checked ? [...events, ev] : events.filter(x => x !== ev))} />{label}</label>
        ))}
      </div>
      {err && <p className="error">{err}</p>}
      <div className="row gap">
        <button className="primary">{item ? 'Save' : 'Add Channel'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
        {item?.has_secret && <button type="button" className="ghost" onClick={async () => { await api('PATCH', `/channels/${item.id}`, { secret: null }).catch(x => setErr(x.message)); onDone(); }}>Forget Saved Token</button>}
      </div>
    </form>
  );
}

export function IntegrationsTab() {
  const [data, setData] = useState<{ channels: Channel[]; github_token: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [result, setResult] = useState<Record<number, string>>({});
  const [token, setToken] = useState('');
  const load = () => get('/integrations').then(setData);
  useEffect(() => { load(); }, []);
  if (!data) return null;
  const test = async (c: Channel) => {
    setResult({ ...result, [c.id]: 'Sending…' });
    const r = await api<{ ok: boolean; error?: string }>('POST', `/channels/${c.id}/test`);
    setResult(x => ({ ...x, [c.id]: r.ok ? 'Sent ✓' : `Failed: ${r.error}` }));
  };
  return (
    <>
      <section className="card">
        <h2 className="card-title">Notifications</h2>
        <p className="muted">Where alerts go: services going down and coming back, maintenance becoming overdue, and new GitHub releases.
          Tokens and passwords are stored on this server only; they're never shown again or included in exports.</p>
        {data.channels.map(c => editing === c.id ? <ChannelForm key={c.id} item={c} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} /> : (
          <div key={c.id} className="channel-row">
            <label className="check" title={c.enabled ? 'On' : 'Off'}><input type="checkbox" aria-label={`${c.name} enabled`} checked={c.enabled}
              onChange={e => api('PATCH', `/channels/${c.id}`, { enabled: e.target.checked }).then(load)} /></label>
            <span className="grow"><b>{c.name}</b> <span className="muted small">{KIND_FORM[c.kind].label} · {c.events.map(e => EVENT_LABEL[e]).join(', ') || 'nothing'}</span>
              {result[c.id] && <span className={`sub ${result[c.id].startsWith('Failed') ? 'error' : ''}`}>{result[c.id]}</span>}</span>
            <button onClick={() => test(c)}><Send size={14} />Test</button>
            <button onClick={() => setEditing(c.id)}>Edit</button>
            <button className="danger ghost" onClick={() => confirm(`Delete "${c.name}"?`) && api('DELETE', `/channels/${c.id}`).then(load)}>Delete</button>
          </div>
        ))}
        {adding ? <ChannelForm onCancel={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />
          : <button className="primary" onClick={() => setAdding(true)}><Plus size={15} />Add Channel</button>}
      </section>
      <section className="card">
        <h2 className="card-title">GitHub</h2>
        <p className="muted">Projects with a <b>GitHub</b> link are checked for new releases every 6 hours and compared with their <b>Version</b> field.
          Without a token GitHub allows 60 checks an hour, plenty for a homelab; add a read-only token if you track many repositories.</p>
        <form className="row gap wrap" onSubmit={async e => { e.preventDefault(); await api('PUT', '/integrations/github', { token }); setToken(''); load(); }}>
          <input type="password" autoComplete="new-password" aria-label="GitHub token" placeholder={data.github_token ? 'Token saved; enter a new one to replace' : 'github_pat_…'} value={token} onChange={e => setToken(e.target.value)} />
          <button className="primary" disabled={!token}>Save Token</button>
          {data.github_token && <button type="button" className="ghost" onClick={() => api('PUT', '/integrations/github', { token: null }).then(load)}>Remove Token</button>}
        </form>
      </section>
      <ClaudeCard />
      <ProxmoxCard />
      <UnifiCard />
    </>
  );
}

/** Settings → Integrations: the Anthropic API key and model used to match activity to tasks. */
function ClaudeCard() {
  const [c, setC] = useState<ClaudeSettings | null>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { get<ClaudeSettings>('/claude').then(x => { setC(x); setModel(x.model); }); }, []);
  if (!c) return null;
  const save = async (body: object) => {
    setMsg('');
    try { const x = await api<ClaudeSettings>('PUT', '/claude', body); setC(x); setModel(x.model); setKey(''); setMsg('Saved'); } catch (e) { setMsg(`Failed: ${(e as Error).message}`); }
  };
  return (
    <section className="card">
      <h2 className="card-title">Claude</h2>
      <p className="muted">Matches work on the <a href="#/activity">Activity</a> page to the right task and writes its summary. It sends file names, commands, commit messages and what you asked Claude Code for,
        with passwords and tokens masked first, plus the titles of likely tasks; never file contents. Create a key at console.anthropic.com → API Keys.</p>
      <form className="channel-grid" onSubmit={e => { e.preventDefault(); save({ key: key || undefined, model }); }}>
        <label className="field"><span className="field-name">API Key</span>
          <input type="password" autoComplete="new-password" value={key} placeholder={c.has_key ? 'Saved; leave blank to keep' : 'sk-ant-…'} onChange={e => setKey(e.target.value)} /></label>
        <label className="field"><span className="field-name">Model</span><input value={model} onChange={e => setModel(e.target.value)} /></label>
        <div className="field"><span className="field-name">&nbsp;</span><button className="primary" disabled={!key && model === c.model}>Save</button></div>
      </form>
      <div className="row gap wrap">
        <span className="muted small grow">This month: {c.usage.input.toLocaleString()} input / {c.usage.output.toLocaleString()} output tokens</span>
        {c.has_key && <button onClick={async () => { setMsg('Testing…'); const r = await api<{ ok: boolean; error?: string }>('POST', '/claude/test'); setMsg(r.ok ? 'Key works ✓' : `Failed: ${r.error}`); get<ClaudeSettings>('/claude').then(setC); }}><Send size={14} />Test</button>}
        {c.has_key && <button className="ghost" onClick={() => confirm('Remove the Claude API key? Matching falls back to word overlap.') && save({ key: null })}>Remove Key</button>}
      </div>
      {msg && <p className={msg.startsWith('Failed') ? 'error' : 'hint'}>{msg}</p>}
    </section>
  );
}
