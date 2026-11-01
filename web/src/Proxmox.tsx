import { useEffect, useState } from 'react';
import { api, get } from './api';
import { useData } from './App';

type Item = { title: string; kind: string; node: string; ips: string[]; os: string | null; status: string; ports: { port: number; protocol: string }[]; action: 'create' | 'update' };
type Result = { items: Item[]; counts: { created: number; updated: number } };
type Conn = { id: number; name: string; url: string; token_id: string; fingerprint: string | null; has_secret: boolean };

/** The server certificate SWunja remembered on first connection; forgetting it trusts whatever it sees next time. */
function Certificate({ fingerprint, onForget }: { fingerprint: string | null; onForget: () => void }) {
  if (!fingerprint) return null;
  return (
    <p className="small muted row gap wrap cert-line">
      <span>Certificate remembered: <code title={fingerprint}>{fingerprint.slice(0, 23)}…</code></span>
      <button type="button" className="ghost small" onClick={() => confirm('Forget this certificate? Only do this if you renewed it: SWunja will trust whichever certificate it sees next.') && onForget()}>Forget Certificate</button>
    </p>
  );
}

/** One Proxmox connection: its settings, preview and import. A new one (no id yet) only has the form. */
function ProxmoxConnection({ conn, onSaved, onCancel }: { conn?: Conn; onSaved: () => void; onCancel?: () => void }) {
  const { projects, reload } = useData();
  const [d, setD] = useState({ name: conn?.name ?? '', url: conn?.url ?? '', token_id: conn?.token_id ?? '' });
  const [secret, setSecret] = useState('');
  const [parent, setParent] = useState('');
  const [preview, setPreview] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setErr(''); setBusy(true);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    await api(conn ? 'PATCH' : 'POST', conn ? `/proxmox/${conn.id}` : '/proxmox', { ...d, secret: secret || undefined });
    setSecret('');
    onSaved();
  });
  const go = (dry: boolean) => run(async () => {
    const r = await api<Result>('POST', '/proxmox/import', { connection_id: conn!.id, parent_id: parent ? +parent : null, dry_run: dry });
    if (dry) { setPreview(r); setDone(null); } else { setDone(r); setPreview(null); await reload(); }
  });
  return (
    <div className="pve-conn">
      <div className="pve-conn-head">
        <b className="grow">{conn ? conn.name : 'New Connection'}</b>
        {conn && <button className="danger ghost small" onClick={() => confirm(`Remove the connection "${conn.name}"? Imported projects stay.`) && run(async () => { await api('DELETE', `/proxmox/${conn.id}`); onSaved(); })}>Remove</button>}
        {onCancel && <button className="ghost small" onClick={onCancel}>Cancel</button>}
      </div>
      <form className="channel-grid" onSubmit={e => { e.preventDefault(); save(); }}>
        <label className="field"><span className="field-name">Name</span><input value={d.name} placeholder="pve10" onChange={e => setD({ ...d, name: e.target.value })} /></label>
        <label className="field"><span className="field-name">Server</span><input value={d.url} placeholder="https://192.168.1.10:8006" onChange={e => setD({ ...d, url: e.target.value })} /></label>
        <label className="field"><span className="field-name">Token ID</span><input value={d.token_id} placeholder="root@pam!swunja" onChange={e => setD({ ...d, token_id: e.target.value })} /></label>
        <label className="field"><span className="field-name">Token Secret</span>
          <input type="password" autoComplete="new-password" value={secret} placeholder={conn?.has_secret ? 'Saved; leave blank to keep' : 'Required'} onChange={e => setSecret(e.target.value)} /></label>
        <div className="field"><span className="field-name">&nbsp;</span><button className="primary" disabled={busy || !d.url || !d.token_id}>{conn ? 'Save' : 'Add Connection'}</button></div>
      </form>
      {conn && <Certificate fingerprint={conn.fingerprint} onForget={() => run(async () => { await api('PATCH', `/proxmox/${conn.id}`, { fingerprint: null }); onSaved(); })} />}
      {conn?.has_secret && (
        <div className="row gap wrap pve-actions">
          <label className="row gap small">Put Nodes Under
            <select value={parent} onChange={e => setParent(e.target.value)}>
              <option value="">Top Level</option>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </label>
          <button disabled={busy} onClick={() => go(true)}>Preview</button>
          {preview && <button className="primary" disabled={busy} onClick={() => go(false)}>Import {preview.items.length} Item{preview.items.length === 1 ? '' : 's'}</button>}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {done && <p>Imported: {done.counts.created} created, {done.counts.updated} updated.</p>}
      {preview && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Addresses</th><th>Ports</th><th>OS</th><th>Status</th><th>Will</th></tr></thead>
            <tbody>
              {preview.items.map((i, n) => (
                <tr key={n}>
                  <td style={{ paddingLeft: i.kind === 'Physical' ? undefined : 24 }}>{i.title}</td><td>{i.kind}</td>
                  <td className="small">{i.ips.join(', ') || <span className="muted">unknown</span>}</td>
                  <td className="small">{i.ports.map(p => `${p.port}/${p.protocol}`).join(', ')}</td><td className="small">{i.os ?? ''}</td>
                  <td className="small">{i.status}</td><td><span className={`pill ${i.action === 'create' ? 'status-ok' : ''}`}>{i.action === 'create' ? 'Create' : 'Update'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Settings → Integrations card: one or more Proxmox connections. */
export function ProxmoxCard() {
  const [list, setList] = useState<Conn[]>([]);
  const [adding, setAdding] = useState(false);
  const load = () => get<Conn[]>('/proxmox').then(setList);
  useEffect(() => { load(); }, []);
  return (
    <section className="card">
      <h2 className="card-title">Proxmox</h2>
      <p className="muted">Import nodes, VMs and containers as projects, with Kind, IP Address, OS, Runs On and ports filled in. Running it again updates them rather than adding copies.
        Create an API token in Proxmox (Datacenter → Permissions → API Tokens) and give it the <b>PVEAuditor</b> role on <code>/</code>; VM addresses need the QEMU guest agent.
        Add a connection for each Proxmox server or cluster.</p>
      {list.map(c => <ProxmoxConnection key={`${c.id}-${c.name}-${c.has_secret}`} conn={c} onSaved={load} />)}
      {adding ? <ProxmoxConnection onSaved={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />
        : <button className="primary pve-add" onClick={() => setAdding(true)}>+ Add Proxmox Connection</button>}
    </section>
  );
}

type UnifiResult = {
  version: string; notes: string[]; unmatched_clients: number; counts: { networks: number; devices: number; addresses: number };
  networks: { name: string; cidr: string | null; vlan: number | null; gateway: string; action: 'create' | 'update' | 'skip' }[];
  devices: { title: string; model: string; ip: string; firmware: string | null; state: string; uplink: string | null; action: 'create' | 'update' }[];
  clients: { project_id: number; project_title: string; ip: string; current: string | null; action: 'fill' | 'same' | 'differs' }[];
};
const ACTION = { create: ['Create', 'status-ok'], update: ['Update', ''], skip: ['No Subnet', ''], fill: ['Fill In', 'status-ok'], same: ['Already Set', ''], differs: ['Differs', 'status-due-soon'] } as const;
const Act = ({ a }: { a: keyof typeof ACTION }) => <span className={`pill ${ACTION[a][1]}`}>{ACTION[a][0]}</span>;

/** Settings → Integrations card: UniFi Network connection, preview and import. */
export function UnifiCard() {
  const { projects, reload } = useData();
  const [cfg, setCfg] = useState({ url: '', fingerprint: null as string | null, has_secret: false });
  const [key, setKey] = useState('');
  const [parent, setParent] = useState('');
  const [preview, setPreview] = useState<UnifiResult | null>(null);
  const [done, setDone] = useState<UnifiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { get('/unifi').then(setCfg); }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(''); setBusy(true);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const go = (dry: boolean) => run(async () => {
    const r = await api<UnifiResult>('POST', '/unifi/import', { parent_id: parent ? +parent : null, dry_run: dry });
    if (dry) { setPreview(r); setDone(null); } else { setDone(r); setPreview(null); await reload(); }
  });
  return (
    <section className="card">
      <h2 className="card-title">UniFi Network</h2>
      <p className="muted">Bring in your networks and VLANs (into the Network page), UniFi gateways, switches and access points as projects linked by their uplinks,
        and the addresses of clients whose name matches a project. Create an API key in UniFi Network under <b>Settings → Control Plane → Integrations</b>.
        Needs UniFi Network 9 or newer (10+ for networks).</p>
      <form className="channel-grid" onSubmit={e => { e.preventDefault(); run(async () => { setCfg(await api('PUT', '/unifi', { url: cfg.url, api_key: key || undefined })); setKey(''); }); }}>
        <label className="field"><span className="field-name">Console</span><input value={cfg.url} placeholder="https://192.168.1.1" onChange={e => setCfg({ ...cfg, url: e.target.value })} /></label>
        <label className="field"><span className="field-name">API Key</span>
          <input type="password" autoComplete="new-password" value={key} placeholder={cfg.has_secret ? 'Saved; leave blank to keep' : 'Required'} onChange={e => setKey(e.target.value)} /></label>
        <div className="field"><span className="field-name">&nbsp;</span><button className="primary" disabled={busy || !cfg.url}>Save Connection</button></div>
      </form>
      <Certificate fingerprint={cfg.fingerprint} onForget={() => run(async () => setCfg(await api('PUT', '/unifi', { fingerprint: null })))} />
      {cfg.has_secret && (
        <div className="row gap wrap pve-actions">
          <label className="row gap small">Put Devices Under
            <select value={parent} onChange={e => setParent(e.target.value)}>
              <option value="">Top Level</option>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </label>
          <button disabled={busy} onClick={() => go(true)}>Preview</button>
          {preview && <button className="primary" disabled={busy} onClick={() => go(false)}>Import</button>}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {done && <p>Imported from UniFi Network {done.version}: {done.counts.networks} network(s), {done.counts.devices} device(s), {done.counts.addresses} address(es) filled in.</p>}
      {preview && <>
        <p className="small muted">UniFi Network {preview.version}. {preview.notes.join(' ')}</p>
        {preview.networks.length > 0 && <div className="table-wrap"><table>
          <thead><tr><th>Network</th><th>Subnet</th><th>VLAN</th><th>Gateway</th><th>Will</th></tr></thead>
          <tbody>{preview.networks.map((n, i) => <tr key={i}><td>{n.name}</td><td><code>{n.cidr ?? '—'}</code></td><td>{n.vlan ?? ''}</td><td className="small">{n.gateway}</td><td><Act a={n.action} /></td></tr>)}</tbody>
        </table></div>}
        <div className="table-wrap"><table>
          <thead><tr><th>Device</th><th>Model</th><th>Address</th><th>Firmware</th><th>Uplink</th><th>Will</th></tr></thead>
          <tbody>{preview.devices.map((d, i) => <tr key={i}><td>{d.title}{d.state !== 'ONLINE' && <span className="muted small"> ({d.state.toLowerCase()})</span>}</td><td className="small">{d.model}</td>
            <td className="small">{d.ip}</td><td className="small">{d.firmware}</td><td className="small">{d.uplink}</td><td><Act a={d.action} /></td></tr>)}</tbody>
        </table></div>
        {preview.clients.length > 0 && <div className="table-wrap"><table>
          <thead><tr><th>Project</th><th>UniFi Address</th><th>Project Has</th><th>Will</th></tr></thead>
          <tbody>{preview.clients.map((c, i) => <tr key={i}><td><a href={`#/p/${c.project_id}`}>{c.project_title}</a></td><td className="small">{c.ip}</td><td className="small">{c.current ?? '—'}</td><td><Act a={c.action} /></td></tr>)}</tbody>
        </table></div>}
        <p className="small muted">{preview.unmatched_clients} other client(s) don't match a project by name and are left out. Addresses that differ are only shown, never overwritten.</p>
      </>}
    </section>
  );
}
