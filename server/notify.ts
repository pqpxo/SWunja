// Notification channels (ntfy, Gotify, Home Assistant, email, webhook). Tokens and passwords live in the secrets
// table: write-only through the API and never exported.
import type { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';
import { HttpError } from './services.ts';

export const KINDS = ['ntfy', 'gotify', 'homeassistant', 'email', 'webhook', 'pushover'] as const;
export const EVENTS = ['health', 'maintenance', 'update', 'activity'] as const;
export type Kind = (typeof KINDS)[number];
export type Event = (typeof EVENTS)[number] | 'test';
export type Message = { event: Event; title: string; message: string; project?: string; url?: string; priority?: 'low' | 'default' | 'high' };
export type Result = { channel: string; ok: boolean; error?: string };
/** What background jobs call to send; tests pass their own. */
export type Send = (m: Message) => Promise<Result[]>;

type Config = Record<string, string | number | boolean>;
export type Channel = { id: number; name: string; kind: Kind; config: Config; events: string[]; enabled: boolean; has_secret: boolean; created: string };
type ChannelInput = { name?: string; kind?: Kind; config?: Config; events?: string[]; enabled?: boolean; secret?: string | null };

// what each kind needs; `secret` says whether its token/password is required
const NEEDS: Record<Kind, { fields: string[]; urls: string[]; secret: boolean; secretName: string }> = {
  ntfy: { fields: ['url', 'topic'], urls: ['url'], secret: false, secretName: 'access token' },
  gotify: { fields: ['url'], urls: ['url'], secret: true, secretName: 'app token' },
  homeassistant: { fields: ['url', 'service'], urls: ['url'], secret: true, secretName: 'long-lived access token' },
  email: { fields: ['host', 'port', 'from', 'to'], urls: [], secret: false, secretName: 'SMTP password' },
  webhook: { fields: ['url'], urls: ['url'], secret: false, secretName: 'bearer token' },
  pushover: { fields: ['user'], urls: [], secret: true, secretName: 'application API token' },
};

export const getSecret = (db: DatabaseSync, key: string) => (db.prepare('SELECT value FROM secrets WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null;
export function putSecret(db: DatabaseSync, key: string, value: string | null | undefined) {
  if (value === undefined || value === '') return; // blank keeps what's there
  if (value === null) db.prepare('DELETE FROM secrets WHERE key=?').run(key);
  else db.prepare('INSERT INTO secrets VALUES (?,?) ON CONFLICT DO UPDATE SET value=excluded.value').run(key, value);
}
export const setGithubToken = (db: DatabaseSync, token: string | null) => putSecret(db, 'github_token', token);
export const hasGithubToken = (db: DatabaseSync) => getSecret(db, 'github_token') !== null;

const toChannel = (db: DatabaseSync, r: Record<string, any>): Channel => ({
  id: r.id, name: r.name, kind: r.kind, config: JSON.parse(r.config), events: JSON.parse(r.events), enabled: !!r.enabled, created: r.created,
  has_secret: getSecret(db, `channel:${r.id}`) !== null,
});

export function getChannel(db: DatabaseSync, id: number): Channel {
  const r = db.prepare('SELECT * FROM notify_channels WHERE id=?').get(id);
  if (!r) throw new HttpError(404, 'Channel not found');
  return toChannel(db, r);
}
export const listChannels = (db: DatabaseSync) => db.prepare('SELECT * FROM notify_channels ORDER BY name').all().map(r => toChannel(db, r));

function validate(kind: Kind, config: Config, events: string[], hasSecret: boolean) {
  const need = NEEDS[kind];
  if (!need) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
  for (const f of need.fields) if (config[f] === undefined || String(config[f]).trim() === '') throw new HttpError(400, `${f} is required for ${kind}`);
  for (const f of need.urls) if (!/^https?:\/\/[^\s]+$/i.test(String(config[f]))) throw new HttpError(400, `${f} must be an http(s) URL`);
  if (kind === 'homeassistant' && !/^\w+\.\w+$/.test(String(config.service))) throw new HttpError(400, 'service looks like notify.mobile_app_phone or persistent_notification.create');
  if (need.secret && !hasSecret) throw new HttpError(400, `The ${need.secretName} is required for ${kind}`);
  for (const e of events) if (!(EVENTS as readonly string[]).includes(e)) throw new HttpError(400, `events can be ${EVENTS.join(', ')}`);
}

export function createChannel(db: DatabaseSync, d: ChannelInput): Channel {
  if (!d.name?.trim()) throw new HttpError(400, 'name is required');
  const config = d.config ?? {}, events = d.events ?? [...EVENTS];
  validate(d.kind!, config, events, !!d.secret);
  const id = Number(db.prepare('INSERT INTO notify_channels (name,kind,config,events) VALUES (?,?,?,?)')
    .run(d.name.trim(), d.kind!, JSON.stringify(config), JSON.stringify(events)).lastInsertRowid);
  putSecret(db, `channel:${id}`, d.secret);
  return getChannel(db, id);
}

export function updateChannel(db: DatabaseSync, id: number, d: ChannelInput): Channel {
  const cur = getChannel(db, id);
  const config = d.config ?? cur.config, events = d.events ?? cur.events;
  const willHaveSecret = d.secret === null ? false : !!d.secret || cur.has_secret;
  validate(cur.kind, config, events, willHaveSecret);
  db.prepare('UPDATE notify_channels SET name=?, config=?, events=?, enabled=? WHERE id=?')
    .run(d.name?.trim() || cur.name, JSON.stringify(config), JSON.stringify(events), (d.enabled ?? cur.enabled) ? 1 : 0, id);
  putSecret(db, `channel:${id}`, d.secret);
  return getChannel(db, id);
}

export function deleteChannel(db: DatabaseSync, id: number) {
  getChannel(db, id);
  db.prepare('DELETE FROM notify_channels WHERE id=?').run(id);
  db.prepare('DELETE FROM secrets WHERE key=?').run(`channel:${id}`);
}

const PRIORITY = { low: [2, 2, -1], default: [3, 5, 0], high: [5, 8, 1] } as const; // [ntfy, gotify, pushover]
const trimSlash = (u: unknown) => String(u).replace(/\/+$/, '');

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`.trim());
}

async function deliver(c: Channel, secret: string | null, m: Message) {
  const cfg = c.config, prio = m.priority ?? 'default';
  const bearer: Record<string, string> = secret ? { authorization: `Bearer ${secret}` } : {};
  switch (c.kind) {
    case 'ntfy': // JSON publishing: titles can hold any characters, unlike header publishing
      return post(trimSlash(cfg.url), { topic: cfg.topic, title: m.title, message: m.message || m.title, priority: PRIORITY[prio][0], tags: [m.event], ...(m.url ? { click: m.url } : {}) }, bearer);
    case 'gotify':
      return post(`${trimSlash(cfg.url)}/message`, { title: m.title, message: m.message || m.title, priority: PRIORITY[prio][1] }, { 'x-gotify-key': secret! });
    case 'homeassistant': {
      const [domain, service] = String(cfg.service).split('.');
      return post(`${trimSlash(cfg.url)}/api/services/${domain}/${service}`, { title: m.title, message: m.message || m.title }, bearer);
    }
    case 'pushover': // config.url only exists to point tests at a local server
      return post(String(cfg.url ?? 'https://api.pushover.net/1/messages.json'), {
        token: secret, user: cfg.user, title: m.title, message: m.message || m.title, priority: PRIORITY[prio][2], ...(m.url ? { url: m.url } : {}),
      });
    case 'webhook':
      return post(String(cfg.url), { event: m.event, title: m.title, message: m.message, project: m.project ?? null, url: m.url ?? null, at: new Date().toISOString() }, bearer);
    case 'email': {
      const port = Number(cfg.port);
      const mail = nodemailer.createTransport({
        host: String(cfg.host), port, secure: port === 465, connectionTimeout: 10_000,
        auth: cfg.user ? { user: String(cfg.user), pass: secret ?? '' } : undefined,
      });
      await mail.sendMail({ from: String(cfg.from), to: String(cfg.to), subject: `[SWunja] ${m.title}`, text: `${m.message}${m.url ? `\n\n${m.url}` : ''}` });
    }
  }
}

/** Sends to one channel; failures come back as a result, never thrown. */
export async function sendToChannel(db: DatabaseSync, c: Channel, m: Message): Promise<Result> {
  try {
    await deliver(c, getSecret(db, `channel:${c.id}`), m);
    return { channel: c.name, ok: true };
  } catch (e) {
    return { channel: c.name, ok: false, error: (e as Error).message };
  }
}

/** Sends to every enabled channel that subscribes to the event. */
export function notify(db: DatabaseSync, m: Message): Promise<Result[]> {
  const targets = listChannels(db).filter(c => c.enabled && (m.event === 'test' || c.events.includes(m.event)));
  return Promise.all(targets.map(c => sendToChannel(db, c, m)));
}

/** One message listing maintenance that has become overdue since the last run (once per due date). */
export async function notifyOverdue(db: DatabaseSync, o: { send?: Send } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT m.id, m.title, m.next_due, p.title project FROM maintenance m JOIN projects p ON p.id=m.project_id
    WHERE m.next_due < ? AND (m.notified_due IS NULL OR m.notified_due <> m.next_due) ORDER BY m.next_due`).all(today) as { id: number; title: string; next_due: string; project: string }[];
  if (!rows.length) return;
  const mark = db.prepare('UPDATE maintenance SET notified_due=next_due WHERE id=?');
  for (const r of rows) mark.run(r.id);
  const send = o.send ?? (m => notify(db, m));
  await send({
    event: 'maintenance', title: rows.length === 1 ? `Overdue: ${rows[0].title}` : `${rows.length} maintenance jobs overdue`,
    message: rows.map(r => `${r.title} (${r.project}), due ${r.next_due}`).join('\n'), project: rows.length === 1 ? rows[0].project : undefined,
  });
}
