import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from './db.ts';
import * as s from './services.ts';
import { createNetwork, createPort, deleteNetwork, networkRegister, parseCidr, updateNetwork } from './network.ts';
import { addProxmox, deleteProxmox, firewallPorts, listProxmox, proxmoxImport, updateProxmox } from './proxmox.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fresh = () => openDb(':memory:');
const hostType = (db: ReturnType<typeof fresh>) => s.listTypes(db).find(t => t.name === 'Host')!.id;
const appType = (db: ReturnType<typeof fresh>) => s.listTypes(db).find(t => t.name === 'Application')!.id;

test('CIDR parsing normalises the network address', () => {
  assert.deepEqual(parseCidr('192.168.1.7/24'), { cidr: '192.168.1.0/24', first: 0xc0a80100, size: 256 });
  assert.equal(parseCidr('10.0.0.0/8')!.size, 16777216);
  assert.equal(parseCidr('192.168.1.0/33'), null);
  assert.equal(parseCidr('300.1.1.1/24'), null);
  assert.equal(parseCidr('nonsense'), null);
});

test('network register: subnets, usage, next free address, IP / port / overlap clashes', () => {
  const db = fresh();
  const lan = createNetwork(db, { name: 'LAN', cidr: '192.168.1.0/24', vlan: 1, gateway: '192.168.1.1' });
  assert.equal(lan.cidr, '192.168.1.0/24');
  assert.throws(() => createNetwork(db, { name: 'x', cidr: 'bad' }), /CIDR/);
  assert.throws(() => createNetwork(db, { name: 'x', cidr: '10.0.0.0/24', vlan: 5000 }), /VLAN/);
  const iot = createNetwork(db, { name: 'IoT', cidr: '192.168.20.0/24', vlan: 20 });

  const server2 = s.createProject(db, { title: 'server2', type_id: hostType(db) });
  s.setFieldValues(db, 'project', server2.id, { 'IP Address': '192.168.1.20' });
  const nas = s.createProject(db, { title: 'nas', type_id: hostType(db) });
  s.setFieldValues(db, 'project', nas.id, { 'IP Address': '192.168.1.20, 192.168.20.5' }); // duplicate of server2
  const plug = s.createProject(db, { title: 'plug', type_id: hostType(db) });
  s.setFieldValues(db, 'project', plug.id, { 'IP Address': '10.9.9.9' }); // outside every subnet

  // apps on server2 publish ports on server2's address (found through Runs On)
  const a = s.createProject(db, { title: 'Samunja', type_id: appType(db) });
  s.setFieldValues(db, 'project', a.id, { 'Runs On': server2.id });
  const b = s.createProject(db, { title: 'Other', type_id: appType(db) });
  s.setFieldValues(db, 'project', b.id, { 'Runs On': 'server2' });
  createPort(db, { project_id: a.id, port: 7760, protocol: 'tcp' });
  createPort(db, { project_id: b.id, port: 7760, protocol: 'tcp' });
  createPort(db, { project_id: b.id, port: 7760, protocol: 'udp' }); // different protocol: fine
  createPort(db, { project_id: nas.id, port: 7760, protocol: 'tcp' }); // a different host: fine
  assert.throws(() => createPort(db, { project_id: a.id, port: 70000, protocol: 'tcp' }), /port/);

  const r = networkRegister(db);
  const l = r.networks.find(n => n.id === lan.id)!;
  assert.deepEqual(l.addresses.map(x => [x.ip, x.project_title]), [['192.168.1.20', 'nas'], ['192.168.1.20', 'server2']]);
  assert.equal(l.size, 254);
  assert.equal(l.used, 1);
  assert.equal(l.next_free, '192.168.1.2'); // .1 is the gateway
  assert.equal(r.networks.find(n => n.id === iot.id)!.addresses[0].ip, '192.168.20.5');
  assert.deepEqual(r.unassigned.map(x => x.ip), ['10.9.9.9']);
  const samunjaPort = r.ports.find(p => p.project_id === a.id)!;
  assert.equal(samunjaPort.host_title, 'server2');
  assert.equal(samunjaPort.host_ip, '192.168.1.20');

  const kinds = r.clashes.map(c => c.kind).sort();
  assert.deepEqual(kinds, ['ip', 'port']);
  assert.match(r.clashes.find(c => c.kind === 'ip')!.message, /192\.168\.1\.20.*nas.*server2/);
  const pc = r.clashes.find(c => c.kind === 'port')!;
  assert.match(pc.message, /7760\/tcp.*server2/);
  assert.equal(pc.subject, '7760/tcp');
  assert.equal(pc.host!.title, 'server2');
  assert.deepEqual(r.clashes.find(c => c.kind === 'ip')!.projects.map(p => p.title), ['nas', 'server2']);
  assert.deepEqual(pc.project_ids.sort(), [a.id, b.id].sort());

  createNetwork(db, { name: 'Overlap', cidr: '192.168.1.128/25' });
  assert.ok(networkRegister(db).clashes.some(c => c.kind === 'network' && /LAN.*Overlap|Overlap.*LAN/.test(c.message)));
  updateNetwork(db, iot.id, { vlan: null });
  deleteNetwork(db, iot.id);
  assert.equal(networkRegister(db).networks.length, 2);
});

/** A fake Proxmox VE API: one node with a VM and a container. */
async function fakePve() {
  const seen: string[] = [];
  const routes: Record<string, unknown> = {
    '/api2/json/nodes': [{ node: 'pve10', status: 'online' }],
    '/api2/json/nodes/pve10/network': [{ iface: 'vmbr0', address: '192.168.1.10', type: 'bridge' }],
    '/api2/json/cluster/resources?type=vm': [
      { vmid: 100, name: 'server2', node: 'pve10', type: 'qemu', status: 'running' },
      { vmid: 101, name: 'pihole', node: 'pve10', type: 'lxc', status: 'running' },
      { vmid: 9000, name: 'ubuntu-template', node: 'pve10', type: 'qemu', status: 'stopped', template: 1 },
    ],
    '/api2/json/nodes/pve10/qemu/100/agent/network-get-interfaces': { result: [
      { name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }] },
      { name: 'ens18', 'ip-addresses': [{ 'ip-address': '192.168.1.20', 'ip-address-type': 'ipv4' }, { 'ip-address': 'fe80::1', 'ip-address-type': 'ipv6' }] },
    ] },
    '/api2/json/nodes/pve10/qemu/100/config': { ostype: 'l26' },
    '/api2/json/nodes/pve10/lxc/101/interfaces': [{ name: 'lo', inet: '127.0.0.1/8' }, { name: 'eth0', inet: '192.168.1.53/24' },
      { name: 'docker0', inet: '172.17.0.1/16' }, { name: 'br-3f2a9c1d', inet: '172.18.0.1/16' }, { name: 'veth12ab', inet: '' }],
    '/api2/json/nodes/pve10/lxc/101/config': { ostype: 'debian' },
    '/api2/json/nodes/pve10/lxc/101/firewall/rules': [
      { type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '80,443', enable: 1, comment: 'web' },
      { type: 'in', action: 'ACCEPT', macro: 'DNS', enable: 1 },
      { type: 'in', action: 'DROP', proto: 'tcp', dport: '22', enable: 1 },
      { type: 'out', action: 'ACCEPT', proto: 'tcp', dport: '25', enable: 1 },
      { type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '9000', enable: 0 },
    ],
  };
  const srv = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    const data = routes[req.url!];
    if (data === undefined) return res.writeHead(500).end('{"data":null}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen, close: () => new Promise(r => srv.close(r)) };
}

test('Proxmox import: preview, then create nodes and guests linked with Runs On; re-import updates', async () => {
  const db = fresh();
  const pve = await fakePve();
  try {
    assert.throws(() => addProxmox(db, { url: 'ftp://x', token_id: 'a@pam!b' }), /http/);
    assert.throws(() => addProxmox(db, { url: pve.url, token_id: 'no-bang' }), /USER@REALM!TOKENID/);
    const conn = addProxmox(db, { name: 'pve10', url: pve.url, token_id: 'root@pam!samunja', secret: 'uuid-secret' });
    assert.deepEqual(listProxmox(db), [{ id: conn.id, name: 'pve10', url: pve.url, token_id: 'root@pam!samunja', fingerprint: null, has_secret: true }]);

    const parent = s.createProject(db, { title: 'Proxmox' });
    const existing = s.createProject(db, { title: 'PVE10', parent_id: parent.id }); // matched case-insensitively
    const preview = await proxmoxImport(db, { parent_id: parent.id, dryRun: true });
    assert.deepEqual(preview.items.map(i => [i.title, i.kind, i.action]), [['pve10', 'Physical', 'update'], ['server2', 'VM', 'create'], ['pihole', 'LXC', 'create']]);
    assert.equal(s.listProjects(db).length, 2); // nothing written yet
    assert.ok(pve.seen.every(h => h === 'PVEAPIToken=root@pam!samunja=uuid-secret'));

    const done = await proxmoxImport(db, { parent_id: parent.id });
    assert.deepEqual(done.counts, { created: 2, updated: 1 });
    const f = (title: string) => {
      const p = s.listProjects(db).find(x => x.title.toLowerCase() === title)!;
      return { p, v: Object.fromEntries(s.getProject(db, p.id).fields.map(x => [x.name, x.type === 'link' ? x.display : x.value])) };
    };
    assert.equal(f('pve10').p.id, existing.id);
    assert.deepEqual([f('pve10').v.Kind, f('pve10').v['IP Address'], f('pve10').v.OS], ['Physical', '192.168.1.10', 'Proxmox']);
    assert.deepEqual([f('server2').v.Kind, f('server2').v['IP Address'], f('server2').v['Runs On'], f('server2').p.parent_id], ['VM', '192.168.1.20', 'PVE10', existing.id]);
    assert.deepEqual([f('pihole').v.Kind, f('pihole').v['IP Address'], f('pihole').v.OS], ['LXC', '192.168.1.53', 'Debian']);
    assert.ok(!s.listProjects(db).some(p => p.title === 'ubuntu-template'));

    // imported under the wrong parent: the same-named projects elsewhere are found, nothing is duplicated
    const elsewhere = await proxmoxImport(db, { dryRun: true });
    assert.deepEqual(elsewhere.items.map(i => i.action), ['update', 'update', 'update']);
    // ports: the node's web UI and SSH, and what the container's firewall lets in
    const ports = (title: string) => (db.prepare('SELECT port, protocol, source FROM ports WHERE project_id=? ORDER BY port, protocol').all(f(title).p.id) as { port: number; protocol: string; source: string }[]).map(p => `${p.port}/${p.protocol}`);
    assert.deepEqual(ports('pve10'), ['22/tcp', '8006/tcp']);
    assert.deepEqual(ports('pihole'), ['53/tcp', '53/udp', '80/tcp', '443/tcp']);
    createPort(db, { project_id: f('pihole').p.id, port: 8080, protocol: 'tcp' }); // added by hand: kept on re-import
    const again = await proxmoxImport(db, { parent_id: parent.id });
    assert.deepEqual(again.counts, { created: 0, updated: 3 });
    assert.equal(s.listProjects(db).length, 4);
    assert.deepEqual(ports('pihole'), ['53/tcp', '53/udp', '80/tcp', '443/tcp', '8080/tcp']);
  } finally { await pve.close(); }
});

test('Proxmox import explains a bad token', async () => {
  const db = fresh();
  const srv = createServer((_req, res) => res.writeHead(401).end('authentication failure'));
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  try {
    addProxmox(db, { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, token_id: 'root@pam!x', secret: 'bad' });
    await assert.rejects(proxmoxImport(db, { dryRun: true }), /401.*token/i);
  } finally { await new Promise(r => srv.close(r)); }
});

test('firewall rules become ports: lists, small ranges, macros; wide ranges skipped', () => {
  assert.deepEqual(firewallPorts([
    { type: 'in', action: 'ACCEPT', proto: 'udp', dport: '51820' },
    { type: 'in', action: 'ACCEPT', dport: '8000:8002' },
    { type: 'in', action: 'ACCEPT', dport: '30000:40000' },
    { type: 'in', action: 'ACCEPT', macro: 'HTTPS' },
  ]).map(p => `${p.port}/${p.protocol}`), ['443/tcp', '8000/tcp', '8001/tcp', '8002/tcp', '51820/udp']);
});

test('several Proxmox connections; the old single one is carried over', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'smj-')), 'old.db');
  let db = openDb(path);
  db.exec(`INSERT INTO meta VALUES ('proxmox', '{"url":"https://10.0.0.5:8006","token_id":"root@pam!old"}'); INSERT INTO secrets VALUES ('proxmox','old-secret')`);
  db.close();
  db = openDb(path);
  assert.deepEqual(listProxmox(db), [{ id: 1, name: 'Proxmox', url: 'https://10.0.0.5:8006', token_id: 'root@pam!old', fingerprint: null, has_secret: true }]);
  assert.equal((db.prepare("SELECT value FROM secrets WHERE key='proxmox:1'").get() as { value: string }).value, 'old-secret');
  const b = addProxmox(db, { name: 'Lab', url: 'https://10.0.0.6:8006', token_id: 'root@pam!lab', secret: 's2' });
  assert.equal(b.id, 2);
  await assert.rejects(proxmoxImport(db, { dryRun: true }), /which Proxmox connection: Proxmox, Lab/);
  await assert.rejects(proxmoxImport(db, { connection: 'nope', dryRun: true }), /No Proxmox connection/);
  updateProxmox(db, 1, { name: 'Main', secret: null });
  assert.deepEqual(listProxmox(db).map(c => [c.name, c.has_secret]), [['Main', false], ['Lab', true]]);
  await assert.rejects(proxmoxImport(db, { connection: 'main', dryRun: true }), /token secret for Main/);
  deleteProxmox(db, 2);
  assert.equal(listProxmox(db).length, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM secrets WHERE key LIKE 'proxmox%'").get()!.n, 0);
  void DatabaseSync;
});
