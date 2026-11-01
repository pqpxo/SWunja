import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from './main.ts';
import { openDb } from './db.ts';
import { createToken } from './services.ts';

test('MCP over HTTP: 401 without token, create + list a task with a custom field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const app = await buildApp(dir);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as any).port}/mcp`;
  try {
    const anon = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401);

    const { token } = createToken(openDb(join(dir, 'samunja.db')), 'test');
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const n of ['projects_list', 'tasks_create', 'tasks_list', 'fields_create', 'field_values_set', 'project_types_list', 'comments_create', 'labels_list'])
      assert.ok(names.includes(n), n);

    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args });
      if (r.isError) throw new Error(r.content[0].text);
      return JSON.parse(r.content[0].text);
    };
    const p = await call('projects_create', { title: 'HA', type: 'Home Assistant' });
    const t = await call('tasks_create', { project_id: p.id, title: 'Hall sensor', description: '## Issue\nflaky', labels: ['Fix'], fields: { Connectivity: 'zigbee' } });
    assert.equal(t.fields.find((f: any) => f.name === 'Connectivity').value, 'Zigbee');
    assert.match(t.description, /## Issue/);
    const t2 = await call('tasks_create', { project_id: p.id, title: 'Sections', issue: 'It **breaks**', resources: ['https://example.com'] });
    assert.match(t2.issue, /\*\*breaks\*\*/);
    assert.equal((await call('tasks_read', { id: t2.id })).resources[0].text, 'https://example.com');
    const list = await call('tasks_list', { filters: [{ field: 'Connectivity', op: 'eq', value: 'Zigbee' }] });
    assert.deepEqual(list.map((x: any) => x.title), ['Hall sensor']);
    await assert.rejects(call('tasks_update', { id: t.id, fields: { Connectivity: 'Carrier pigeon' } }), /Options: WiFi, Zigbee/);
    await call('fields_create', { name: 'Serial', type: 'text', target: 'task' });
    const fields = await call('fields_attach', { entity: 'task', id: t.id, field: 'Serial' });
    assert.equal(fields.find((f: any) => f.name === 'Serial').source, 'own');
    const read = await call('tasks_read', { id: t.id });
    assert.ok(read.history.some((e: any) => e.actor === 'mcp' && e.detail === 'added field Serial'), 'MCP changes are tagged mcp');
    const item = await call('checklist_add', { task_id: t.id, text: 'Re-pair sensor' });
    await call('checklist_update', { id: item.id, done: true });
    assert.equal((await call('tasks_list', { search: 'Hall' }))[0].checklist_progress, '1/1');

    // logbook, maintenance and infrastructure tools, as Claude would use them
    const host = await call('projects_create', { title: 'server2', type: 'Host', fields: { Kind: 'VM' } });
    await call('projects_create', { title: 'WebApp', type: 'Application', fields: { 'Runs On': 'server2' } });
    assert.deepEqual((await call('infra_dependents', { project: 'server2' })).map((d: any) => d.title), ['WebApp']);
    assert.equal((await call('infra_tree', {}))[0].title, 'server2');
    const entry = await call('log_create', { project: 'server2', kind: 'change', title: 'Upgraded Docker', body: 'apt upgrade', rollback: '`apt install docker-ce=28`' });
    assert.equal(entry.actor, 'mcp');
    assert.deepEqual((await call('log_list', { since: new Date(Date.now() - 60_000).toISOString() })).map((e: any) => e.title), ['Upgraded Docker']);
    const job = await call('maintenance_create', { project: host.id, title: 'Patch', every: 1, unit: 'month', next_due: '2020-01-01' });
    assert.equal(job.status, 'overdue');
    const done = await call('maintenance_done', { id: job.id, notes: 'apt full-upgrade' });
    assert.equal(done.log.kind, 'maintenance');
    assert.equal((await call('maintenance_list', { overdue: true })).length, 0);
    await client.close();
  } finally {
    await app.close();
  }
});

test('MCP activity tools: report, then accept only after a yes; instructions tell Claude to ask', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smj-'));
  const app = await buildApp(dir);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as any).port}/mcp`;
  try {
    const { token } = createToken(openDb(join(dir, 'samunja.db')), 'test');
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    assert.match(client.getInstructions() ?? '', /activity_report[\s\S]*only call activity_accept if they say yes/);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args });
      if (r.isError) throw new Error(r.content[0].text);
      return JSON.parse(r.content[0].text);
    };
    const p = await call('projects_create', { title: 'WebApp' });
    const t = await call('tasks_create', { project_id: p.id, title: 'Replace neofetch with fastfetch' });
    const rep = await call('activity_report', { folder: '/home/u/webapp', summary: 'Installed **fastfetch** and removed neofetch.', commands: ['apt install fastfetch'], files: ['/etc/fastfetch.jsonc'] });
    assert.equal(rep.suggestion.target.id, t.id);
    assert.equal(rep.suggestion.ai, false, 'no key in tests');
    assert.equal((await call('activity_list', { status: 'matched' })).length, 1);
    const acc = await call('activity_accept', { id: rep.id });
    assert.equal(acc.task_id, t.id);
    const comments = await call('comments_list', { task_id: t.id });
    assert.equal(comments.length, 1);
    assert.equal(comments[0].source, 'agent');
    assert.equal((await call('activity_list', { status: 'accepted' }))[0].source, 'mcp');
  } finally {
    await app.close();
  }
});
