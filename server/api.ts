import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import * as s from './services.ts';
import { exportAll, importAny } from './transfer.ts';
import * as bk from './backups.ts';
import { search } from './search.ts';
import * as tpl from './templates.ts';
import * as rb from './runbooks.ts';
import * as idea from './ideas.ts';
import * as cz from './closure.ts';
import { homeSummary } from './home.ts';
import { toHtml } from './md.ts';
import * as nt from './notify.ts';
import * as hc from './health.ts';
import * as up from './updates.ts';
import * as net from './network.ts';
import * as pve from './proxmox.ts';
import * as unifi from './unifi.ts';
import * as act from './activity.ts';
import * as cl from './claude.ts';
import * as gd from './gdrive.ts';
import { readFileSync } from 'node:fs';
import './recurring.ts';

const APP_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const STARTED = new Date().toISOString();

export const COOKIE = 'smj_session';

/** `curl -fsSL http://<swunja>/swjtrack/install | sh` */
const installScript = (server: string) => `#!/bin/sh
# Installs swjtrack, which sends activity from folders you track to SWunja at ${server}
set -e
SERVER="${server}"
mkdir -p "$HOME/.local/bin"
curl -fsSL "$SERVER/swjtrack" -o "$HOME/.local/bin/swjtrack"
chmod +x "$HOME/.local/bin/swjtrack"
command -v python3 >/dev/null || { echo "swjtrack needs python3 (sudo apt install python3)"; exit 1; }
# step-by-step setup on your terminal: API token (with a link to create one), folders, interval, Claude Code
exec "$HOME/.local/bin/swjtrack" _install "$SERVER" < /dev/tty
`;
// bodies are untyped here on purpose: services validate every input
type Req = Omit<FastifyRequest, 'params' | 'body' | 'query'> & { params: { id: string }; body: any; query: Record<string, string | undefined> };

// The installer is piped into sh, so the address it names must be a plain host[:port], never anything a shell could run.
const HOST = /^([a-z0-9-]+(\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(:\d{1,5})?$/i;

/**
 * Failed logins: after 5 from one address it must wait (1 s, doubling, up to 15 min), and past 30 in a minute from
 * anywhere every login waits a minute, so guessing is slow and the deliberately slow password hash can't be flooded.
 * ponytail: in memory, so a restart forgets it; fine for one instance.
 */
function loginLimiter() {
  const byIp = new Map<string, { n: number; until: number }>();
  let recent: number[] = [];
  const wait = (ms: number) => new s.HttpError(429, `Too many wrong passwords; try again in ${Math.ceil(ms / 1000)} s`);
  return {
    check(ip: string) {
      const now = Date.now();
      recent = recent.filter(t => now - t < 60_000);
      if (recent.length >= 30) throw wait(60_000 - (now - recent[0]));
      const f = byIp.get(ip);
      if (f && f.until > now) throw wait(f.until - now);
    },
    failed(ip: string) {
      const now = Date.now();
      recent.push(now);
      if (byIp.size > 10_000) byIp.clear();
      const f = byIp.get(ip) ?? { n: 0, until: 0 };
      f.n++;
      if (f.n >= 5) f.until = now + Math.min(2 ** (f.n - 5), 900) * 1000;
      byIp.set(ip, f);
    },
    ok: (ip: string) => { byIp.delete(ip); },
  };
}

const bearer = (req: FastifyRequest) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
export const isAuthed = (db: DatabaseSync, req: FastifyRequest) => s.checkSession(db, req.cookies[COOKIE]) || s.checkToken(db, bearer(req));

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
const bool = (v: string | undefined) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1');
const json = <T>(v: string | undefined): T | undefined => {
  if (!v) return undefined;
  try { return JSON.parse(v); } catch { throw new s.HttpError(400, 'filters must be JSON'); }
};

export function registerApi(fastify: FastifyInstance, db: DatabaseSync, dataDir: string) {
  // route generics can't be inferred from an annotated handler, so register through an untyped alias
  const app = fastify as any as { [m in 'get' | 'post' | 'put' | 'patch' | 'delete']: (url: string, h: (req: Req, reply: any) => unknown) => void } & FastifyInstance;
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, maxAge: 60 * 60 * 24 * 365 };
  const limiter = loginLimiter();
  /** The password check behind the login limit. */
  const passwordOk = (req: FastifyRequest, pw: unknown) => {
    limiter.check(req.ip);
    const ok = s.checkPassword(db, pw as string);
    if (ok) limiter.ok(req.ip); else limiter.failed(req.ip);
    return ok;
  };
  const login = (reply: any) => reply.setCookie(COOKIE, s.createSession(db), { ...cookieOpts, secure: reply.request.protocol === 'https' }).send({ ok: true });

  // Check the *matched route*, not req.url: the router decodes %xx, so raw-URL prefix checks can be bypassed.
  const PUBLIC = new Set(['/api/health', '/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/logout']);
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route?.startsWith('/api/') || PUBLIC.has(route)) return;
    if (route === '/api/appearance' && req.method === 'GET') return; // the login screen uses the chosen theme too
    if (!isAuthed(db, req)) return reply.code(401).send({ error: 'Not logged in' });
  });

  // tag everything this request does in the task history: browser session or API token
  app.addHook('onRequest', (req, _reply, done) => { s.actor.run(bearer(req) ? 'api' : 'web', done); });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/auth/status', async req => ({ setup: s.hasPassword(db), authed: isAuthed(db, req) }));
  app.post('/api/auth/setup', async (req: Req, reply) => {
    if (s.hasPassword(db)) throw new s.HttpError(409, 'Already set up');
    s.setPassword(db, req.body?.password);
    return login(reply);
  });
  app.post('/api/auth/login', async (req: Req, reply) => {
    if (!passwordOk(req as FastifyRequest, req.body?.password)) throw new s.HttpError(401, 'Wrong password');
    return login(reply);
  });
  app.post('/api/auth/logout', async (req, reply) => {
    if (req.cookies[COOKIE]) s.deleteSession(db, req.cookies[COOKIE]);
    return reply.clearCookie(COOKIE, { path: '/' }).send({ ok: true });
  });
  app.post('/api/password', async (req: Req, reply) => {
    if (!passwordOk(req as FastifyRequest, req.body?.current)) throw new s.HttpError(401, 'Current password is wrong');
    s.setPassword(db, req.body?.password);
    return login(reply);
  });

  app.get('/api/projects', async (req: Req) => s.listProjects(db, { archived: bool(req.query.archived), q: req.query.q, filters: json(req.query.filters) }));
  app.post('/api/projects', async (req: Req) => s.createProject(db, req.body));
  app.get('/api/projects/:id', async (req: Req) => s.getProject(db, +req.params.id));
  app.patch('/api/projects/:id', async (req: Req) => s.updateProject(db, +req.params.id, req.body));
  app.delete('/api/projects/:id', async (req: Req) => s.deleteProject(db, +req.params.id, dataDir));
  app.get('/api/projects/:id/buckets', async (req: Req) => s.listBuckets(db, +req.params.id));
  app.post('/api/projects/:id/buckets', async (req: Req) => s.createBucket(db, +req.params.id, req.body));
  app.put('/api/projects/:id/buckets/order', async (req: Req) => s.reorderBuckets(db, +req.params.id, req.body?.ids));
  app.patch('/api/buckets/:id', async (req: Req) => s.updateBucket(db, +req.params.id, req.body));
  app.delete('/api/buckets/:id', async (req: Req) => s.deleteBucket(db, +req.params.id));

  app.get('/api/tasks', async (req: Req) => {
    const q = req.query;
    return s.listTasks(db, {
      projectId: num(q.project_id), includeSub: bool(q.include_sub), done: bool(q.done), priorityMin: num(q.priority_min),
      labelIds: q.label_ids ? q.label_ids.split(',').map(Number) : undefined, q: q.q, filters: json(q.filters),
      dueBefore: q.due_before, dueAfter: q.due_after, limit: num(q.limit),
    });
  });
  app.post('/api/tasks', async (req: Req) => s.createTask(db, req.body));
  app.get('/api/tasks/:id', async (req: Req) => s.getTask(db, +req.params.id));
  app.patch('/api/tasks/:id', async (req: Req) => s.updateTask(db, +req.params.id, req.body));
  app.delete('/api/tasks/:id', async (req: Req) => s.deleteTask(db, +req.params.id, dataDir));
  app.post('/api/tasks/:id/move', async (req: Req) => s.moveTask(db, +req.params.id, { bucketId: req.body?.bucket_id, position: req.body?.position }));
  app.post('/api/tasks/:id/viewed', async (req: Req) => { s.logView(db, +req.params.id); return { ok: true }; });
  app.post('/api/projects/:id/viewed', async (req: Req) => { s.markProjectSeen(db, +req.params.id); return { ok: true }; });
  app.post('/api/tasks/:id/close', async (req: Req) => cz.closeTask(db, +req.params.id, req.body ?? {}));
  app.post('/api/tasks/:id/reopen', async (req: Req) => cz.reopenTask(db, +req.params.id));
  app.post('/api/projects/:id/close', async (req: Req) => cz.closeProject(db, +req.params.id, req.body ?? {}));
  app.post('/api/projects/:id/reopen', async (req: Req) => cz.reopenProject(db, +req.params.id));
  app.get('/api/tasks/:id/events', async (req: Req) => s.listEvents(db, +req.params.id, num(req.query.limit)));
  app.post('/api/tasks/:id/fields', async (req: Req) => { s.attachField(db, 'task', +req.params.id, req.body?.field); return s.getTask(db, +req.params.id); });
  app.delete('/api/tasks/:id/fields/:field', async (req: Req) => { s.detachField(db, 'task', +req.params.id, +(req.params as any).field); return s.getTask(db, +req.params.id); });
  app.post('/api/projects/:id/fields', async (req: Req) => { s.attachField(db, 'project', +req.params.id, req.body?.field); return s.getProject(db, +req.params.id); });
  app.delete('/api/projects/:id/fields/:field', async (req: Req) => { s.detachField(db, 'project', +req.params.id, +(req.params as any).field); return s.getProject(db, +req.params.id); });
  app.post('/api/tasks/:id/checklist', async (req: Req) => { s.addChecklistItem(db, +req.params.id, req.body ?? {}); return s.getTask(db, +req.params.id); });
  app.put('/api/tasks/:id/checklist/order', async (req: Req) => { s.reorderChecklist(db, +req.params.id, req.body?.ids, req.body?.parent_id ?? null, req.body?.list); return s.getTask(db, +req.params.id); });
  app.patch('/api/checklist/:id', async (req: Req) => s.updateChecklistItem(db, +req.params.id, req.body ?? {}));
  app.delete('/api/checklist/:id', async (req: Req) => s.deleteChecklistItem(db, +req.params.id));
  app.get('/api/tasks/:id/comments', async (req: Req) => s.listComments(db, +req.params.id));
  app.post('/api/tasks/:id/comments', async (req: Req) => s.createComment(db, +req.params.id, { body: req.body?.body }));
  app.patch('/api/comments/:id', async (req: Req) => s.updateComment(db, +req.params.id, req.body));
  app.delete('/api/comments/:id', async (req: Req) => s.deleteComment(db, +req.params.id));

  app.get('/api/projects/:id/dependents', async (req: Req) => s.dependents(db, +req.params.id, bool(req.query.transitive) ?? false));
  app.get('/api/infra', async () => s.infraTree(db));

  app.get('/api/log', async (req: Req) => {
    const q = req.query;
    return s.listLog(db, {
      projectId: num(q.project_id), includeSub: bool(q.include_sub), kind: q.kind, since: q.since, until: q.until, q: q.q,
      taskId: num(q.task_id), maintenanceId: num(q.maintenance_id), limit: num(q.limit),
    });
  });
  app.post('/api/log', async (req: Req) => s.createLog(db, req.body ?? {}));
  app.patch('/api/log/:id', async (req: Req) => s.updateLog(db, +req.params.id, req.body ?? {}));
  app.delete('/api/log/:id', async (req: Req) => s.deleteLog(db, +req.params.id));
  app.get('/api/ideas', async (req: Req) => idea.listIdeas(db, { projectId: num(req.query.project_id), includeSub: bool(req.query.include_sub), status: req.query.status as idea.IdeaStatus | undefined }));
  app.post('/api/ideas', async (req: Req) => idea.createIdea(db, req.body ?? {}));
  app.patch('/api/ideas/:id', async (req: Req) => idea.updateIdea(db, +req.params.id, req.body ?? {}));
  app.delete('/api/ideas/:id', async (req: Req) => idea.deleteIdea(db, +req.params.id));
  app.post('/api/ideas/:id/task', async (req: Req) => idea.ideaToTask(db, +req.params.id));

  app.get('/api/maintenance', async (req: Req) => s.listMaintenance(db, {
    projectId: num(req.query.project_id), includeSub: bool(req.query.include_sub), overdue: bool(req.query.overdue), dueWithinDays: num(req.query.due_within),
  }));
  app.post('/api/maintenance', async (req: Req) => s.createMaintenance(db, req.body ?? {}));
  app.patch('/api/maintenance/:id', async (req: Req) => s.updateMaintenance(db, +req.params.id, req.body ?? {}));
  app.delete('/api/maintenance/:id', async (req: Req) => s.deleteMaintenance(db, +req.params.id));
  app.post('/api/maintenance/:id/done', async (req: Req) => rb.maintenanceDone(db, +req.params.id, req.body ?? {}));

  app.get('/api/search', async (req: Req) => search(db, req.query.q ?? '', num(req.query.limit)));

  app.get('/api/templates', async (req: Req) => tpl.listTemplates(db, req.query.kind as 'task' | 'project' | undefined));
  app.post('/api/templates', async (req: Req) => tpl.saveTemplate(db, req.body ?? {}));
  app.patch('/api/templates/:id', async (req: Req) => tpl.renameTemplate(db, +req.params.id, req.body?.name));
  app.delete('/api/templates/:id', async (req: Req) => tpl.deleteTemplate(db, +req.params.id));
  app.post('/api/templates/:id/apply', async (req: Req) => tpl.applyTemplate(db, +req.params.id, req.body ?? {}));

  app.get('/api/runbooks', async (req: Req) => rb.listRunbooks(db, { projectId: num(req.query.project_id) }));
  app.get('/api/runbooks/:id', async (req: Req) => rb.getRunbook(db, +req.params.id));
  app.post('/api/runbooks', async (req: Req) => rb.createRunbook(db, req.body ?? {}));
  app.patch('/api/runbooks/:id', async (req: Req) => rb.updateRunbook(db, +req.params.id, req.body ?? {}));
  app.delete('/api/runbooks/:id', async (req: Req) => rb.deleteRunbook(db, +req.params.id));
  app.get('/api/runbooks/:id/runs', async (req: Req) => rb.listRuns(db, +req.params.id));
  app.post('/api/runbooks/:id/runs', async (req: Req) => rb.startRun(db, +req.params.id));
  app.patch('/api/runbook-runs/:id', async (req: Req) => rb.updateRun(db, +req.params.id, req.body ?? {}));
  app.post('/api/runbook-runs/:id/finish', async (req: Req) => rb.finishRun(db, +req.params.id, req.body ?? {}));
  app.delete('/api/runbook-runs/:id', async (req: Req) => rb.deleteRun(db, +req.params.id));

  // activity: work captured by swjtrack / Claude Code, matched to tasks; nothing reaches a task until accepted
  app.post('/api/activity', async (req: Req) => {
    const a = act.createActivity(db, req.body ?? {});
    if (a.status === 'pending') cl.matchActivity(db, a.id).catch(e => req.log.error(e, 'activity match failed'));
    return a;
  });
  app.get('/api/activity', async (req: Req) => act.listActivity(db, { status: req.query.status, source: req.query.source, host: req.query.host, limit: num(req.query.limit) }));
  app.post('/api/activity/heartbeat', async (req: Req) => act.heartbeat(db, req.body ?? {}));
  app.get('/api/activity/settings', async () => act.getActivitySettings(db));
  app.put('/api/activity/settings', async (req: Req) => act.setActivitySettings(db, req.body ?? {}));
  // the swjtrack installer (outside /api, so no login): fetches the script from this same server
  app.get('/swjtrack/install', async (req, reply) => {
    if (!HOST.test(req.host ?? '')) return reply.code(400).type('text/plain; charset=utf-8').send('echo "swjtrack: use the plain address of your SWunja server" >&2; exit 1\n');
    return reply.type('text/plain; charset=utf-8').send(installScript(`${req.protocol}://${req.host}`));
  });
  app.get('/api/activity/count', async () => ({ waiting: (db.prepare("SELECT count(*) n FROM activity WHERE status IN ('pending','matched')").get() as { n: number }).n }));
  app.post('/api/activity/sync', async () => ({ matched: await cl.matchPending(db) }));
  app.get('/api/activity/:id', async (req: Req) => act.getActivity(db, +req.params.id));
  app.post('/api/activity/:id/match', async (req: Req) => cl.matchActivity(db, +req.params.id));
  app.post('/api/activity/:id/accept', async (req: Req) => act.acceptActivity(db, +req.params.id, req.body ?? {}));
  app.post('/api/activity/:id/dismiss', async (req: Req) => act.dismissActivity(db, +req.params.id));
  app.delete('/api/activity/:id', async (req: Req) => act.deleteActivity(db, +req.params.id));
  app.get('/api/folder-bindings', async () => act.listBindings(db));
  app.put('/api/folder-bindings', async (req: Req) => { act.setBinding(db, String(req.body?.folder ?? ''), Number(req.body?.project_id)); return act.listBindings(db); });
  app.delete('/api/folder-bindings', async (req: Req) => { act.deleteBinding(db, String(req.query.folder ?? '')); return act.listBindings(db); });
  app.get('/api/claude', async () => cl.getClaude(db));
  app.put('/api/claude', async (req: Req) => cl.setClaude(db, req.body ?? {}));
  app.post('/api/claude/test', async () => cl.testClaude(db));

  // Logbook webhook for other tools (Watchtower, Proxmox, Home Assistant, cron). API token in the Authorization header.
  // Body: JSON { title, message|body, kind?, project?, rollback? } or plain text (first line = title).
  app.post('/api/hooks/log', async (req: Req) => s.actor.run('webhook', () => {
    const b = req.body;
    let title = '', message = '', rollback = '';
    if (typeof b === 'string') [title, message] = [b.split('\n')[0], b.split('\n').slice(1).join('\n')];
    else if (b && typeof b === 'object') {
      message = String(b.message ?? b.body ?? b.text ?? '');
      title = String(b.title ?? b.subject ?? message.split('\n')[0] ?? '');
      rollback = String(b.rollback ?? '');
    }
    const project = req.query.project ?? (typeof b === 'object' ? b?.project : undefined);
    if (!project) throw new s.HttpError(400, 'Say which project: ?project=<title or id>');
    return s.createLog(db, {
      project_id: s.resolveProjectRef(db, project), kind: (req.query.kind ?? (typeof b === 'object' ? b?.kind : undefined) ?? 'change') as s.LogKind,
      title: title.trim().slice(0, 300), body: message.trim() ? toHtml(message.trim()) : '', rollback: rollback.trim() ? toHtml(rollback.trim()) : '',
    });
  }));

  // integrations: notification channels and the GitHub token (secrets are write-only)
  app.get('/api/integrations', async () => ({ channels: nt.listChannels(db), github_token: nt.hasGithubToken(db), kinds: nt.KINDS, events: nt.EVENTS }));
  app.put('/api/integrations/github', async (req: Req) => { nt.setGithubToken(db, req.body?.token ?? null); return { github_token: nt.hasGithubToken(db) }; });
  app.post('/api/channels', async (req: Req) => nt.createChannel(db, req.body ?? {}));
  app.patch('/api/channels/:id', async (req: Req) => nt.updateChannel(db, +req.params.id, req.body ?? {}));
  app.delete('/api/channels/:id', async (req: Req) => nt.deleteChannel(db, +req.params.id));
  app.post('/api/channels/:id/test', async (req: Req) => nt.sendToChannel(db, nt.getChannel(db, +req.params.id),
    { event: 'test', title: 'SWunja test notification', message: 'If you can read this, the channel works.' }));

  app.get('/api/health-checks', async (req: Req) => hc.listChecks(db, { projectId: num(req.query.project_id) }));
  app.post('/api/health-checks', async (req: Req) => hc.createCheck(db, req.body ?? {}));
  app.patch('/api/health-checks/:id', async (req: Req) => hc.updateCheck(db, +req.params.id, req.body ?? {}));
  app.delete('/api/health-checks/:id', async (req: Req) => hc.deleteCheck(db, +req.params.id));
  app.post('/api/health-checks/:id/run', async (req: Req) => {
    db.prepare('UPDATE health_checks SET last_checked=NULL WHERE id=?').run(hc.getCheck(db, +req.params.id).id);
    await hc.runDueChecks(db);
    return hc.getCheck(db, +req.params.id);
  });

  app.get('/api/network', async () => net.networkRegister(db));
  app.post('/api/networks', async (req: Req) => net.createNetwork(db, req.body ?? {}));
  app.patch('/api/networks/:id', async (req: Req) => net.updateNetwork(db, +req.params.id, req.body ?? {}));
  app.delete('/api/networks/:id', async (req: Req) => net.deleteNetwork(db, +req.params.id));
  app.post('/api/ports', async (req: Req) => net.createPort(db, req.body ?? {}));
  app.delete('/api/ports/:id', async (req: Req) => net.deletePort(db, +req.params.id));

  app.get('/api/proxmox', async () => pve.listProxmox(db));
  app.post('/api/proxmox', async (req: Req) => pve.addProxmox(db, req.body ?? {}));
  app.patch('/api/proxmox/:id', async (req: Req) => pve.updateProxmox(db, +req.params.id, req.body ?? {}));
  app.delete('/api/proxmox/:id', async (req: Req) => pve.deleteProxmox(db, +req.params.id));
  app.post('/api/proxmox/import', async (req: Req) => s.actor.run('import', () =>
    pve.proxmoxImport(db, { connection: req.body?.connection_id ?? null, parent_id: req.body?.parent_id ?? null, dryRun: !!req.body?.dry_run })));

  // version and runtime for Settings → About
  app.get('/api/info', async () => ({ version: APP_VERSION, node: process.version, started: STARTED }));
  app.get('/api/home', async () => homeSummary(db, dataDir));

  app.get('/api/unifi', async () => unifi.getUnifi(db));
  app.put('/api/unifi', async (req: Req) => unifi.setUnifi(db, req.body ?? {}));
  app.post('/api/unifi/clients/refresh', async () => { await unifi.refreshClients(db); return net.networkRegister(db); });
  app.post('/api/unifi/clients/:key/add', async (req: Req) => unifi.addClientProject(db, (req.params as unknown as { key: string }).key));
  app.post('/api/unifi/import', async (req: Req) => s.actor.run('import', () =>
    unifi.unifiImport(db, { parent_id: req.body?.parent_id ?? null, dryRun: !!req.body?.dry_run })));

  app.get('/api/updates', async () => up.listUpdates(db));
  app.post('/api/updates/check', async (req: Req) => { await up.checkUpdates(db, { force: true, projectId: num(req.body?.project_id) }); return up.listUpdates(db); });

  app.get('/api/labels', async () => s.listLabels(db));
  app.post('/api/labels', async (req: Req) => s.createLabel(db, req.body));
  app.patch('/api/labels/:id', async (req: Req) => s.updateLabel(db, +req.params.id, req.body));
  app.delete('/api/labels/:id', async (req: Req) => s.deleteLabel(db, +req.params.id));

  app.get('/api/fields', async () => s.listFields(db));
  app.post('/api/fields', async (req: Req) => s.createFieldForTargets(db, req.body ?? {}));
  app.patch('/api/fields/:id', async (req: Req) => s.updateField(db, +req.params.id, req.body));
  app.delete('/api/fields/:id', async (req: Req) => s.deleteField(db, +req.params.id));
  app.get('/api/types', async () => s.listTypes(db));
  app.post('/api/types', async (req: Req) => s.createType(db, req.body));
  app.patch('/api/types/:id', async (req: Req) => s.updateType(db, +req.params.id, req.body));
  app.delete('/api/types/:id', async (req: Req) => s.deleteType(db, +req.params.id));

  app.get('/api/tokens', async () => s.listTokens(db));
  app.post('/api/tokens', async (req: Req) => s.createToken(db, req.body?.name));
  app.delete('/api/tokens/:id', async (req: Req) => s.deleteToken(db, +req.params.id));

  app.post('/api/attachments', async (req: Req) => {
    const file = await req.file();
    if (!file) throw new s.HttpError(400, 'file is required');
    const taskId = num((file.fields.task_id as any)?.value);
    const a = s.createAttachment(db, dataDir, { name: file.filename, mime: file.mimetype, data: await file.toBuffer(), taskId });
    return { ...a, url: `/api/attachments/${a.id}` };
  });
  app.get('/api/tasks/:id/attachments', async (req: Req) => s.listAttachments(db, +req.params.id));
  app.delete('/api/attachments/:id', async (req: Req) => s.deleteAttachment(db, dataDir, +req.params.id));
  app.get('/api/appearance', async () => s.getAppearance(db));
  app.put('/api/appearance', async (req: Req) => s.setAppearance(db, req.body ?? {}));
  app.get('/api/attachments/:id', async (req: Req, reply) => {
    const a = s.getAttachment(db, +req.params.id);
    // only images render inline; anything else downloads so uploaded HTML can't run on this origin
    const inline = /^image\/(png|jpe?g|gif|webp|avif)$/.test(a.mime);
    return reply.header('content-type', inline ? a.mime : 'application/octet-stream')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(a.name)}"`)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(createReadStream(s.attachmentPath(dataDir, a.id)));
  });

  app.post('/api/import', async (req: Req) => {
    const file = await req.file();
    if (!file) throw new s.HttpError(400, 'Upload a SWunja or Vikunja export .zip');
    const force = (file.fields.force as any)?.value === 'true';
    const zip = await file.toBuffer();
    return s.actor.run('import', () => importAny(db, dataDir, zip, { force }));
  });
  app.get('/api/backups', async () => ({
    settings: bk.getBackupSettings(db), dir: bk.backupDir(dataDir), backups: bk.listBackups(dataDir),
    last: (db.prepare("SELECT value FROM meta WHERE key='backup_last'").get() as { value: string } | undefined)?.value ?? null,
  }));
  app.post('/api/backups', async () => bk.createBackup(db, dataDir));
  // Google Drive copies of the backups
  app.get('/api/gdrive', async () => gd.getDrive(db));
  app.put('/api/gdrive', async (req: Req) => gd.setDrive(db, req.body ?? {}));
  app.post('/api/gdrive/connect', async () => gd.connectStart(db));
  app.post('/api/gdrive/connect/poll', async () => gd.connectFinish(db));
  app.post('/api/gdrive/upload', async () => {
    const r = await gd.uploadIfNew(db, dataDir, { force: true });
    return r ?? { error: gd.getDrive(db).last_error ?? 'No backup to upload yet; create one first' };
  });
  app.delete('/api/gdrive', async () => gd.disconnect(db));
  app.put('/api/backups/settings', async (req: Req) => bk.setBackupSettings(db, req.body ?? {}));
  app.get('/api/backups/:name/download', async (req: Req, reply) => {
    const name = (req.params as any).name as string;
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${name}"`)
      .send(createReadStream(bk.backupPath(dataDir, name)));
  });
  app.delete('/api/backups/:name', async (req: Req) => bk.deleteBackup(dataDir, (req.params as any).name));
  app.get('/api/export', async (_req: Req, reply) => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return reply.header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="swunja-export-${stamp}.zip"`)
      .send(Buffer.from(exportAll(db, dataDir)));
  });
}
