import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from './db.ts';
import * as s from './services.ts';
import { createNetwork, networkRegister } from './network.ts';
import { addClientProject, getUnifi, listClients, refreshClients, setUnifi, unifiImport } from './unifi.ts';

const GW = '11111111-0000-0000-0000-000000000001', SW = '11111111-0000-0000-0000-000000000002', AP = '11111111-0000-0000-0000-000000000003';
const SITE = '22222222-0000-0000-0000-000000000001';
const page = (data: unknown[], offset = 0, limit = 200) => ({ offset, limit, count: data.length, totalCount: data.length, data });

/** A fake UniFi console; `prefix` is where the Integration API lives ('/proxy/network/integration' on UniFi OS). */
async function fakeUnifi(prefix: string, o: { networks?: boolean } = {}) {
  const seen: string[] = [];
  const devices = [
    { id: GW, name: 'UDM Pro', model: 'UDM Pro', ipAddress: '192.168.1.1', macAddress: 'aa:00:00:00:00:01', state: 'ONLINE', firmwareVersion: '4.1.13', firmwareUpdatable: false },
    { id: SW, name: 'Switch 24', model: 'USW 24 PoE', ipAddress: '192.168.1.2', macAddress: 'aa:00:00:00:00:02', state: 'ONLINE', firmwareVersion: '7.1.26', firmwareUpdatable: true },
    { id: AP, name: 'Lounge AP', model: 'U7 Pro', ipAddress: '192.168.1.3', macAddress: 'aa:00:00:00:00:03', state: 'OFFLINE', firmwareVersion: '8.0.1', firmwareUpdatable: false },
  ];
  const uplink: Record<string, string | undefined> = { [GW]: undefined, [SW]: GW, [AP]: SW };
  const nets = [
    { id: 'n1', name: 'Default', enabled: true, default: true, management: 'GATEWAY', vlanId: 1 },
    { id: 'n2', name: 'IoT', enabled: true, default: false, management: 'GATEWAY', vlanId: 20 },
    { id: 'n3', name: 'Lab trunk', enabled: true, default: false, management: 'UNMANAGED', vlanId: 30 },
  ];
  const ipv4: Record<string, unknown> = { n1: { hostIpAddress: '192.168.1.1', prefixLength: 24 }, n2: { hostIpAddress: '192.168.20.1', prefixLength: 24 } };
  // the client list arrives in two pages
  const clients = [
    { type: 'WIRED', id: 'c1', name: 'server2', ipAddress: '192.168.1.20', macAddress: 'bb:01', uplinkDeviceId: SW },
    { type: 'WIRED', id: 'c2', name: 'NAS', ipAddress: '192.168.1.51', macAddress: 'bb:02', uplinkDeviceId: SW },
    { type: 'WIRELESS', id: 'c3', name: "Sam's iPhone", ipAddress: '192.168.1.80', macAddress: 'bb:03', uplinkDeviceId: AP },
    { type: 'VPN', id: 'c4', name: 'laptop', ipAddress: '10.0.0.2' },
  ];
  const srv = createServer((req, res) => {
    seen.push(`${req.headers['x-api-key']} ${req.url}`);
    const send = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers['x-api-key'] !== 'key-123') return send(401, { statusCode: 401, statusName: 'UNAUTHORIZED', message: 'bad key' });
    const url = new URL(req.url!, 'http://x');
    if (!url.pathname.startsWith(`${prefix}/v1/`)) return send(404, { message: 'not found' });
    const p = url.pathname.slice(prefix.length + 3);
    const offset = +(url.searchParams.get('offset') ?? 0);
    if (p === '/info') return send(200, { applicationVersion: '10.1.84' });
    if (p === '/sites') return send(200, page([{ id: SITE, internalReference: 'default', name: 'Default' }]));
    if (p === `/sites/${SITE}/devices`) return send(200, page(devices));
    const dev = devices.find(d => p === `/sites/${SITE}/devices/${d.id}`);
    if (dev) return send(200, { ...dev, uplink: uplink[dev.id] ? { deviceId: uplink[dev.id] } : undefined });
    if (p === `/sites/${SITE}/clients`) return send(200, { offset, limit: 2, count: 2, totalCount: 4, data: clients.slice(offset, offset + 2) });
    if (o.networks !== false && p === `/sites/${SITE}/networks`) return send(200, page(nets));
    const net = o.networks !== false && nets.find(n => p === `/sites/${SITE}/networks/${n.id}`);
    if (net) return send(200, { ...net, ...(ipv4[net.id] ? { ipv4Configuration: ipv4[net.id] } : {}) });
    send(404, { message: 'not found' });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen, close: () => new Promise(r => srv.close(r)) };
}

test('UniFi import: networks into the register, devices as projects with uplinks, client addresses onto matching projects', async () => {
  const db = fresh();
  const u = await fakeUnifi('/proxy/network/integration');
  try {
    assert.throws(() => setUnifi(db, { url: 'ftp://x' }), /http/);
    setUnifi(db, { url: `${u.url}/`, api_key: 'key-123' });
    assert.deepEqual(getUnifi(db), { url: u.url, fingerprint: null, has_secret: true });

    const host = s.listTypes(db).find(t => t.name === 'Host')!.id;
    const server2 = s.createProject(db, { title: 'server2', type_id: host });
    const nas = s.createProject(db, { title: 'nas', type_id: host });
    s.setFieldValues(db, 'project', nas.id, { 'IP Address': '192.168.1.50' });
    const lan = createNetwork(db, { name: 'LAN', cidr: '192.168.1.0/24' }); // same subnet as UniFi's "Default"
    const parent = s.createProject(db, { title: 'Network' });

    const preview = await unifiImport(db, { parent_id: parent.id, dryRun: true });
    assert.equal(preview.version, '10.1.84');
    assert.deepEqual(preview.networks.map(n => [n.name, n.cidr, n.vlan, n.action]),
      [['Default', '192.168.1.0/24', 1, 'update'], ['IoT', '192.168.20.0/24', 20, 'create'], ['Lab trunk', null, 30, 'skip']]);
    assert.deepEqual(preview.devices.map(d => [d.title, d.uplink, d.action]), [['UDM Pro', null, 'create'], ['Switch 24', 'UDM Pro', 'create'], ['Lounge AP', 'Switch 24', 'create']]);
    assert.deepEqual(preview.clients.map(c => [c.project_title, c.ip, c.action, c.current]),
      [['server2', '192.168.1.20', 'fill', null], ['nas', '192.168.1.51', 'differs', '192.168.1.50']]);
    assert.equal(preview.unmatched_clients, 2);
    assert.equal(s.listProjects(db).length, 3); // nothing written
    assert.ok(u.seen.some(x => x.includes('/clients?offset=2')), 'follows pagination');

    const done = await unifiImport(db, { parent_id: parent.id });
    assert.deepEqual(done.counts, { networks: 2, devices: 3, addresses: 1 });
    const v = (title: string) => {
      const p = s.listProjects(db).find(x => x.title === title)!;
      return { p, f: Object.fromEntries(s.getProject(db, p.id).fields.map(x => [x.name, x.type === 'link' ? x.display : x.value])) };
    };
    assert.deepEqual([v('UDM Pro').p.parent_id, v('UDM Pro').f.Kind, v('UDM Pro').f['IP Address'], v('UDM Pro').f.Version, v('UDM Pro').f.Model], [parent.id, 'Device', '192.168.1.1', '4.1.13', 'UDM Pro']);
    assert.equal(v('Switch 24').f['Runs On'], 'UDM Pro');
    assert.equal(v('Lounge AP').f['Runs On'], 'Switch 24');
    assert.equal(v('server2').f['IP Address'], '192.168.1.20');
    assert.equal(v('nas').f['IP Address'], '192.168.1.50'); // a different address is reported, never overwritten

    const reg = networkRegister(db);
    const lanNow = reg.networks.find(n => n.id === lan.id)!;
    assert.deepEqual([lanNow.name, lanNow.vlan, lanNow.gateway], ['LAN', 1, '192.168.1.1']); // matched by subnet; your name kept
    assert.equal(reg.networks.find(n => n.cidr === '192.168.20.0/24')!.vlan, 20);

    // every client is kept, linked where a project matches by name
    const cl = listClients(db);
    assert.deepEqual(cl.map(c => [c.name, c.project_title]), [['laptop', null], ['NAS', 'nas'], ["Sam's iPhone", null], ['server2', 'server2']]);
    assert.equal(cl.find(c => c.name === "Sam's iPhone")!.uplink, 'Lounge AP');
    // an unlinked client still uses an address in its subnet, without being a clash
    const lanAddrs = networkRegister(db).networks.find(n => n.id === lan.id)!.addresses;
    assert.ok(lanAddrs.some(a => a.ip === '192.168.1.80' && a.project_id === null && a.source === 'unifi'));
    assert.equal(networkRegister(db).clashes.length, 0);

    const phone = addClientProject(db, 'bb:03');
    assert.equal(phone.title, "Sam's iPhone");
    const home = s.listProjects(db).find(p => p.title === 'UniFi Network')!;
    assert.equal(phone.parent_id, home.id);
    const pf = Object.fromEntries(s.getProject(db, phone.id).fields.map(x => [x.name, x.value]));
    assert.deepEqual([pf.Kind, pf['IP Address'], pf['MAC Address']], ['Device', '192.168.1.80', 'bb:03']);
    assert.throws(() => addClientProject(db, 'bb:03'), /already/);
    await refreshClients(db); // the link survives a refresh
    assert.equal(listClients(db).find(c => c.key === 'bb:03')!.project_id, phone.id);
    assert.equal(s.listProjects(db).length, 8);

    const again = await unifiImport(db, { parent_id: parent.id });
    assert.deepEqual(again.devices.map(d => d.action), ['update', 'update', 'update']);
    assert.equal(s.listProjects(db).length, 8);
    assert.equal(networkRegister(db).networks.length, 2);
  } finally { await u.close(); }
});

test('UniFi import: self-hosted path, consoles without the networks API, and a bad key', async () => {
  const db = fresh();
  const u = await fakeUnifi('/integration', { networks: false });
  try {
    setUnifi(db, { url: u.url, api_key: 'key-123' });
    const r = await unifiImport(db, { dryRun: true });
    assert.equal(r.devices.length, 3);
    assert.deepEqual(r.networks, []);
    assert.match(r.notes.join(' '), /networks.*Network 10/i);
    setUnifi(db, { url: u.url, api_key: 'wrong' });
    await assert.rejects(unifiImport(db, { dryRun: true }), /401.*API key/i);
  } finally { await u.close(); }
});

function fresh() { return openDb(':memory:'); }
