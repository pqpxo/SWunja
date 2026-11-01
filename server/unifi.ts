// UniFi Network import through the official Integration API (X-API-KEY): networks/VLANs into the IP register,
// UniFi devices as projects linked by their uplinks, and client addresses onto projects with the same name.
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, createField, createProject, getProject, listFields } from './services.ts';
import { getSecret } from './notify.ts';
import { createNetwork, parseCidr, updateNetwork, type Network } from './network.ts';
import { find, setField } from './proxmox.ts';
import { tx } from './db.ts';
import { pinnedGet } from './tlspin.ts';

type Page<T> = { offset: number; limit: number; count: number; totalCount: number; data: T[] };
type Device = { id: string; name: string; model: string; ipAddress: string; state: string; firmwareVersion?: string; uplink?: { deviceId?: string } };
type Client = { id: string; name: string; type: string; ipAddress?: string; macAddress?: string; uplinkDeviceId?: string; connectedAt?: string };
export type StoredClient = { key: string; name: string; ip: string; mac: string; type: string; uplink: string; connected_at: string | null; project_id: number | null; project_title: string | null };
type UNetwork = { id: string; name: string; vlanId: number; management: string; ipv4Configuration?: { hostIpAddress: string; prefixLength: number } };

// meta 'unifi' holds the address and the console certificate's fingerprint, remembered on first connection (see tlspin.ts)
export function getUnifi(db: DatabaseSync) {
  const r = db.prepare("SELECT value FROM meta WHERE key='unifi'").get() as { value: string } | undefined;
  const v = r ? JSON.parse(r.value) : {};
  return { url: (v.url ?? '') as string, fingerprint: (v.fingerprint ?? null) as string | null, has_secret: getSecret(db, 'unifi') !== null };
}
const saveUnifi = (db: DatabaseSync, url: string, fingerprint: string | null) =>
  db.prepare("INSERT INTO meta VALUES ('unifi', ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(JSON.stringify({ url, fingerprint }));

/** A new address, or fingerprint: null (Forget Certificate), drops the remembered certificate. */
export function setUnifi(db: DatabaseSync, d: { url?: string; api_key?: string | null; fingerprint?: null }) {
  const cur = getUnifi(db);
  const url = (d.url ?? cur.url).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/i.test(url)) throw new HttpError(400, 'url must be http(s)://console-address, e.g. https://192.168.1.1');
  saveUnifi(db, url, d.fingerprint === null || url !== cur.url ? null : cur.fingerprint);
  if (d.api_key === null) db.prepare("DELETE FROM secrets WHERE key='unifi'").run();
  else if (d.api_key) db.prepare("INSERT INTO secrets VALUES ('unifi', ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(d.api_key);
  return getUnifi(db);
}

// consoles use a self-signed certificate: it is pinned on first use instead of checked against a CA
async function getJson(db: DatabaseSync, url: string, key: string): Promise<{ status: number; body: any }> {
  const { url: base, fingerprint } = getUnifi(db);
  let r;
  try {
    r = await pinnedGet(url, { 'x-api-key': key, accept: 'application/json' }, fingerprint);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Can't reach UniFi at ${base}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  if (r.fingerprint && !fingerprint && r.status === 200) saveUnifi(db, base, r.fingerprint);
  let body = null;
  try { body = JSON.parse(r.text); } catch { /* not JSON */ }
  return { status: r.status, body };
}

/** A client for whichever API path the console answers on (UniFi OS consoles proxy it; the self-hosted app doesn't). */
async function connect(db: DatabaseSync) {
  const { url } = getUnifi(db), key = getSecret(db, 'unifi');
  if (!url || !key) throw new HttpError(400, 'Set the UniFi console address and API key in Settings → Integrations first');
  for (const prefix of ['/proxy/network/integration/v1', '/integration/v1']) {
    const info = await getJson(db, `${url}${prefix}/info`, key);
    if (info.status === 401 || info.status === 403) throw new HttpError(502, `UniFi said ${info.status}: check the API key (UniFi Network → Settings → Control Plane → Integrations)`);
    if (info.status !== 200) continue;
    const get = async (path: string) => {
      const r = await getJson(db, `${url}${prefix}${path}`, key);
      if (r.status !== 200) throw Object.assign(new HttpError(502, `UniFi said ${r.status} for ${path}${r.body?.message ? `: ${r.body.message}` : ''}`), { upstream: r.status });
      return r.body;
    };
    const all = async <T>(path: string) => { // follows offset/limit pages
      const out: T[] = [];
      for (let offset = 0; ;) {
        const p = (await get(`${path}?offset=${offset}&limit=200`)) as Page<T>;
        out.push(...p.data);
        offset += p.data.length;
        if (!p.data.length || offset >= p.totalCount) return out;
      }
    };
    return { version: String(info.body?.applicationVersion ?? ''), get, all };
  }
  throw new HttpError(502, `No UniFi Network API at ${url}: use the console's address (e.g. https://192.168.1.1), and UniFi Network 9 or newer`);
}

/**
 * Replaces the client cache. A client stays linked to the project it was linked to; otherwise it is linked by name,
 * or by being the only project holding its address.
 */
export function storeClients(db: DatabaseSync, clients: Client[], devices: { id: string; name: string }[]) {
  const deviceName = new Map(devices.map(d => [d.id, d.name]));
  const kept = new Map((db.prepare('SELECT key, project_id FROM unifi_clients WHERE project_id IS NOT NULL').all() as { key: string; project_id: number }[]).map(r => [r.key, r.project_id]));
  const byIp = new Map<string, number[]>();
  for (const r of db.prepare(`SELECT fv.entity_id id, fv.value FROM field_values fv JOIN fields f ON f.id=fv.field_id WHERE f.target='project' AND lower(f.name)='ip address'`).all() as { id: number; value: string }[])
    for (const ip of r.value.split(/[\s,;]+/).filter(Boolean)) byIp.set(ip, [...(byIp.get(ip) ?? []), r.id]);
  const devNames = new Set(devices.map(d => d.name.toLowerCase()));
  tx(db, () => {
    db.prepare('DELETE FROM unifi_clients').run();
    const ins = db.prepare('INSERT OR REPLACE INTO unifi_clients (key,name,ip,mac,type,uplink,connected_at,project_id) VALUES (?,?,?,?,?,?,?,?)');
    for (const c of clients) {
      const key = c.macAddress || c.id;
      const ipOwners = c.ipAddress ? [...new Set(byIp.get(c.ipAddress) ?? [])] : [];
      const project = kept.get(key) ?? (c.name && !devNames.has(c.name.toLowerCase()) ? find(db, undefined, c.name) : null) ?? (ipOwners.length === 1 ? ipOwners[0] : null);
      ins.run(key, c.name ?? '', c.ipAddress ?? '', c.macAddress ?? '', c.type ?? '', c.uplinkDeviceId ? deviceName.get(c.uplinkDeviceId) ?? '' : '', c.connectedAt ?? null, project);
    }
    db.prepare("INSERT INTO meta VALUES ('unifi_clients_at', ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(new Date().toISOString());
  });
}

export const listClients = (db: DatabaseSync): StoredClient[] =>
  db.prepare(`SELECT c.*, p.title project_title FROM unifi_clients c LEFT JOIN projects p ON p.id=c.project_id ORDER BY lower(c.name), c.ip`).all() as StoredClient[];
export const clientsRefreshed = (db: DatabaseSync) => (db.prepare("SELECT value FROM meta WHERE key='unifi_clients_at'").get() as { value: string } | undefined)?.value ?? null;

/** Fetches the client list again (every site), without touching projects. */
export async function refreshClients(db: DatabaseSync) {
  const api = await connect(db);
  const clients: Client[] = [], devices: Device[] = [];
  for (const site of await api.all<{ id: string }>('/sites')) {
    devices.push(...await api.all<Device>(`/sites/${site.id}/devices`));
    clients.push(...await api.all<Client>(`/sites/${site.id}/clients`));
  }
  storeClients(db, clients, devices);
  return listClients(db);
}

/** Background job: refresh clients every 15 minutes once UniFi is set up. */
export async function refreshClientsIfDue(db: DatabaseSync, now = Date.now()) {
  if (!getUnifi(db).has_secret) return;
  const last = clientsRefreshed(db);
  if (last && Date.parse(last) + 15 * 60_000 > now) return;
  db.prepare("INSERT INTO meta VALUES ('unifi_clients_at', ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(new Date(now).toISOString()); // no retry storm when unreachable
  await refreshClients(db);
}

/** The "+" on the Network page: a project for a client, under a "UniFi Network" project. */
export function addClientProject(db: DatabaseSync, key: string) {
  const c = db.prepare('SELECT * FROM unifi_clients WHERE key=?').get(key) as StoredClient | undefined;
  if (!c) throw new HttpError(404, 'UniFi client not found; refresh the list');
  if (c.project_id) throw new HttpError(400, 'That client already has a project');
  return tx(db, () => {
    const parent = find(db, null, 'UniFi Network') ?? createProject(db, { title: 'UniFi Network' }).id;
    const p = createProject(db, { title: c.name || c.ip || c.mac, parent_id: parent });
    if (!listFields(db, 'project').some(f => f.name.toLowerCase() === 'mac address')) createField(db, { name: 'MAC Address', type: 'text', target: 'project' });
    setField(db, p.id, 'Kind', 'Device');
    if (c.ip) setField(db, p.id, 'IP Address', c.ip);
    if (c.mac) setField(db, p.id, 'MAC Address', c.mac);
    db.prepare('UPDATE unifi_clients SET project_id=? WHERE key=?').run(p.id, key);
    return getProject(db, p.id);
  });
}

/** Imports (or with dryRun, previews) every site; UniFi devices go under parent_id. */
export async function unifiImport(db: DatabaseSync, o: { parent_id?: number | null; dryRun?: boolean } = {}) {
  const parent = o.parent_id ?? null;
  if (parent !== null) getProject(db, parent);
  const api = await connect(db);
  const notes: string[] = [];
  const devices: Device[] = [], clients: Client[] = [], unets: UNetwork[] = [];
  for (const site of await api.all<{ id: string; name: string }>('/sites')) {
    const base = `/sites/${site.id}`;
    for (const d of await api.all<Device>(`${base}/devices`)) devices.push({ ...d, uplink: ((await api.get(`${base}/devices/${d.id}`)) as Device).uplink });
    clients.push(...await api.all<Client>(`${base}/clients`));
    try {
      for (const n of await api.all<UNetwork>(`${base}/networks`)) unets.push(n.management === 'UNMANAGED' ? n : await api.get(`${base}/networks/${n.id}`));
    } catch (e) {
      if ((e as { upstream?: number }).upstream !== 404) throw e;
      if (!notes.length) notes.push('This UniFi Network version doesn\'t share networks through its API (that needs UniFi Network 10 or newer), so subnets were skipped.');
    }
  }

  // networks: matched to the register by subnet, then by name; your names are kept
  const existing = db.prepare('SELECT * FROM networks').all() as Network[];
  const networks = unets.map(n => {
    const c = n.ipv4Configuration ? parseCidr(`${n.ipv4Configuration.hostIpAddress}/${n.ipv4Configuration.prefixLength}`) : null;
    const hit = c ? existing.find(x => x.cidr === c.cidr) ?? existing.find(x => x.name.toLowerCase() === n.name.toLowerCase()) : undefined;
    return { name: n.name, cidr: c?.cidr ?? null, vlan: n.vlanId ?? null, gateway: n.ipv4Configuration?.hostIpAddress ?? '', action: !c ? 'skip' as const : hit ? 'update' as const : 'create' as const, network_id: hit?.id ?? null };
  });
  const byId = new Map(devices.map(d => [d.id, d]));
  const deviceItems = devices.map(d => {
    const id = find(db, parent, d.name);
    return { title: d.name, model: d.model, ip: d.ipAddress, firmware: d.firmwareVersion ?? null, state: d.state,
      uplink: d.uplink?.deviceId ? byId.get(d.uplink.deviceId)?.name ?? null : null, action: id ? 'update' as const : 'create' as const, project_id: id };
  });
  // clients only fill in projects you already have (matched by name); a different address is shown, never overwritten
  const ipOf = db.prepare(`SELECT fv.value FROM field_values fv JOIN fields f ON f.id=fv.field_id WHERE f.target='project' AND lower(f.name)='ip address' AND fv.entity_id=?`);
  const deviceNames = new Set(devices.map(d => d.name.toLowerCase()));
  const clientItems: { project_id: number; project_title: string; ip: string; current: string | null; action: 'fill' | 'same' | 'differs' }[] = [];
  let unmatched = 0;
  for (const c of clients) {
    const pid = c.ipAddress && c.name && !deviceNames.has(c.name.toLowerCase()) ? find(db, undefined, c.name) : null;
    if (!pid) { unmatched++; continue; }
    const current = (ipOf.get(pid) as { value: string } | undefined)?.value ?? null;
    const list = current?.split(/[\s,;]+/) ?? [];
    clientItems.push({ project_id: pid, project_title: getProject(db, pid).title, ip: c.ipAddress!, current, action: !current ? 'fill' : list.includes(c.ipAddress!) ? 'same' : 'differs' });
  }
  if (!o.dryRun) storeClients(db, clients, devices);
  const result = { version: api.version, notes, networks, devices: deviceItems, clients: clientItems, unmatched_clients: unmatched };
  const counts = { networks: networks.filter(n => n.action !== 'skip').length, devices: deviceItems.length, addresses: clientItems.filter(c => c.action === 'fill').length };
  if (o.dryRun) return { ...result, counts };

  return tx(db, () => {
    for (const n of networks) {
      if (n.action === 'update') updateNetwork(db, n.network_id!, { vlan: n.vlan, gateway: n.gateway });
      else if (n.action === 'create') n.network_id = createNetwork(db, { name: n.name, cidr: n.cidr!, vlan: n.vlan, gateway: n.gateway }).id;
    }
    if (!listFields(db, 'project').some(f => f.name.toLowerCase() === 'model')) createField(db, { name: 'Model', type: 'text', target: 'project' });
    const projectOf = new Map<string, number>();
    for (const d of deviceItems) {
      const id = d.project_id ?? createProject(db, { title: d.title, parent_id: parent }).id;
      d.project_id = id;
      projectOf.set(d.title, id);
      setField(db, id, 'Kind', 'Device');
      setField(db, id, 'Model', d.model);
      if (d.ip) setField(db, id, 'IP Address', d.ip);
      if (d.firmware) setField(db, id, 'Version', d.firmware);
    }
    for (const d of deviceItems) if (d.uplink && projectOf.has(d.uplink)) setField(db, d.project_id!, 'Runs On', projectOf.get(d.uplink)!);
    for (const c of clientItems) if (c.action === 'fill') setField(db, c.project_id, 'IP Address', c.ip);
    return { ...result, counts };
  });
}
