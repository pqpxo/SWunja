// Health checks: HTTP or TCP probes per project. Two failures in a row mark a check down and open a logbook
// incident; the recovery is added to that incident. Both notify the 'health' channels.
import type { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { HttpError, actor, createLog, getProject } from './services.ts';
import { notify, type Send } from './notify.ts';

export type CheckKind = 'http' | 'tcp';
export type Check = {
  id: number; project_id: number; project_title: string; kind: CheckKind; target: string; every_min: number; enabled: boolean;
  status: 'up' | 'down' | 'unknown'; fails: number; last_checked: string | null; last_change: string | null; last_error: string; last_ms: number | null;
  incident_id: number | null; created: string;
};
type CheckInput = { project_id?: number; kind?: CheckKind; target?: string; every_min?: number; enabled?: boolean };
type ProbeResult = { ok: boolean; ms: number; error: string };
type Probe = (c: { kind: CheckKind; target: string }) => Promise<ProbeResult>;

const FAILS_TO_DOWN = 2;
const TIMEOUT = 10_000;
const SELECT = 'SELECT h.*, p.title project_title FROM health_checks h JOIN projects p ON p.id=h.project_id';
const toCheck = (r: Record<string, any>): Check => ({ ...(r as Check), enabled: !!r.enabled });
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

function validate(kind: unknown, target: string) {
  if (kind !== 'http' && kind !== 'tcp') throw new HttpError(400, 'kind must be http or tcp');
  if (kind === 'http' && !/^https?:\/\/[^\s]+$/i.test(target)) throw new HttpError(400, 'An http check needs an http(s) URL');
  if (kind === 'tcp' && !/^[^\s:/]+:\d{1,5}$/.test(target)) throw new HttpError(400, 'A tcp check needs host:port, e.g. server1:22');
}

export function getCheck(db: DatabaseSync, id: number): Check {
  const r = db.prepare(`${SELECT} WHERE h.id=?`).get(id);
  if (!r) throw new HttpError(404, 'Health check not found');
  return toCheck(r);
}

export const listChecks = (db: DatabaseSync, o: { projectId?: number } = {}): Check[] =>
  (o.projectId === undefined ? db.prepare(`${SELECT} ORDER BY p.title, h.id`).all() : db.prepare(`${SELECT} WHERE h.project_id=? ORDER BY h.id`).all(o.projectId)).map(toCheck);

export function createCheck(db: DatabaseSync, d: CheckInput): Check {
  if (!d.project_id) throw new HttpError(400, 'project_id is required');
  getProject(db, d.project_id);
  const target = d.target?.trim() ?? '';
  validate(d.kind, target);
  const every = Math.max(1, Math.min(1440, Math.round(d.every_min ?? 5)));
  return getCheck(db, Number(db.prepare('INSERT INTO health_checks (project_id,kind,target,every_min) VALUES (?,?,?,?)').run(d.project_id, d.kind!, target, every).lastInsertRowid));
}

export function updateCheck(db: DatabaseSync, id: number, d: CheckInput): Check {
  const cur = getCheck(db, id);
  const kind = d.kind ?? cur.kind, target = d.target?.trim() ?? cur.target;
  validate(kind, target);
  const changed = kind !== cur.kind || target !== cur.target;
  db.prepare(`UPDATE health_checks SET kind=?, target=?, every_min=?, enabled=? ${changed ? ", status='unknown', fails=0, last_checked=NULL" : ''} WHERE id=?`)
    .run(kind, target, Math.max(1, Math.min(1440, Math.round(d.every_min ?? cur.every_min))), (d.enabled ?? cur.enabled) ? 1 : 0, id);
  return getCheck(db, id);
}

export function deleteCheck(db: DatabaseSync, id: number) {
  getCheck(db, id);
  db.prepare('DELETE FROM health_checks WHERE id=?').run(id);
}

/** HTTP: any answer below 500 means the service is up (a login page's 401 included). TLS errors are ignored. */
export const probe: Probe = ({ kind, target }) => new Promise(resolve => {
  const start = Date.now();
  const done = (ok: boolean, error = '') => resolve({ ok, ms: Date.now() - start, error });
  if (kind === 'tcp') {
    const i = target.lastIndexOf(':');
    const sock = connect({ host: target.slice(0, i), port: +target.slice(i + 1), timeout: TIMEOUT });
    sock.once('connect', () => { sock.destroy(); done(true); });
    sock.once('timeout', () => { sock.destroy(); done(false, 'Timed out'); });
    sock.once('error', e => done(false, (e as NodeJS.ErrnoException).code ?? e.message));
    return;
  }
  // ponytail: certificates aren't checked (homelab self-signed); add a per-check "verify TLS" option if wanted
  const req = (target.startsWith('https') ? httpsRequest : httpRequest)(target, { method: 'GET', timeout: TIMEOUT, rejectUnauthorized: false }, res => {
    res.resume();
    const code = res.statusCode ?? 0;
    done(code < 500, code < 500 ? '' : `HTTP ${code}`);
  });
  req.once('timeout', () => req.destroy(new Error('Timed out')));
  req.once('error', e => done(false, (e as NodeJS.ErrnoException).code ?? e.message));
  req.end();
});

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Runs every enabled check that is due; called from the background job each minute. */
export async function runDueChecks(db: DatabaseSync, o: { now?: number; probe?: Probe; send?: Send } = {}) {
  const now = o.now ?? Date.now(), run = o.probe ?? probe, send = o.send ?? (m => notify(db, m));
  const due = listChecks(db).filter(c => c.enabled && (!c.last_checked || Date.parse(c.last_checked) + c.every_min * 60_000 <= now));
  const results = await Promise.all(due.map(c => run(c)));
  const messages: Parameters<Send>[0][] = [];
  actor.run('monitor', () => due.forEach((c, i) => {
    const r = results[i], at = iso(now);
    const what = `${c.project_title} (${c.target})`;
    if (r.ok) {
      if (c.status === 'down') {
        const mins = Math.max(1, Math.round((now - Date.parse(c.last_change ?? at)) / 60_000));
        if (c.incident_id) db.prepare("UPDATE log_entries SET body = body || ?, updated=? WHERE id=?").run(`<p>Back up at ${at}, after ${mins} min.</p>`, at, c.incident_id);
        messages.push({ event: 'health', title: `${c.project_title} is back up`, message: `${what} answered again after ${mins} min down.`, project: c.project_title });
      }
      db.prepare("UPDATE health_checks SET status='up', fails=0, last_checked=?, last_error='', last_ms=?, last_change=CASE WHEN status='up' THEN last_change ELSE ? END, incident_id=NULL WHERE id=?")
        .run(at, r.ms, at, c.id);
      return;
    }
    const fails = c.fails + 1;
    if (fails >= FAILS_TO_DOWN && c.status !== 'down') {
      const title = `${c.project_title} is down`;
      const log = createLog(db, { project_id: c.project_id, kind: 'incident', title, body: `<p>Health check ${esc(c.kind.toUpperCase())} ${esc(c.target)} failed ${fails} times in a row: ${esc(r.error)}</p>`, at });
      db.prepare("UPDATE health_checks SET status='down', last_change=?, incident_id=? WHERE id=?").run(at, log.id, c.id);
      messages.push({ event: 'health', title, message: `${what}: ${r.error}`, project: c.project_title, priority: 'high' });
    }
    db.prepare('UPDATE health_checks SET fails=?, last_checked=?, last_error=?, last_ms=NULL WHERE id=?').run(fails, at, r.error, c.id);
  }));
  for (const m of messages) await send(m);
}
