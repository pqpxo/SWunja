// Activity: batches of work captured from Claude Code and tracked folders, matched to tasks and accepted by the user.
// Nothing here writes to a task until acceptActivity is called.
import type { DatabaseSync } from 'node:sqlite';
import { tx } from './db.ts';
import { HttpError, actor, createComment, createTask, descendantIds, getTask, logEvent } from './services.ts';

export const SOURCES = ['claude-code', 'swjtrack', 'mcp'] as const;
export type FileChange = { path: string; change: 'created' | 'edited' | 'deleted'; count: number };
export type Command = { cmd: string; exit?: number; at?: string };
export type Commit = { hash: string; message: string };
export type ActivityInput = {
  source: (typeof SOURCES)[number]; host: string; folder: string; batch_id?: string; session_id?: string; started?: string; ended?: string;
  summary?: string; prompts?: string[]; files?: FileChange[]; commands?: Command[]; commits?: Commit[];
};
export type Target = { kind: 'task' | 'project'; id: number; title: string; project_id: number; path: string };
export type Suggestion = { target: Target; alternatives: Target[]; confidence: number; summary: string; reason: string; task_title?: string; ai: boolean; error?: string };
export type Activity = Omit<ActivityInput, 'prompts' | 'files' | 'commands' | 'commits'> & {
  id: number; prompts: string[]; files: FileChange[]; commands: Command[]; commits: Commit[];
  status: 'pending' | 'matched' | 'accepted' | 'dismissed'; suggestion: Suggestion | null; task_id: number | null; error: string | null; created: string; updated: string;
};

const MASK = '••••';
// [pattern, replacement]; earlier entries run first. Group 1 is always kept.
// a value: "quoted", 'quoted', or a bare word up to a space, & or quote
const VAL = `("[^"]*"|'[^']*'|[^\\s&'"]+)`;
const SECRETS: [RegExp, string][] = [
  [/(Authorization:\s*(?:Bearer|Basic|Token)?\s*)[^\s'"]+/gi, `$1${MASK}`],
  [/(\bBearer\s+)[^\s'"]+/gi, `$1${MASK}`],
  [/(\b[A-Za-z-]*(?:Key|Token|Secret):\s*)[^\s'"]+/gi, `$1${MASK}`], // headers such as X-Api-Key: …
  [new RegExp(`(--password[= ])${VAL}`, 'gi'), `$1${MASK}`],
  [/(\bsshpass\s+-p\s*)\S+/g, `$1${MASK}`],
  [/(\s-u\s*[^:\s]+:)\S+/g, `$1${MASK}`], // curl -u user:password
  [/(:\/\/[^:/\s@]+:)[^@\s]+(@)/g, `$1${MASK}$2`], // scheme://user:password@host
  [new RegExp(`(\\b(?:export\\s+)?[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASS)[A-Za-z0-9_]*=)${VAL}`, 'gi'), `$1${MASK}`],
  [new RegExp(`(\\b(?:password|passwd|pwd|token|api_key|apikey|secret)=)${VAL}`, 'gi'), `$1${MASK}`],
  [/(\b(?:password|passwd|secret|token):\s+)\S+/gi, `$1${MASK}`],
  // long random-looking runs (keys, hashes): need both a digit and a letter
  [/\b(?=[A-Za-z0-9+=_-]*\d)(?=[A-Za-z0-9+=_-]*[A-Za-z])[A-Za-z0-9+=_-]{32,}/g, MASK],
];

const MYSQL = /\b(?:mysql|mysqldump|mysqladmin|mariadb)[\w-]*\b/i;

/** Masks passwords, tokens and key-looking strings in a command line or text. */
export function redact(text: string): string {
  const t = SECRETS.reduce((t, [re, rep]) => t.replace(re, rep), text);
  // -psecret (attached value) is a password only for MySQL/MariaDB tools; elsewhere -p is a port (docker -p8080:80, ssh -p2222)
  return MYSQL.test(t) ? t.replace(/(\s-p)(?=[^\s-])\S+/g, `$1${MASK}`) : t;
}

const CAPS = { prompts: 50, commands: 500, files: 1000, commits: 200 };
const str = (v: unknown, max = 2000) => redact(String(v ?? '')).slice(0, max);
const list = <T>(v: unknown, cap: number, map: (x: any) => T | null): T[] =>
  (Array.isArray(v) ? v : []).map(map).filter((x): x is T => x !== null).slice(0, cap);

const toActivity = (r: Record<string, any>): Activity => ({
  ...(r as Activity), prompts: JSON.parse(r.prompts), files: JSON.parse(r.files), commands: JSON.parse(r.commands), commits: JSON.parse(r.commits),
  suggestion: r.suggestion ? JSON.parse(r.suggestion) : null,
});

/** A timestamp, or null when it isn't one (so later formatting can't fail). */
const isoOrNull = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString().replace(/\.000Z$/, 'Z') : null);

export function getActivity(db: DatabaseSync, id: number): Activity {
  const r = db.prepare('SELECT * FROM activity WHERE id=?').get(id);
  if (!r) throw new HttpError(404, 'Activity not found');
  return toActivity(r);
}

export function listActivity(db: DatabaseSync, o: { status?: string; source?: string; host?: string; limit?: number } = {}): Activity[] {
  const where = ['1=1'], params: string[] = [];
  for (const k of ['status', 'source', 'host'] as const) if (o[k]) { where.push(`${k}=?`); params.push(o[k]!); }
  const limit = Math.max(1, Math.min(Math.floor(o.limit ?? 200), 1000));
  return db.prepare(`SELECT * FROM activity WHERE ${where.join(' AND ')} ORDER BY created DESC, id DESC LIMIT ${limit}`).all(...params).map(toActivity);
}

/** Stores a batch, redacted and capped. The same batch_id twice returns the first item unchanged (retried syncs). */
export function createActivity(db: DatabaseSync, d: ActivityInput): Activity {
  if (!SOURCES.includes(d.source)) throw new HttpError(400, `source must be one of ${SOURCES.join(', ')}`);
  if (!String(d.folder ?? '').trim()) throw new HttpError(400, 'folder is required');
  if (!String(d.host ?? '').trim()) throw new HttpError(400, 'host is required');
  if (d.batch_id) {
    const r = db.prepare('SELECT id FROM activity WHERE batch_id=?').get(d.batch_id) as { id: number } | undefined;
    if (r) return getActivity(db, r.id);
  }
  const prompts = list(d.prompts, CAPS.prompts, p => (String(p ?? '').trim() ? str(p) : null));
  const commands = list(d.commands, CAPS.commands, c => (c && String(c.cmd ?? '').trim()
    ? { cmd: str(c.cmd, 1000), ...(Number.isInteger(c.exit) && { exit: c.exit }), ...(c.at && { at: String(c.at) }) } : null));
  const files = list(d.files, CAPS.files, f => (f && String(f.path ?? '').trim() && ['created', 'edited', 'deleted'].includes(f.change)
    ? { path: String(f.path).slice(0, 500), change: f.change, count: Math.max(1, Math.floor(Number(f.count) || 1)) } : null));
  const commits = list(d.commits, CAPS.commits, c => (c && c.hash ? { hash: String(c.hash).slice(0, 40), message: str(c.message, 300) } : null));
  const id = Number(db.prepare(`INSERT INTO activity (source,host,folder,batch_id,session_id,started,ended,summary,prompts,files,commands,commits)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.source, String(d.host).trim().slice(0, 200), String(d.folder).trim().slice(0, 500), d.batch_id ?? null,
    d.session_id ?? null, isoOrNull(d.started), isoOrNull(d.ended), str(d.summary), JSON.stringify(prompts), JSON.stringify(files),
    JSON.stringify(commands), JSON.stringify(commits)).lastInsertRowid);
  // part of this session was already reported in the chat (activity_report); the session id isn't known to MCP,
  // so same folder + inside the session's time is the link. The item stays waiting: only the user knows if the rest matters.
  const [from, to] = [isoOrNull(d.started), isoOrNull(d.ended)];
  if (d.source === 'claude-code' && from && to) {
    const f = normFolder(d.folder);
    const chats = db.prepare("SELECT folder FROM activity WHERE source='mcp' AND created BETWEEN ? AND ?").all(from, to) as { folder: string }[];
    if (chats.some(c => normFolder(c.folder) === f))
      db.prepare("UPDATE activity SET error='Partly reported in chat during this session' WHERE id=?").run(id);
  }
  return getActivity(db, id);
}

export function deleteActivity(db: DatabaseSync, id: number) {
  getActivity(db, id);
  db.prepare('DELETE FROM activity WHERE id=?').run(id);
}

/** Dismissed items go after 30 days; accepted ones stay (their task holds the record anyway). */
export function pruneActivity(db: DatabaseSync, at = new Date()): number {
  const cutoff = new Date(at.getTime() - 30 * 864e5).toISOString();
  return Number(db.prepare("DELETE FROM activity WHERE status='dismissed' AND updated < ?").run(cutoff).changes);
}


/* ---------------- folder memory: a folder (and everything under it) belongs to a project ---------------- */

/** Forward slashes, no trailing slash, lower-case drive letter, so Windows and Linux paths compare alike. */
export function normFolder(folder: string): string {
  const f = String(folder).trim().replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  return f.length > 1 ? f.replace(/\/+$/, '') : f;
}

export function setBinding(db: DatabaseSync, folder: string, projectId: number) {
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new HttpError(400, `No project ${projectId}`);
  db.prepare('INSERT INTO folder_bindings (folder,project_id) VALUES (?,?) ON CONFLICT(folder) DO UPDATE SET project_id=excluded.project_id')
    .run(normFolder(folder), projectId);
}

export function deleteBinding(db: DatabaseSync, folder: string) {
  db.prepare('DELETE FROM folder_bindings WHERE folder=?').run(normFolder(folder));
}

export const listBindings = (db: DatabaseSync) => db.prepare(`SELECT b.folder, b.project_id, p.title project_title FROM folder_bindings b
  JOIN projects p ON p.id=b.project_id ORDER BY b.folder`).all() as { folder: string; project_id: number; project_title: string }[];

/** The binding for this folder or its nearest bound parent. */
export function bindingFor(db: DatabaseSync, folder: string): { folder: string; project_id: number } | null {
  const f = normFolder(folder);
  const all = db.prepare('SELECT folder, project_id FROM folder_bindings').all() as { folder: string; project_id: number }[];
  return all.filter(b => f === b.folder || f.startsWith(`${b.folder}/`)).sort((a, b) => b.folder.length - a.folder.length)[0] ?? null;
}

/* ---------------- shortlist: the ~20 tasks and projects most likely to be what the work was about ---------------- */

export type Candidate = { kind: 'task' | 'project'; id: number; title: string; project_id: number; path: string; text: string; score: number };

const STOP = new Set(('the and for with from into this that sudo apt get install add run usr local bin home etc var opt tmp echo grep cat less tail head '
  + 'nano vim sed awk npm npx node python python3 git ssh mkdir touch chmod chown systemctl journalctl http https www com org net src dist '
  + 'true false null yes not all new main master').split(' '));
const IP = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** Words of 3+ letters/digits, plus whole IP addresses. */
function tokens(text: string): Set<string> {
  const t = String(text).toLowerCase();
  const out = new Set(t.match(IP) ?? []);
  for (const w of t.replace(IP, ' ').split(/[^a-z0-9]+/)) if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  return out;
}
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of b) if (a.has(w)) n++; return n; };
const plainText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

export function shortlist(db: DatabaseSync, a: Activity, limit = 20): Candidate[] {
  const words = tokens([a.folder, a.host, a.summary, ...a.prompts, ...a.files.map(f => f.path),
    ...a.commands.map(c => c.cmd), ...a.commits.map(c => c.message)].join(' '));
  const binding = bindingFor(db, a.folder);
  const allowed = binding ? new Set(descendantIds(db, binding.project_id)) : null;
  const projects = db.prepare('SELECT id, parent_id, title, description, archived FROM projects').all() as { id: number; parent_id: number | null; title: string; description: string; archived: number }[];
  const byId = new Map(projects.map(p => [p.id, p]));
  const path = (id: number) => { const t: string[] = []; for (let p = byId.get(id); p; p = p.parent_id ? byId.get(p.parent_id) : undefined) t.unshift(p.title); return t.join(' › '); };
  // field values per entity, with link fields shown as the linked project's title
  const fieldText = new Map<string, string>();
  for (const r of db.prepare('SELECT f.target, f.type, fv.entity_id, fv.value FROM field_values fv JOIN fields f ON f.id=fv.field_id').all() as { target: string; type: string; entity_id: number; value: string }[]) {
    const k = `${r.target}:${r.entity_id}`;
    fieldText.set(k, `${fieldText.get(k) ?? ''} ${r.type === 'link' ? byId.get(Number(r.value))?.title ?? '' : r.value}`);
  }
  const score = (title: string, desc: string, fields: string) => overlap(words, tokens(title)) * 3 + overlap(words, tokens(desc)) + overlap(words, tokens(fields)) * 2;
  const out: (Candidate & { updated?: string })[] = [];
  for (const p of projects) {
    if (p.archived || (allowed && !allowed.has(p.id))) continue;
    const desc = plainText(p.description);
    out.push({ kind: 'project', id: p.id, title: p.title, project_id: p.id, path: path(p.id), text: desc.slice(0, 200), score: score(p.title, desc, fieldText.get(`project:${p.id}`) ?? '') });
  }
  const tasks = db.prepare('SELECT id, project_id, title, description, updated FROM tasks WHERE done=0').all() as { id: number; project_id: number; title: string; description: string; updated: string }[];
  for (const t of tasks) {
    const p = byId.get(t.project_id);
    if (!p || p.archived || (allowed && !allowed.has(p.id))) continue;
    const desc = plainText(t.description);
    out.push({ kind: 'task', id: t.id, title: t.title, project_id: t.project_id, path: path(t.project_id), text: desc.slice(0, 200), score: score(t.title, desc, fieldText.get(`task:${t.id}`) ?? ''), updated: t.updated });
  }
  // tasks beat projects on a tie (the work is usually about a task); then the most recently touched
  out.sort((x, y) => y.score - x.score || (x.kind === y.kind ? (y.updated ?? '').localeCompare(x.updated ?? '') : x.kind === 'task' ? -1 : 1));
  const hits = out.filter(c => c.score > 0);
  // with a binding, Claude still gets the bound project's tasks to choose from when no word matched
  const picked = hits.length >= limit || !allowed ? hits : [...hits, ...out.filter(c => c.score === 0)];
  return picked.slice(0, limit).map(({ updated, ...c }) => c);
}

/* ---------------- accept / dismiss: the only way activity reaches a task ---------------- */

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hhmm = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : '');

/** The italic line under the summary: where it came from, how much, and when. */
function provenance(a: Activity) {
  const n = (k: number, w: string) => (k ? [`${k} ${w}${k === 1 ? '' : 's'}`] : []);
  const counts = [...n(a.commands.length, 'command'), ...n(a.files.length, 'file'), ...n(a.commits.length, 'commit')].join(', ');
  const from = hhmm(a.started), to = hhmm(a.ended ?? a.created);
  return [`From ${a.source} on ${a.host}, ${a.folder}`, counts, from && to && from !== to ? `${from}–${to}` : to].filter(Boolean).join(' · ');
}

/**
 * Writes the work onto a task: one comment marked as from the agent, plus one activity record in the task's history.
 * The task is d.task_id, or a new task in d.project_id, or the suggestion's target (a project target gets a new task).
 * Also remembers that this folder belongs to the task's project.
 */
export function acceptActivity(db: DatabaseSync, id: number, d: { task_id?: number; project_id?: number; task_title?: string } = {}) {
  const a = getActivity(db, id);
  if (a.status === 'accepted') throw new HttpError(400, 'This activity was already accepted');
  if (a.status === 'dismissed') throw new HttpError(400, 'This activity was dismissed');
  const sug = a.suggestion;
  const title = (d.task_title ?? sug?.task_title ?? sug?.summary ?? a.summary ?? '').trim().slice(0, 80) || `Work in ${a.folder}`;
  return actor.run('agent', () => tx(db, () => {
    let taskId = d.task_id ?? (d.project_id === undefined && sug?.target.kind === 'task' ? sug.target.id : undefined);
    if (taskId !== undefined) {
      try { getTask(db, taskId); } catch { throw new HttpError(400, 'That task no longer exists; pick another'); }
    } else {
      const projectId = d.project_id ?? (sug?.target.kind === 'project' ? sug.target.id : undefined);
      if (projectId === undefined) throw new HttpError(400, 'Pick a task or a project for this activity');
      taskId = createTask(db, { project_id: projectId, title }).id;
    }
    const summary = sug?.summary || a.summary || 'Activity recorded.';
    const comment = createComment(db, taskId, { body: `<p>${esc(summary)}</p><p><em>${esc(provenance(a))}</em></p>`, source: 'agent' });
    logEvent(db, taskId, 'activity', JSON.stringify({ activity_id: a.id, source: a.source, host: a.host, folder: a.folder, files: a.files, commands: a.commands, commits: a.commits }));
    const task = getTask(db, taskId);
    setBinding(db, a.folder, task.project_id);
    db.prepare("UPDATE activity SET status='accepted', task_id=?, updated=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(taskId, id);
    return { activity: getActivity(db, id), task_id: taskId, comment_id: comment.id };
  }));
}

export function dismissActivity(db: DatabaseSync, id: number): Activity {
  const a = getActivity(db, id);
  if (a.status === 'accepted') throw new HttpError(400, 'This activity was already accepted');
  db.prepare("UPDATE activity SET status='dismissed', updated=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(id);
  return getActivity(db, id);
}

/** Brings a dismissed item back to the waiting list, keeping its suggestion if it had one. */
export function restoreActivity(db: DatabaseSync, id: number): Activity {
  const a = getActivity(db, id);
  if (a.status !== 'dismissed') throw new HttpError(400, 'Only dismissed activity can be restored');
  db.prepare("UPDATE activity SET status=?, updated=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(a.suggestion ? 'matched' : 'pending', id);
  return getActivity(db, id);
}

/* ---------------- reminders: "have you synced your activity for X?" ---------------- */

type Send = (m: { event: 'activity'; title: string; message: string }) => Promise<unknown>;

export function getActivitySettings(db: DatabaseSync): { remind_hours: number } {
  const r = db.prepare("SELECT value FROM meta WHERE key='activity_settings'").get() as { value: string } | undefined;
  return { remind_hours: 24, ...(r ? JSON.parse(r.value) : {}) };
}

export function setActivitySettings(db: DatabaseSync, d: { remind_hours?: number }) {
  const s = { ...getActivitySettings(db), ...d };
  if (!(Number(s.remind_hours) > 0 && Number(s.remind_hours) <= 24 * 30)) throw new HttpError(400, 'remind_hours must be between 0 and 720');
  db.prepare("INSERT INTO meta VALUES ('activity_settings', ?) ON CONFLICT DO UPDATE SET value=excluded.value").run(JSON.stringify({ remind_hours: Number(s.remind_hours) }));
  return getActivitySettings(db);
}

/** swjtrack reports how much is waiting in a folder (on shell check-ins and after syncing). */
export function heartbeat(db: DatabaseSync, d: { host: string; folder: string; unsynced_count: number; oldest: string | null }, at = new Date()) {
  if (!String(d.host ?? '').trim()) throw new HttpError(400, 'host is required');
  if (!String(d.folder ?? '').trim()) throw new HttpError(400, 'folder is required');
  const n = Math.max(0, Math.floor(Number(d.unsynced_count) || 0));
  db.prepare(`INSERT INTO activity_hosts (host,folder,unsynced,oldest,seen,reminded) VALUES (?,?,?,?,?,NULL)
    ON CONFLICT(host,folder) DO UPDATE SET unsynced=excluded.unsynced, oldest=excluded.oldest, seen=excluded.seen,
      reminded=CASE WHEN excluded.unsynced=0 THEN NULL ELSE activity_hosts.reminded END`)
    .run(String(d.host).trim(), String(d.folder).trim(), n, n ? d.oldest ?? null : null, at.toISOString());
  return { ok: true };
}

/** One notification per folder with activity left unsynced past the threshold, at most once a day each. */
export async function remindUnsynced(db: DatabaseSync, o: { now?: Date; send: Send }): Promise<number> {
  const now = o.now ?? new Date();
  const cutoff = new Date(now.getTime() - getActivitySettings(db).remind_hours * 3600_000).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const rows = db.prepare(`SELECT host, folder, unsynced, oldest FROM activity_hosts
    WHERE unsynced > 0 AND oldest IS NOT NULL AND oldest < ? AND (reminded IS NULL OR reminded < ?) AND seen > ?`)
    .all(cutoff, dayAgo, new Date(now.getTime() - 7 * 864e5).toISOString()) as { host: string; folder: string; unsynced: number; oldest: string }[];
  for (const r of rows) {
    const since = new Date(r.oldest).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    await o.send({ event: 'activity', title: 'Unsynced activity', message: `Have you synced your activity for ${r.folder}? (${r.unsynced} items, since ${since}) on ${r.host}` });
    db.prepare('UPDATE activity_hosts SET reminded=? WHERE host=? AND folder=?').run(now.toISOString(), r.host, r.folder);
  }
  return rows.length;
}
