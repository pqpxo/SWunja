// IP register: subnets/VLANs, the addresses projects hold (their "IP Address" field) and the ports services
// publish, with clash detection. IPv4 only.
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, getProject } from './services.ts';

export type Network = { id: number; name: string; cidr: string; vlan: number | null; gateway: string; notes: string; created: string };
export type Port = { id: number; project_id: number; port: number; protocol: 'tcp' | 'udp'; notes: string; created: string };
/** project_id is null for a UniFi client that isn't linked to a project (project_title is then the client's name). */
type Address = { ip: string; project_id: number | null; project_title: string; source: 'project' | 'unifi' };
/** subject: the address, port or subnets involved; host: where a port clashes. message is the same as one sentence. */
export type Clash = { kind: 'ip' | 'port' | 'network'; message: string; subject: string; host: { id: number; title: string } | null; projects: { id: number; title: string }[]; project_ids: number[] };
type NetworkInput = { name?: string; cidr?: string; vlan?: number | null; gateway?: string; notes?: string };

export function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some(p => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}
const intToIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export function parseCidr(cidr: string): { cidr: string; first: number; size: number } | null {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(cidr.trim());
  const ip = m ? ipToInt(m[1]) : null;
  const bits = m ? +m[2] : -1;
  if (ip === null || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const first = Math.floor(ip / size) * size;
  return { cidr: `${intToIp(first)}/${bits}`, first, size };
}

function clean(d: NetworkInput, cur?: Network) {
  const name = (d.name ?? cur?.name ?? '').trim();
  if (!name) throw new HttpError(400, 'name is required');
  const parsed = parseCidr(d.cidr ?? cur?.cidr ?? '');
  if (!parsed) throw new HttpError(400, 'cidr must be an IPv4 CIDR such as 192.168.1.0/24');
  const vlan = d.vlan === undefined ? cur?.vlan ?? null : d.vlan;
  if (vlan !== null && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094)) throw new HttpError(400, 'VLAN must be 1-4094');
  const gateway = (d.gateway ?? cur?.gateway ?? '').trim();
  if (gateway && ipToInt(gateway) === null) throw new HttpError(400, 'gateway must be an IPv4 address');
  return { name, cidr: parsed.cidr, vlan, gateway, notes: d.notes ?? cur?.notes ?? '' };
}

export function getNetwork(db: DatabaseSync, id: number): Network {
  const r = db.prepare('SELECT * FROM networks WHERE id=?').get(id) as Network | undefined;
  if (!r) throw new HttpError(404, 'Network not found');
  return r;
}
export function createNetwork(db: DatabaseSync, d: NetworkInput): Network {
  const n = clean(d);
  return getNetwork(db, Number(db.prepare('INSERT INTO networks (name,cidr,vlan,gateway,notes) VALUES (?,?,?,?,?)').run(n.name, n.cidr, n.vlan, n.gateway, n.notes).lastInsertRowid));
}
export function updateNetwork(db: DatabaseSync, id: number, d: NetworkInput): Network {
  const n = clean(d, getNetwork(db, id));
  db.prepare('UPDATE networks SET name=?, cidr=?, vlan=?, gateway=?, notes=? WHERE id=?').run(n.name, n.cidr, n.vlan, n.gateway, n.notes, id);
  return getNetwork(db, id);
}
export function deleteNetwork(db: DatabaseSync, id: number) {
  getNetwork(db, id);
  db.prepare('DELETE FROM networks WHERE id=?').run(id);
}

export function createPort(db: DatabaseSync, d: { project_id?: number; port?: number; protocol?: string; notes?: string }): Port {
  if (!d.project_id) throw new HttpError(400, 'project_id is required');
  getProject(db, d.project_id);
  if (!Number.isInteger(d.port) || d.port! < 1 || d.port! > 65535) throw new HttpError(400, 'port must be 1-65535');
  const protocol = d.protocol ?? 'tcp';
  if (protocol !== 'tcp' && protocol !== 'udp') throw new HttpError(400, 'protocol must be tcp or udp');
  const id = Number(db.prepare('INSERT INTO ports (project_id,port,protocol,notes) VALUES (?,?,?,?)').run(d.project_id, d.port!, protocol, d.notes ?? '').lastInsertRowid);
  return db.prepare('SELECT * FROM ports WHERE id=?').get(id) as Port;
}
export function deletePort(db: DatabaseSync, id: number) {
  if (!db.prepare('DELETE FROM ports WHERE id=?').run(id).changes) throw new HttpError(404, 'Port not found');
}

// every project's IPs (the "IP Address" field may hold several, comma or space separated) and Runs On link
function projectNet(db: DatabaseSync) {
  const rows = db.prepare(`SELECT p.id, p.title, lower(f.name) name, fv.value FROM field_values fv JOIN fields f ON f.id=fv.field_id
    JOIN projects p ON p.id=fv.entity_id WHERE f.target='project' AND lower(f.name) IN ('ip address','runs on')`).all() as { id: number; title: string; name: string; value: string }[];
  const titles = new Map((db.prepare('SELECT id, title FROM projects').all() as { id: number; title: string }[]).map(p => [p.id, p.title]));
  const ips = new Map<number, string[]>(), runsOn = new Map<number, number>();
  for (const r of rows) {
    if (r.name === 'ip address') ips.set(r.id, r.value.split(/[\s,;]+/).filter(Boolean));
    else runsOn.set(r.id, Number(r.value));
  }
  return { ips, runsOn, titles };
}

/** Everything on the Network page: subnets with their addresses, addresses outside them, ports, and clashes. */
export function networkRegister(db: DatabaseSync) {
  const { ips, runsOn, titles } = projectNet(db);
  const clients = db.prepare(`SELECT c.*, p.title project_title FROM unifi_clients c LEFT JOIN projects p ON p.id=c.project_id ORDER BY lower(c.name), c.ip`).all() as
    { key: string; name: string; ip: string; mac: string; type: string; uplink: string; connected_at: string | null; project_id: number | null; project_title: string | null }[];
  const projectIps = new Set([...ips.values()].flat());
  // unlinked clients still take up an address (linked ones are their project)
  const clientAddrs: Address[] = clients.filter(c => c.ip && !c.project_id && !projectIps.has(c.ip)).map(c => ({ ip: c.ip, project_id: null, project_title: c.name || c.mac, source: 'unifi' }));
  const addresses: Address[] = [...[...ips].flatMap(([id, list]) => list.map(ip => ({ ip, project_id: id as number | null, project_title: titles.get(id) ?? '', source: 'project' as const }))), ...clientAddrs]
    .sort((a, b) => (ipToInt(a.ip) ?? Infinity) - (ipToInt(b.ip) ?? Infinity) || a.project_title.localeCompare(b.project_title));
  const nets = (db.prepare('SELECT * FROM networks').all() as Network[]).map(n => ({ ...n, range: parseCidr(n.cidr)! }))
    .sort((a, b) => a.range.first - b.range.first || b.range.size - a.range.size);
  const inside = (ip: string, r: { first: number; size: number }) => { const n = ipToInt(ip); return n !== null && n >= r.first && n < r.first + r.size; };
  const clashes: Clash[] = [];

  const networks = nets.map(({ range, ...n }) => {
    const mine = addresses.filter(a => inside(a.ip, range));
    const taken = new Set(mine.map(a => ipToInt(a.ip)));
    if (n.gateway) taken.add(ipToInt(n.gateway));
    const usable = range.size <= 2 ? range.size : range.size - 2;
    const start = range.size <= 2 ? range.first : range.first + 1;
    let next: string | null = null;
    for (let i = start; i < start + usable; i++) if (!taken.has(i)) { next = intToIp(i); break; }
    return { ...n, size: usable, used: new Set(mine.map(a => a.ip)).size, next_free: next, addresses: mine };
  });
  for (let i = 0; i < nets.length; i++) for (let j = i + 1; j < nets.length; j++) {
    const a = nets[i], b = nets[j];
    if (a.range.first < b.range.first + b.range.size && b.range.first < a.range.first + a.range.size)
      clashes.push({ kind: 'network', message: `${a.name} (${a.cidr}) overlaps ${b.name} (${b.cidr})`, subject: `${a.name} (${a.cidr}) overlaps ${b.name} (${b.cidr})`, host: null, projects: [], project_ids: [] });
  }

  const byIp = new Map<string, Address[]>();
  for (const a of addresses) if (a.project_id !== null) byIp.set(a.ip, [...(byIp.get(a.ip) ?? []), a]);
  for (const [ip, list] of byIp) {
    const ids = [...new Set(list.map(a => a.project_id!))];
    if (ids.length > 1) clashes.push({
      kind: 'ip', message: `${ip} is assigned to ${ids.map(id => titles.get(id)).join(' and ')}`, subject: ip, host: null,
      projects: ids.map(id => ({ id, title: titles.get(id) ?? '' })), project_ids: ids,
    });
  }

  // a port is published on the first project up the Runs On chain that has an address
  const hostOf = (id: number) => { for (let p: number | undefined = id, hops = 0; p && hops < 10; p = runsOn.get(p), hops++) if (ips.get(p)?.length) return p; return null; };
  const ports = (db.prepare('SELECT * FROM ports ORDER BY port, protocol').all() as Port[]).map(p => {
    const host = hostOf(p.project_id);
    return { ...p, project_title: titles.get(p.project_id) ?? '', host_id: host, host_title: host ? titles.get(host)! : null, host_ip: host ? ips.get(host)![0] : null };
  });
  const byPort = new Map<string, typeof ports>();
  for (const p of ports) {
    const key = `${p.host_id ?? `p${p.project_id}`}|${p.port}/${p.protocol}`;
    byPort.set(key, [...(byPort.get(key) ?? []), p]);
  }
  for (const list of byPort.values()) {
    const ids = [...new Set(list.map(p => p.project_id))];
    const host = list[0].host_id ? { id: list[0].host_id, title: list[0].host_title! } : null;
    if (list.length > 1) clashes.push({
      kind: 'port', project_ids: ids, subject: `${list[0].port}/${list[0].protocol}`, host, projects: ids.map(id => ({ id, title: titles.get(id) ?? '' })),
      message: `${list[0].port}/${list[0].protocol} is used ${list.length} times on ${list[0].host_title ?? list[0].project_title}: ${ids.map(id => titles.get(id)).join(', ')}`,
    });
  }
  return { networks, unassigned: addresses.filter(a => !nets.some(n => inside(a.ip, n.range))), ports, clashes, clients,
    clients_refreshed: (db.prepare("SELECT value FROM meta WHERE key='unifi_clients_at'").get() as { value: string } | undefined)?.value ?? null };
}
