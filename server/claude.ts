// Claude (Anthropic API) for SWunja: settings, monthly token usage, and matching activity to a task.
// One structured-output call per activity; without a key, or when the call fails, matching falls back to the shortlist.
import type { DatabaseSync } from 'node:sqlite';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { getSecret, putSecret } from './notify.ts';
import { HttpError } from './services.ts';
import { getActivity, pruneActivity, shortlist, type Activity, type Candidate, type Suggestion, type Target } from './activity.ts';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
/** What matching needs from a client: the SDK's messages.parse. Tests pass a fake. */
export type ClaudeLike = { messages: { parse: (req: any) => Promise<any> } };
type Usage = { month: string; input: number; output: number };

const meta = (db: DatabaseSync, key: string) => (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value;
const putMeta = (db: DatabaseSync, key: string, value: unknown) =>
  db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function getClaude(db: DatabaseSync): { model: string; has_key: boolean; usage: Usage } {
  const cfg = JSON.parse(meta(db, 'claude') ?? '{}') as { model?: string };
  const u = JSON.parse(meta(db, 'claude_usage') ?? 'null') as Usage | null;
  return { model: cfg.model || DEFAULT_MODEL, has_key: !!getSecret(db, 'claude'), usage: u?.month === thisMonth() ? u : { month: thisMonth(), input: 0, output: 0 } };
}

/** A blank key keeps the saved one; null removes it. The key is never returned. */
export function setClaude(db: DatabaseSync, d: { model?: string; key?: string | null }) {
  if (d.model !== undefined) {
    if (!/^[a-z0-9][a-z0-9.-]{2,60}$/.test(d.model.trim())) throw new HttpError(400, 'model must be a model id such as claude-haiku-5-5');
    putMeta(db, 'claude', { model: d.model.trim() });
  }
  putSecret(db, 'claude', d.key === null ? null : d.key?.trim());
  return getClaude(db);
}

export function addUsage(db: DatabaseSync, usage: { input_tokens?: number; output_tokens?: number } | undefined) {
  if (!usage) return;
  const u = getClaude(db).usage;
  putMeta(db, 'claude_usage', { month: u.month, input: u.input + (usage.input_tokens ?? 0), output: u.output + (usage.output_tokens ?? 0) });
}

export function claudeClient(db: DatabaseSync): ClaudeLike | null {
  const key = getSecret(db, 'claude');
  return key ? new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000 }) : null;
}

const MatchSchema = z.object({
  target_id: z.string(),
  confidence: z.number(),
  summary: z.string(),
  reason: z.string(),
  task_title: z.string().optional(),
  alternative_ids: z.array(z.string()),
});

const SYSTEM = `You match a batch of a person's recent work to the task or project in their task tracker that it belongs to.
You get the work (folder, host, what they asked an assistant to do, files changed, commands run, git commits) and a numbered list of candidates.
Pick the one candidate the work belongs to. Prefer a task when one fits; if no task fits, pick the best project and suggest a short task title for the work.
If nothing fits at all, still pick the closest candidate but give a low confidence.
summary: one or two plain sentences, past tense, saying what was done (no file lists, no secrets). reason: a few words on why it matches.
confidence: 0 to 1. target_id and alternative_ids must be ids from the list exactly as written (e.g. t:12 or p:3); give up to two alternatives.`;

const cid = (c: Candidate) => `${c.kind === 'task' ? 't' : 'p'}:${c.id}`;
const toTarget = ({ kind, id, title, project_id, path }: Candidate): Target => ({ kind, id, title, project_id, path });
const basename = (f: string) => f.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || f;

function describe(a: Activity, cands: Candidate[]) {
  const work = {
    folder: a.folder, host: a.host, source: a.source, summary: a.summary || undefined,
    asked: a.prompts.slice(0, 10).map(p => p.slice(0, 500)),
    files: a.files.slice(0, 200).map(f => `${f.change} ${f.path}`),
    commands: a.commands.slice(0, 150).map(c => c.cmd),
    commits: a.commits.slice(0, 50).map(c => c.message),
  };
  const list = cands.map(c => `${cid(c)} | ${c.kind} | ${c.path ? `${c.path} › ` : ''}${c.kind === 'task' ? c.title : ''}${c.text ? ` | ${c.text}` : ''}`);
  return `Work:\n${JSON.stringify(work, null, 1)}\n\nCandidates:\n${list.join('\n')}`;
}

/** "3 commands, 2 files in webapp" (plus what the source said it did), for when Claude isn't used. */
function countsSummary(a: Activity) {
  const n = (k: number, w: string) => (k ? [`${k} ${w}${k === 1 ? '' : 's'}`] : []);
  const parts = [...n(a.commands.length, 'command'), ...n(a.files.length, 'file'), ...n(a.commits.length, 'commit')];
  const base = `${parts.join(', ') || 'Activity'} in ${basename(a.folder)}.`;
  return a.summary ? `${a.summary} (${base})` : base;
}

function fallback(a: Activity, cands: Candidate[], error?: string): Suggestion {
  const top = cands[0];
  return {
    target: toTarget(top), alternatives: cands.slice(1, 3).map(toTarget), confidence: 0, summary: countsSummary(a),
    reason: top.score ? 'Most shared words' : 'Only candidate in this folder\'s project', ai: false,
    ...(top.kind === 'project' && { task_title: (a.summary || `Work in ${basename(a.folder)}`).slice(0, 80) }),
    ...(error && { error }),
  };
}

/** Works out a suggestion for one item and stores it (status matched). Never throws for API trouble: it falls back. */
export async function matchActivity(db: DatabaseSync, id: number, o: { client?: ClaudeLike | null } = {}): Promise<Activity> {
  const a = getActivity(db, id);
  const cands = shortlist(db, a);
  if (!cands.length) {
    db.prepare("UPDATE activity SET error=?, updated=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run('No tasks or projects to match yet', id);
    return getActivity(db, id);
  }
  const client = o.client === undefined ? claudeClient(db) : o.client;
  let sug: Suggestion;
  if (!client) sug = fallback(a, cands);
  else {
    try {
      const r = await client.messages.parse({
        model: getClaude(db).model, max_tokens: 4096, system: SYSTEM,
        messages: [{ role: 'user', content: describe(a, cands) }],
        output_config: { effort: 'low', format: zodOutputFormat(MatchSchema) },
      });
      addUsage(db, r.usage);
      const out = r.parsed_output as z.infer<typeof MatchSchema> | null;
      const byId = new Map(cands.map(c => [cid(c), c]));
      const target = out && byId.get(out.target_id);
      if (r.stop_reason === 'refusal') sug = fallback(a, cands, 'Claude declined to match this activity');
      else if (!out || !target) sug = fallback(a, cands, 'Claude picked something that is not a candidate');
      else sug = {
        target: toTarget(target),
        alternatives: out.alternative_ids.map(x => byId.get(x)).filter((c): c is Candidate => !!c && c !== target).slice(0, 2).map(toTarget),
        confidence: Math.max(0, Math.min(1, out.confidence)), summary: out.summary.trim() || countsSummary(a), reason: out.reason.trim(), ai: true,
        ...(target.kind === 'project' && { task_title: (out.task_title || a.summary || `Work in ${basename(a.folder)}`).slice(0, 80) }),
      };
    } catch (e) {
      sug = fallback(a, cands, `Claude unavailable: ${(e as Error).message}`.slice(0, 300));
    }
  }
  db.prepare("UPDATE activity SET suggestion=?, status='matched', error=?, updated=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status IN ('pending','matched')")
    .run(JSON.stringify(sug), sug.error ?? null, id);
  return getActivity(db, id);
}

/** The Claude card's Test button: one tiny request with the saved key and model. */
export async function testClaude(db: DatabaseSync): Promise<{ ok: boolean; model: string; error?: string }> {
  const key = getSecret(db, 'claude'), model = getClaude(db).model;
  if (!key) return { ok: false, model, error: 'Add an API key first' };
  try {
    const r = await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 30_000 }).messages.create({
      model, max_tokens: 16, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    });
    addUsage(db, r.usage);
    return { ok: true, model };
  } catch (e) {
    return { ok: false, model, error: (e as Error).message.slice(0, 300) };
  }
}

/** Background job: hourly, match what's pending (e.g. items that arrived before a key was added) and prune old dismissals. */
export async function activityJobIfDue(db: DatabaseSync, at = new Date(), o: { match?: (db: DatabaseSync) => Promise<number> } = {}) {
  const last = meta(db, 'activity_job_at');
  if (last && at.getTime() - Date.parse(JSON.parse(last)) < 3600_000) return;
  putMeta(db, 'activity_job_at', at.toISOString());
  pruneActivity(db, at);
  // not awaited: Claude calls can be slow and the other background jobs (health checks, backups) share this tick
  (o.match ?? matchPending)(db).catch(() => {});
}

/** Matches everything still pending (the hourly job and the Sync button). */
export async function matchPending(db: DatabaseSync, o: { client?: ClaudeLike | null } = {}): Promise<number> {
  const client = o.client === undefined ? claudeClient(db) : o.client;
  // with a key, also redo items that were matched without Claude (arrived before the key, or the API failed)
  const ids = (db.prepare(`SELECT id FROM activity WHERE status='pending'
    ${client ? "OR (status='matched' AND json_extract(suggestion,'$.ai')=0)" : ''} ORDER BY id`).all() as { id: number }[]).map(r => r.id);
  for (const id of ids) await matchActivity(db, id, { client });
  return ids.length;
}
