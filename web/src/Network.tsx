import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Eye, EyeOff, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { api, get, type NetworkRegister, type Subnet } from './api';
import { useData } from './App';
import { Menu, useCollapsed } from './ui';

type Named = { id: number; title: string };
const Name = ({ p }: { p: Named }) => <a href={`#/p/${p.id}`}><b>{p.title}</b></a>;
/** "a, b and c" with each project bold and linked. */
const Names = ({ list }: { list: Named[] }) => <>{list.map((p, i) => <span key={p.id}>{i ? (i === list.length - 1 ? ' and ' : ', ') : ''}<Name p={p} /></span>)}</>;
function ClashText({ c }: { c: NetworkRegister['clashes'][number] }) {
  if (c.kind === 'ip') return <span><code>{c.subject}</code> is assigned to <Names list={c.projects} /></span>;
  if (c.kind === 'port') return <span><code>{c.subject}</code> is used by <Names list={c.projects} />{c.host && <> on <Name p={c.host} /></>}</span>;
  return <span>{c.message}</span>;
}

/** A page section whose content folds away; folded sections are remembered in this browser. */
const SECTIONS = { subnets: 1, ports: 2, clients: 3 };
function Section({ id, title, folds, tools, children }: { id: keyof typeof SECTIONS; title: ReactNode; folds: ReturnType<typeof useCollapsed>; tools?: ReactNode; children: ReactNode }) {
  const open = !folds.collapsed.has(SECTIONS[id]);
  return (
    <div className="net-block">
      <div className="toolbar">
        <button className="fold-head" aria-expanded={open} onClick={() => folds.toggle(SECTIONS[id])}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<h2 className="section-head">{title}</h2>
        </button>
        {open && tools}
      </div>
      {open && children}
    </div>
  );
}

function SubnetForm({ item, onDone, onCancel }: { item?: Subnet; onDone: () => void; onCancel: () => void }) {
  const [d, setD] = useState({ name: item?.name ?? '', cidr: item?.cidr ?? '', vlan: item?.vlan?.toString() ?? '', gateway: item?.gateway ?? '' });
  const [err, setErr] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(item ? 'PATCH' : 'POST', item ? `/networks/${item.id}` : '/networks', { ...d, vlan: d.vlan ? +d.vlan : null });
      onDone();
    } catch (x) { setErr((x as Error).message); }
  };
  return (
    <form className="card net-form" onSubmit={save}>
      <label className="field"><span className="field-name">Name</span><input autoFocus value={d.name} placeholder="IoT" onChange={e => setD({ ...d, name: e.target.value })} /></label>
      <label className="field"><span className="field-name">Subnet</span><input value={d.cidr} placeholder="192.168.20.0/24" onChange={e => setD({ ...d, cidr: e.target.value })} /></label>
      <label className="field"><span className="field-name">VLAN</span><input type="number" min={1} max={4094} value={d.vlan} placeholder="20" onChange={e => setD({ ...d, vlan: e.target.value })} /></label>
      <label className="field"><span className="field-name">Gateway</span><input value={d.gateway} placeholder="192.168.20.1" onChange={e => setD({ ...d, gateway: e.target.value })} /></label>
      <div className="row gap net-form-actions">
        <button className="primary" disabled={!d.name.trim() || !d.cidr.trim()}>{item ? 'Save' : 'Add Subnet'}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

function PortForm({ onDone }: { onDone: () => void }) {
  const { projects } = useData();
  const [d, setD] = useState({ project_id: projects[0]?.id ?? 0, port: '', protocol: 'tcp', notes: '' });
  const [err, setErr] = useState('');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api('POST', '/ports', { ...d, port: +d.port }); setD({ ...d, port: '', notes: '' }); setErr(''); onDone(); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <form className="port-form" onSubmit={save}>
      <select aria-label="Project" value={d.project_id} onChange={e => setD({ ...d, project_id: +e.target.value })}>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
      <input type="number" min={1} max={65535} aria-label="Port" placeholder="Port" className="num" value={d.port} onChange={e => setD({ ...d, port: e.target.value })} />
      <select aria-label="Protocol" value={d.protocol} onChange={e => setD({ ...d, protocol: e.target.value })}><option value="tcp">TCP</option><option value="udp">UDP</option></select>
      <input aria-label="Notes" placeholder="What it is (optional)" value={d.notes} onChange={e => setD({ ...d, notes: e.target.value })} />
      <button className="primary" disabled={!d.port}><Plus size={15} />Add Port</button>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

export function NetworkPage() {
  const { projects, reload } = useData();
  const [r, setR] = useState<NetworkRegister | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const hidden = useCollapsed('smj:hidden-subnets'); // subnet ids, remembered in this browser
  const folds = useCollapsed('smj:net-folds');
  const [clashesOpen, setClashesOpen] = useState(() => { try { return localStorage.getItem('smj:clashes') !== 'hidden'; } catch { return true; } });
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => get<NetworkRegister>('/network').then(setR), []);
  useEffect(() => { load(); }, [load, projects]);
  if (!r) return null;
  const clashIds = new Set(r.clashes.flatMap(c => c.project_ids));
  const proj = (id: number | null, title: string) => id === null
    ? <span title="A UniFi client with no project">{title} <span className="pill source-pill">UniFi</span></span>
    : <a href={`#/p/${id}`} className={clashIds.has(id) ? 'clash' : ''}>{title}</a>;
  const toggleClashes = () => { setClashesOpen(!clashesOpen); try { localStorage.setItem('smj:clashes', clashesOpen ? 'hidden' : 'shown'); } catch { /* private mode */ } };
  const act = async (fn: () => Promise<unknown>) => {
    setErr(''); setBusy(true);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const q = filter.trim().toLowerCase();
  const clients = r.clients.filter(c => !q || [c.name, c.ip, c.mac, c.uplink, c.project_title ?? ''].some(v => v.toLowerCase().includes(q)));
  const shownNets = r.networks.filter(n => !hidden.collapsed.has(n.id));
  const hiddenNets = r.networks.filter(n => hidden.collapsed.has(n.id));
  return (
    <div className="page">
      <header className="page-header">
        <nav className="crumbs"><a href="#/">Home</a></nav>
        <h1 className="page-title">Network</h1>
        <p className="lede">Subnets and VLANs, which project holds which address, and the ports services publish. Addresses come from each project's
          <b> IP Address</b> field (several can be separated by commas); a port lands on the host its project <b>Runs On</b>.</p>
      </header>

      {r.clashes.length > 0 && (
        <section className="card clashes" role="alert">
          <div className="card-title-row">
            <h2 className="card-title"><AlertTriangle size={16} />{r.clashes.length} Clash{r.clashes.length > 1 ? 'es' : ''}</h2>
            <button className="ghost small" aria-expanded={clashesOpen} onClick={toggleClashes}>{clashesOpen ? <><EyeOff size={14} />Hide</> : <><Eye size={14} />Show</>}</button>
          </div>
          {clashesOpen && <ul>{r.clashes.map((c, i) => <li key={i}><span className="pill">{c.kind === 'ip' ? 'IP' : c.kind === 'port' ? 'Port' : 'Subnet'}</span><ClashText c={c} /></li>)}</ul>}
        </section>
      )}

      <Section id="subnets" title="Subnets" folds={folds} tools={<><span className="grow" /><button className="primary" onClick={() => setAdding(true)}><Plus size={15} />Add Subnet</button></>}>
      {adding && <SubnetForm onCancel={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {!r.networks.length && !adding && <div className="empty-state"><b>No Subnets Yet</b><span>Add your LAN, IoT or guest networks to see which addresses are used and which are free.</span></div>}
      <div className="subnets">
        {shownNets.map(n => editing === n.id ? <SubnetForm key={n.id} item={n} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} /> : (
          <section key={n.id} className={`card subnet ${n.addresses.length > 24 ? 'wide' : ''}`}>
            <div className="subnet-head">
              <span className="subnet-title"><b>{n.name}</b>{n.vlan !== null && <span className="pill">VLAN {n.vlan}</span>}<code>{n.cidr}</code></span>
              <button className="icon-btn" aria-label={`Hide ${n.name}`} title="Hide" onClick={() => hidden.toggle(n.id)}><EyeOff size={15} /></button>
              <Menu>
                <button onClick={() => setEditing(n.id)}>Edit</button>
                <button className="danger" onClick={async () => { if (confirm(`Delete subnet "${n.name}"? Addresses stay on their projects.`)) { await api('DELETE', `/networks/${n.id}`); load(); } }}><Trash2 size={14} />Delete</button>
              </Menu>
            </div>
            <div className="usage" title={`${n.used} of ${n.size} addresses used`}><span style={{ width: `${Math.min(100, (n.used / n.size) * 100)}%` }} /></div>
            <div className="small muted">{n.used} of {n.size} used{n.gateway && <> · gateway {n.gateway}</>}{n.next_free && <> · next free <code>{n.next_free}</code></>}</div>
            {n.addresses.length > 0 && (
              <div className="addr-list">
                {n.addresses.map((a, i) => <div key={i} className="addr-row"><code>{a.ip}</code><span>{proj(a.project_id, a.project_title)}</span></div>)}
              </div>
            )}
          </section>
        ))}
      </div>
      {hiddenNets.length > 0 && (
        <div className="hidden-subnets"><span className="muted small">Hidden:</span>
          {hiddenNets.map(n => <button key={n.id} className="pill hidden-pill" title={`Show ${n.name}`} onClick={() => hidden.toggle(n.id)}><Eye size={13} />{n.name} <code>{n.cidr}</code></button>)}
        </div>
      )}
      {r.unassigned.length > 0 && (
        <section className="card">
          <h2 className="card-title">Outside Every Subnet</h2>
          <div className="addr-list">{r.unassigned.map((a, i) => <div key={i} className="addr-row"><code>{a.ip}</code><span>{proj(a.project_id, a.project_title)}</span></div>)}</div>
        </section>
      )}
      </Section>

      <Section id="ports" title={<>Ports <span className="count">{r.ports.length}</span></>} folds={folds}>
      <PortForm onDone={load} />
      {r.ports.length > 0 && (
        <div className="table-card">
          <table className="tasks net-table">
            <thead><tr><th>Port</th><th>Project</th><th>Host</th><th>Notes</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {r.ports.map(p => (
                <tr key={p.id}>
                  <td><code>{p.port}/{p.protocol}</code></td>
                  <td>{proj(p.project_id, p.project_title)}</td>
                  <td>{p.host_id ? <>{proj(p.host_id, p.host_title!)} <span className="muted small">{p.host_ip}</span></> : <span className="muted small">No address found</span>}</td>
                  <td className="small">{p.notes}{p.source && <span className="pill source-pill" title="Filled in by an import; re-imports replace it">{p.source === 'proxmox' ? 'Proxmox' : p.source}</span>}</td>
                  <td><button className="icon-btn" aria-label="Delete port" title="Delete" onClick={() => api('DELETE', `/ports/${p.id}`).then(load)}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </Section>

      {(r.clients.length > 0 || r.clients_refreshed) && (
        <Section id="clients" title={<>UniFi Clients <span className="count">{r.clients.length}</span></>} folds={folds} tools={<>
          <span className="muted small">{r.clients_refreshed ? `Updated ${new Date(r.clients_refreshed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, every 15 minutes` : ''}</span>
          <span className="grow" />
          <label className="search"><input type="search" placeholder="Filter clients" aria-label="Filter clients" value={filter} onChange={e => setFilter(e.target.value)} /></label>
          <button disabled={busy} onClick={() => act(async () => setR(await api<NetworkRegister>('POST', '/unifi/clients/refresh')))}><RefreshCw size={14} />Refresh</button>
        </>}>
        {err && <p className="error">{err}</p>}
        <div className="table-card">
          <table className="tasks net-table">
            <thead><tr><th>Client</th><th>Address</th><th>MAC</th><th>Connection</th><th>Project</th></tr></thead>
            <tbody>
              {clients.map(c => (
                <tr key={c.key}>
                  <td><b>{c.name || <span className="muted">Unnamed</span>}</b></td>
                  <td><code>{c.ip || '—'}</code></td>
                  <td className="small muted">{c.mac}</td>
                  <td className="small">{c.type ? c.type.charAt(0) + c.type.slice(1).toLowerCase() : ''}{c.uplink && <span className="muted"> via {c.uplink}</span>}</td>
                  <td>{c.project_id ? <a href={`#/p/${c.project_id}`}>{c.project_title}</a>
                    : <button className="ghost small" disabled={busy} title="Add as a project under UniFi Network"
                        onClick={() => act(async () => { await api('POST', `/unifi/clients/${encodeURIComponent(c.key)}/add`); await reload(); await load(); })}><Plus size={14} />Add</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </Section>
      )}
    </div>
  );
}
