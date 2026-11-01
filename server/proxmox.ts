// Proxmox VE import: nodes become Host projects, VMs and containers become projects under their node with
// Kind, IP Address, OS and Runs On filled in. Re-running updates what was imported instead of duplicating it.
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, attachField, createProject, getProject, setFieldValues } from './services.ts';
import { getSecret } from './notify.ts';
import { tx } from './db.ts';
import { pinnedGet } from './tlspin.ts';

// fingerprint: the server certificate's SHA-256, remembered on first connection (see tlspin.ts)
type Connection = { id: number; name: string; url: string; token_id: string; fingerprint?: string | null };
type PortSpec = { port: number; protocol: 'tcp' | 'udp'; notes: string };
export type Item = { title: string; kind: 'Physical' | 'VM' | 'LXC'; node: string; ips: string[]; os: string | null; status: string; ports: PortSpec[]; action: 'create' | 'update'; project_id: number | null };

// connections live in meta 'proxmox' (a list); each token secret in secrets 'proxmox:<id>'
const saveConnections = (db: DatabaseSync, list: Connection[]) =>
  db.prepare("INSERT INTO meta VALUES ('proxmox', ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(JSON.stringify(list));
function connections(db: DatabaseSync): Connection[] {
  const r = db.prepare("SELECT value FROM meta WHERE key='proxmox'").get() as { value: string } | undefined;
  const v = r ? JSON.parse(r.value) : [];
  if (Array.isArray(v)) return v;
  // a single connection saved before several were possible becomes connection 1
  const list = v.url ? [{ id: 1, name: 'Proxmox', url: v.url, token_id: v.token_id }] : [];
  saveConnections(db, list);
  db.prepare("UPDATE secrets SET key='proxmox:1' WHERE key='proxmox'").run();
  return list;
}
const publicView = (db: DatabaseSync, c: Connection) => ({ ...c, fingerprint: c.fingerprint ?? null, has_secret: getSecret(db, `proxmox:${c.id}`) !== null });
export const listProxmox = (db: DatabaseSync) => connections(db).map(c => publicView(db, c));

type ConnectionInput = { name?: string; url?: string; token_id?: string; secret?: string | null; fingerprint?: null };

/** A new address, or fingerprint: null (Forget Certificate), drops the remembered certificate. */
function cleanConnection(d: ConnectionInput, cur?: Connection) {
  const url = (d.url ?? cur?.url ?? '').trim().replace(/\/+$/, ''), token_id = (d.token_id ?? cur?.token_id ?? '').trim();
  if (!/^https?:\/\/[^\s/]+$/i.test(url)) throw new HttpError(400, 'url must be http(s)://host:port, e.g. https://192.168.1.10:8006');
  if (!/^[^@\s]+@[^!\s]+![^\s=]+$/.test(token_id)) throw new HttpError(400, 'token_id looks like USER@REALM!TOKENID, e.g. root@pam!swunja');
  const fingerprint = d.fingerprint === null || !cur || url !== cur.url ? null : cur.fingerprint ?? null;
  return { name: (d.name ?? cur?.name ?? '').trim() || url.replace(/^https?:\/\//, ''), url, token_id, fingerprint };
}
function putSecret(db: DatabaseSync, id: number, secret: string | null | undefined) {
  if (secret === null) db.prepare('DELETE FROM secrets WHERE key=?').run(`proxmox:${id}`);
  else if (secret) db.prepare('INSERT INTO secrets VALUES (?, ?) ON CONFLICT DO UPDATE SET value=excluded.value').run(`proxmox:${id}`, secret);
}

export function addProxmox(db: DatabaseSync, d: ConnectionInput) {
  const list = connections(db);
  const c = { id: Math.max(0, ...list.map(x => x.id)) + 1, ...cleanConnection(d) };
  saveConnections(db, [...list, c]);
  putSecret(db, c.id, d.secret);
  return publicView(db, c);
}

export function updateProxmox(db: DatabaseSync, id: number, d: ConnectionInput) {
  const list = connections(db);
  const cur = list.find(c => c.id === id);
  if (!cur) throw new HttpError(404, 'Proxmox connection not found');
  const next = { id, ...cleanConnection(d, cur) };
  saveConnections(db, list.map(c => (c.id === id ? next : c)));
  putSecret(db, id, d.secret);
  return publicView(db, next);
}

export function deleteProxmox(db: DatabaseSync, id: number) {
  const list = connections(db);
  if (!list.some(c => c.id === id)) throw new HttpError(404, 'Proxmox connection not found');
  saveConnections(db, list.filter(c => c.id !== id));
  db.prepare('DELETE FROM secrets WHERE key=?').run(`proxmox:${id}`);
}

/** The connection to use: by id or name, or the only one there is. */
export function pickConnection(db: DatabaseSync, ref?: number | string | null): Connection {
  const list = connections(db);
  if (!list.length) throw new HttpError(400, 'Add a Proxmox connection in Settings → Integrations first');
  if (ref === undefined || ref === null || ref === '') {
    if (list.length > 1) throw new HttpError(400, `Say which Proxmox connection: ${list.map(c => c.name).join(', ')}`);
    return list[0];
  }
  const hit = list.find(c => c.id === Number(ref) || c.name.toLowerCase() === String(ref).toLowerCase());
  if (!hit) throw new HttpError(404, `No Proxmox connection "${ref}"`);
  return hit;
}

// Proxmox ships a self-signed certificate: it is pinned on first use instead of checked against a CA
async function pveGet(db: DatabaseSync, cfg: Connection, auth: string, path: string): Promise<any> {
  let r;
  try {
    r = await pinnedGet(`${cfg.url}/api2/json${path}`, { authorization: auth }, cfg.fingerprint ?? null);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Can't reach Proxmox at ${cfg.url}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  if (r.status === 401) throw new HttpError(502, 'Proxmox said 401: check the API token ID and secret');
  if (r.status === 403) throw new HttpError(502, `Proxmox said 403 for ${path}: give the token PVEAuditor on /`);
  if (r.status >= 300) throw new HttpError(502, `Proxmox said ${r.status} for ${path}`);
  if (r.fingerprint && !cfg.fingerprint) {
    cfg.fingerprint = r.fingerprint;
    saveConnections(db, connections(db).map(c => (c.id === cfg.id ? { ...c, fingerprint: r.fingerprint } : c)));
  }
  try { return JSON.parse(r.text).data; } catch { throw new HttpError(502, `Proxmox sent something unexpected for ${path}`); }
}

const OS: [RegExp, string][] = [[/^debian/, 'Debian'], [/^ubuntu/, 'Ubuntu'], [/^(win|w2k|wxp|wvista)/, 'Windows']];
const osName = (ostype?: string) => OS.find(([re]) => re.test(ostype ?? ''))?.[1] ?? null;
// docker0 / br-xxxx (172.17.0.1 in every Docker LXC), veth, CNI and VPN-less virtual bridges
const VIRTUAL = /^(lo|docker\d*|br-[0-9a-f]+|veth|cni|flannel|cali|kube|virbr|podman|lxcbr|lxdbr)/i;
const real = <T extends { name?: string }>(ifaces: T[]) => ifaces.filter(i => !VIRTUAL.test(i.name ?? ''));
// Proxmox can't see what a guest listens on; it knows its own web UI and SSH, and the ports a guest's firewall lets in
const NODE_PORTS: PortSpec[] = [{ port: 8006, protocol: 'tcp', notes: 'Proxmox web UI' }, { port: 22, protocol: 'tcp', notes: 'SSH' }];
const MACROS: Record<string, [number, ('tcp' | 'udp')[]][]> = {
  SSH: [[22, ['tcp']]], HTTP: [[80, ['tcp']]], HTTPS: [[443, ['tcp']]], DNS: [[53, ['tcp', 'udp']]], SMTP: [[25, ['tcp']]], SMTPS: [[465, ['tcp']]],
  IMAP: [[143, ['tcp']]], IMAPS: [[993, ['tcp']]], MySQL: [[3306, ['tcp']]], PostgreSQL: [[5432, ['tcp']]], SMB: [[445, ['tcp']]], NFS: [[2049, ['tcp', 'udp']]],
  RDP: [[3389, ['tcp']]], VNC: [[5900, ['tcp']]], Syslog: [[514, ['udp']]], NTP: [[123, ['udp']]], DHCPfwd: [[67, ['udp']]], Ceph: [[6789, ['tcp']]],
};
type Rule = { type?: string; action?: string; enable?: number; proto?: string; dport?: string; macro?: string; comment?: string };
export function firewallPorts(rules: Rule[]): PortSpec[] {
  const out = new Map<string, PortSpec>();
  const add = (port: number, protocol: 'tcp' | 'udp', notes: string) => { if (port >= 1 && port <= 65535) out.set(`${port}/${protocol}`, { port, protocol, notes }); };
  for (const r of rules) {
    if (r.type !== 'in' || r.action !== 'ACCEPT' || r.enable === 0) continue;
    const notes = r.comment ?? r.macro ?? '';
    if (r.macro && MACROS[r.macro]) { for (const [port, protos] of MACROS[r.macro]) for (const p of protos) add(port, p, notes); continue; }
    if (!r.dport) continue;
    const protos: ('tcp' | 'udp')[] = r.proto === 'udp' ? ['udp'] : r.proto === 'tcp' || !r.proto ? ['tcp'] : [];
    for (const part of r.dport.split(',')) {
      const [a, b] = part.split(':').map(Number);
      // ponytail: ranges wider than 16 ports are skipped rather than listed one by one
      for (let p = a; p <= (b || a) && (b || a) - a < 16; p++) for (const pr of protos) add(p, pr, notes);
    }
  }
  return [...out.values()].sort((x, y) => x.port - y.port || x.protocol.localeCompare(y.protocol));
}

const v4 = (ips: string[]) => [...new Set(ips.map(ip => ip.split('/')[0]).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('127.')))];

/** What Proxmox has, in import order (each node followed by its guests). Per-guest lookups that fail just leave gaps. */
async function inventory(db: DatabaseSync, cfg: Connection) {
  const secret = getSecret(db, `proxmox:${cfg.id}`);
  if (!secret) throw new HttpError(400, `Add the token secret for ${cfg.name} in Settings → Integrations first`);
  const get = (path: string) => pveGet(db, cfg, `PVEAPIToken=${cfg.token_id}=${secret}`, path);
  const soft = (path: string) => get(path).catch(() => null);
  const nodes = (await get('/nodes')) as { node: string; status: string }[];
  const guests = ((await get('/cluster/resources?type=vm')) as { vmid: number; name: string; node: string; type: string; status: string; template?: number }[])
    .filter(g => !g.template).sort((a, b) => a.vmid - b.vmid);
  const out: Omit<Item, 'action' | 'project_id'>[] = [];
  for (const n of [...nodes].sort((a, b) => a.node.localeCompare(b.node))) {
    const net = ((await soft(`/nodes/${n.node}/network`)) ?? []) as { address?: string; type?: string }[];
    out.push({ title: n.node, kind: 'Physical', node: n.node, ips: v4(net.sort((a, b) => (a.type === 'bridge' ? 0 : 1) - (b.type === 'bridge' ? 0 : 1)).map(i => i.address ?? '')), os: 'Proxmox', status: n.status, ports: NODE_PORTS });
    for (const g of guests.filter(x => x.node === n.node)) {
      const base = `/nodes/${n.node}/${g.type}/${g.vmid}`;
      const config = (await soft(`${base}/config`)) as { ostype?: string } | null;
      let ips: string[] = [];
      if (g.type === 'lxc') ips = v4(real(((await soft(`${base}/interfaces`)) ?? []) as { name?: string; inet?: string }[]).map(i => i.inet ?? ''));
      else if (g.status === 'running') { // needs the QEMU guest agent
        const agent = (await soft(`${base}/agent/network-get-interfaces`)) as { result?: { name?: string; 'ip-addresses'?: { 'ip-address': string }[] }[] } | null;
        ips = v4(real(agent?.result ?? []).flatMap(i => (i['ip-addresses'] ?? []).map(a => a['ip-address'])));
      }
      const ports = firewallPorts(((await soft(`${base}/firewall/rules`)) ?? []) as Rule[]);
      out.push({ title: g.name || `${g.type}-${g.vmid}`, kind: g.type === 'lxc' ? 'LXC' : 'VM', node: n.node, ips, os: osName(config?.ostype), status: g.status, ports });
    }
  }
  return out;
}

const children = (db: DatabaseSync, parent: number | null) =>
  db.prepare(`SELECT id, title FROM projects WHERE ${parent === null ? 'parent_id IS NULL' : 'parent_id=?'}`).all(...(parent === null ? [] : [parent])) as { id: number; title: string }[];
const match = (list: { id: number; title: string }[], title: string) => list.find(p => p.title.toLowerCase() === title.toLowerCase())?.id ?? null;
// not under the expected parent: a single project with that name elsewhere is still the same machine (updated where it is)
export function find(db: DatabaseSync, under: number | null | undefined, title: string) {
  const local = under === undefined ? null : match(children(db, under), title);
  if (local) return local;
  const all = db.prepare('SELECT id FROM projects WHERE lower(title)=lower(?)').all(title) as { id: number }[];
  return all.length === 1 ? all[0].id : null;
}

// sets a project field, adding the field to the project first when its type doesn't have it; bad values are skipped
export function setField(db: DatabaseSync, id: number, name: string, value: string | number) {
  try { setFieldValues(db, 'project', id, { [name]: value }); return; } catch { /* not on this project yet */ }
  try { attachField(db, 'project', id, name); setFieldValues(db, 'project', id, { [name]: value }); } catch { /* value not allowed here */ }
}

/** Imports (or with dryRun, previews) the Proxmox inventory under parent_id (top level when omitted). */
export async function proxmoxImport(db: DatabaseSync, o: { connection?: number | string | null; parent_id?: number | null; dryRun?: boolean } = {}) {
  const parent = o.parent_id ?? null;
  if (parent !== null) getProject(db, parent);
  const inv = await inventory(db, pickConnection(db, o.connection));
  const hostType = (db.prepare("SELECT id FROM project_types WHERE lower(name)='host'").get() as { id: number } | undefined)?.id ?? null;
  const nodeIds = new Map<string, number | null>();
  const items: Item[] = inv.map(i => {
    const under = i.kind === 'Physical' ? parent : nodeIds.get(i.node) ?? undefined; // a new node has no children yet
    const id = find(db, under, i.title);
    if (i.kind === 'Physical') nodeIds.set(i.node, id);
    return { ...i, action: id ? 'update' : 'create', project_id: id };
  });
  if (o.dryRun) return { items, counts: { created: items.filter(i => i.action === 'create').length, updated: items.filter(i => i.action === 'update').length } };

  return tx(db, () => {
    const nodes = new Map<string, number>();
    for (const i of items) {
      let id = i.project_id;
      if (i.kind === 'Physical') {
        if (!id) id = createProject(db, { title: i.title, parent_id: parent, type_id: hostType }).id;
        else if (getProject(db, id).effective_type_id === null && hostType) db.prepare('UPDATE projects SET type_id=? WHERE id=?').run(hostType, id);
        nodes.set(i.node, id);
      } else {
        const node = nodes.get(i.node)!;
        id ??= find(db, node, i.title) ?? createProject(db, { title: i.title, parent_id: node }).id;
        setField(db, id, 'Runs On', node);
      }
      i.project_id = id;
      setField(db, id, 'Kind', i.kind);
      if (i.ips.length) setField(db, id, 'IP Address', i.ips.join(', ')); // replaces what an earlier import found
      if (i.os) setField(db, id, 'OS', i.os);
      // imported ports are replaced each time; ones you added by hand stay
      db.prepare("DELETE FROM ports WHERE project_id=? AND source='proxmox'").run(id);
      for (const p of i.ports) db.prepare("INSERT INTO ports (project_id,port,protocol,notes,source) VALUES (?,?,?,?,'proxmox')").run(id, p.port, p.protocol, p.notes);
    }
    return { items, counts: { created: items.filter(i => i.action === 'create').length, updated: items.filter(i => i.action === 'update').length } };
  });
}
