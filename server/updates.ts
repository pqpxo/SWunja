// GitHub update checks: projects with a GitHub field get the latest release (or tag) every few hours, compared
// with their Version field. A newer release notifies the 'update' channels once.
import type { DatabaseSync } from 'node:sqlite';
import { getSecret, notify, type Send } from './notify.ts';

export type Update = {
  project_id: number; project_title: string; repo: string; current: string | null; latest: string | null; url: string | null;
  checked: string | null; error: string; update_available: boolean;
};
const EVERY_HOURS = 6;

export function parseRepo(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** True when `latest` is a higher version than `current`, comparing the numbers in each ("v1.10" > "1.9"). */
export function isNewer(latest: string, current: string): boolean {
  const nums = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
  const a = nums(latest), b = nums(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

// the project-level GitHub and Version values, whichever type put them there
function projectValues(db: DatabaseSync) {
  const rows = db.prepare(`SELECT p.id, p.title, lower(f.name) name, fv.value FROM field_values fv JOIN fields f ON f.id=fv.field_id
    JOIN projects p ON p.id=fv.entity_id WHERE f.target='project' AND lower(f.name) IN ('github','version') AND p.archived=0`).all() as { id: number; title: string; name: string; value: string }[];
  const by = new Map<number, { title: string; github?: string; version?: string }>();
  for (const r of rows) {
    const e = by.get(r.id) ?? { title: r.title };
    if (r.name === 'github') e.github = r.value; else e.version = r.value;
    by.set(r.id, e);
  }
  return by;
}

export function listUpdates(db: DatabaseSync): Update[] {
  const vals = projectValues(db);
  const rows = db.prepare('SELECT * FROM update_checks').all() as Record<string, any>[];
  return rows.filter(r => vals.has(r.project_id)).map(r => {
    const v = vals.get(r.project_id)!;
    const current = v.version?.trim() || null;
    return {
      project_id: r.project_id, project_title: v.title, repo: r.repo, current, latest: r.latest, url: r.url, checked: r.checked, error: r.error,
      update_available: !!(r.latest && current && isNewer(r.latest, current)),
    };
  }).sort((a, b) => a.project_title.localeCompare(b.project_title));
}

async function latestRelease(repo: string, token: string | null, fetchFn: typeof fetch): Promise<{ tag: string; url: string } | null> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'swunja', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const get = (path: string) => fetchFn(`https://api.github.com/repos/${repo}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  let res = await get('/releases/latest');
  if (res.ok) { const j = await res.json(); return { tag: j.tag_name, url: j.html_url }; }
  if (res.status !== 404) throw new Error(`GitHub said ${res.status}${res.status === 403 ? ' (rate limit? add a token in Settings → Integrations)' : ''}`);
  res = await get('/tags?per_page=1'); // no releases: fall back to the newest tag
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  const tags = await res.json();
  return tags[0] ? { tag: tags[0].name, url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tags[0].name)}` } : null;
}

/** Checks the projects that are due (or all, with force), then notifies about new releases. */
export async function checkUpdates(db: DatabaseSync, o: { force?: boolean; projectId?: number; fetchFn?: typeof fetch; send?: Send; now?: number } = {}) {
  const now = o.now ?? Date.now(), fetchFn = o.fetchFn ?? fetch, send = o.send ?? (m => notify(db, m));
  const token = getSecret(db, 'github_token');
  const cached = new Map((db.prepare('SELECT * FROM update_checks').all() as Record<string, any>[]).map(r => [r.project_id, r]));
  for (const [id, v] of projectValues(db)) {
    if (o.projectId !== undefined && id !== o.projectId) continue;
    const repo = v.github ? parseRepo(v.github) : null;
    if (!repo) continue;
    const c = cached.get(id);
    if (!o.force && c?.repo === repo && c.checked && Date.parse(c.checked) + EVERY_HOURS * 3_600_000 > now) continue;
    const checked = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
    let latest: string | null = c?.repo === repo ? c.latest : null, url: string | null = c?.repo === repo ? c.url : null, error = '';
    try {
      const r = await latestRelease(repo, token, fetchFn);
      latest = r?.tag ?? null; url = r?.url ?? null;
    } catch (e) { error = (e as Error).message; }
    const notified = c?.repo === repo ? c.notified : null;
    db.prepare(`INSERT INTO update_checks (project_id,repo,latest,url,checked,error,notified) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET repo=excluded.repo, latest=excluded.latest, url=excluded.url, checked=excluded.checked, error=excluded.error, notified=excluded.notified`)
      .run(id, repo, latest, url, checked, error, notified);
    const current = v.version?.trim();
    if (latest && current && isNewer(latest, current) && notified !== latest) {
      db.prepare('UPDATE update_checks SET notified=? WHERE project_id=?').run(latest, id);
      await send({ event: 'update', title: `${v.title}: ${latest} is out`, message: `${v.title} runs ${current}; ${repo} released ${latest}.`, project: v.title, url: url ?? undefined });
    }
  }
}
