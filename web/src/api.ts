export type FieldType = 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'url' | 'link';
export type Field = { id: number; name: string; type: FieldType; target: 'project' | 'task'; options: string[] };
export type FieldSource = 'type' | 'parent' | 'own';
/** For link fields, value is the linked project's id and display its title. */
export type FieldValue = Omit<Field, 'target'> & { value: string | null; source: FieldSource; display?: string | null };
export type ProjectType = { id: number; name: string; fields: Field[] };
export type Project = {
  id: number; parent_id: number | null; type_id: number | null; effective_type_id: number | null; title: string;
  description: string; color: string; icon: string; archived: boolean; position: number; fields: FieldValue[];
  log_completed: boolean | null; log_completed_effective: boolean; icon_inherited: boolean;
  /** Added or changed outside the browser and not opened since; unseen_tasks: its own tasks in that state. */
  unseen: Unseen; unseen_tasks: number;
  closed: ClosedStatus | null; closure: Closure | null;
  task_fields: { id: number; name: string; type: FieldType; source: FieldSource }[];
};
export type Bucket = { id: number; project_id: number; title: string; position: number };
export type Label = { id: number; title: string; color: string };
/** Repeat every N units, counted from the due date or from when it was done. */
export type Repeat = { every: number; unit: 'day' | 'week' | 'month' | 'year'; from: 'due' | 'done' };

export type Task = {
  id: number; project_id: number; project_title: string; bucket_id: number | null; bucket_title: string | null; title: string; description: string;
  issue: string; workaround: string; resolution: string;
  checklist: ChecklistItem[]; checklist_style: 'bullets' | 'numbered'; checklist_enabled: boolean;
  requirements: ChecklistItem[]; requirements_style: 'bullets' | 'numbered'; requirements_enabled: boolean;
  resources: ChecklistItem[]; resources_style: 'bullets' | 'numbered'; resources_enabled: boolean;
  done: boolean; done_at: string | null; priority: number; due_date: string | null; position: number;
  created: string; updated: string; labels: Label[]; fields: FieldValue[]; unseen: Unseen;
  closed: ClosedStatus | null; closure: Closure | null; repeat: Repeat | null;
};
export type Unseen = 'new' | 'updated' | null;
export type ClosedStatus = 'completed' | 'abandoned' | 'on_hold';
export type Closure = {
  status: ClosedStatus; notes: string; reason?: string; lessons?: string;
  replaced_by?: { kind: 'task' | 'project'; id: number; title: string }; closed_at: string; closed_by: string; review_on?: string;
};
export type Comment = { id: number; task_id: number; body: string; source: string; created: string; updated: string };
export type ActivityTarget = { kind: 'task' | 'project'; id: number; title: string; project_id: number; path: string };
export type Suggestion = { target: ActivityTarget; alternatives: ActivityTarget[]; confidence: number; summary: string; reason: string; task_title?: string; ai: boolean; error?: string };
export type Activity = {
  id: number; source: 'claude-code' | 'swjtrack' | 'mcp'; host: string; folder: string; started: string | null; ended: string | null; summary: string;
  prompts: string[]; files: { path: string; change: 'created' | 'edited' | 'deleted'; count: number }[]; commands: { cmd: string; exit?: number; at?: string }[];
  commits: { hash: string; message: string }[]; status: 'pending' | 'matched' | 'accepted' | 'dismissed'; suggestion: Suggestion | null;
  task_id: number | null; error: string | null; created: string; updated: string;
};
export type ClaudeSettings = { model: string; has_key: boolean; usage: { month: string; input: number; output: number } };
export type TaskEvent = { id: number; kind: string; detail: string; actor: string; at: string };
export type LogKind = 'change' | 'incident' | 'maintenance' | 'observation';
export type LogEntry = {
  id: number; project_id: number; project_title: string; task_id: number | null; task_title: string | null; maintenance_id: number | null;
  kind: LogKind; title: string; body: string; rollback: string; actor: string; at: string; created: string; updated: string;
};
export type IdeaStatus = 'new' | 'maybe' | 'parked' | 'done' | 'rejected';
export type Idea = {
  id: number; project_id: number; project_title: string; title: string; body: string; status: IdeaStatus; reason: string;
  pinned: boolean; task_id: number | null; task_title: string | null; created: string; updated: string;
};
export type Unit = 'day' | 'week' | 'month' | 'year';
export type Maintenance = {
  id: number; project_id: number; project_title: string; title: string; notes: string; every: number; unit: Unit;
  last_done: string | null; next_due: string; status: 'overdue' | 'due-soon' | 'ok'; runbook_id: number | null; created: string; updated: string;
};
export type ChannelKind = 'ntfy' | 'gotify' | 'homeassistant' | 'email' | 'webhook' | 'pushover';
export type Channel = { id: number; name: string; kind: ChannelKind; config: Record<string, string | number | boolean>; events: string[]; enabled: boolean; has_secret: boolean; created: string };
export type HealthCheck = {
  id: number; project_id: number; project_title: string; kind: 'http' | 'tcp'; target: string; every_min: number; enabled: boolean;
  status: 'up' | 'down' | 'unknown'; fails: number; last_checked: string | null; last_change: string | null; last_error: string; last_ms: number | null;
};
export type Update = { project_id: number; project_title: string; repo: string; current: string | null; latest: string | null; url: string | null; checked: string | null; error: string; update_available: boolean };
type Address = { ip: string; project_id: number | null; project_title: string; source: 'project' | 'unifi' };
export type UnifiClient = { key: string; name: string; ip: string; mac: string; type: string; uplink: string; connected_at: string | null; project_id: number | null; project_title: string | null };
export type Subnet = { id: number; name: string; cidr: string; vlan: number | null; gateway: string; notes: string; size: number; used: number; next_free: string | null; addresses: Address[] };
export type NetworkRegister = {
  networks: Subnet[]; unassigned: Address[];
  clients: UnifiClient[]; clients_refreshed: string | null;
  ports: { id: number; project_id: number; project_title: string; port: number; protocol: string; notes: string; source: string; host_id: number | null; host_title: string | null; host_ip: string | null }[];
  clashes: { kind: 'ip' | 'port' | 'network'; message: string; subject: string; host: { id: number; title: string } | null; projects: { id: number; title: string }[]; project_ids: number[] }[];
};
export type RunbookList = { style: 'bullets' | 'numbered'; enabled: boolean; items: ChecklistItem[] };
export type Runbook = {
  id: number; project_id: number | null; project_title: string | null; task_id: number | null; task_title: string | null;
  title: string; steps: string[]; lists: Record<'tasks' | 'requirements' | 'resources', RunbookList>; notes: string; created: string; updated: string;
  runs: number; last_run: string | null; active_run_id: number | null; test_every: number | null; test_due: string | null;
  expected: string[]; rollback: string[]; est_minutes: number | null; risk: '' | 'low' | 'medium' | 'high'; downtime: boolean;
};
export type RunbookRun = {
  id: number; runbook_id: number; runbook_title: string; project_id: number | null; project_title: string | null; task_id: number | null;
  maintenance_id: number | null; log_id: number | null; steps: string[]; ticked: number[]; notes: string; actor: string; started: string; finished: string | null;
};
export type Template = { id: number; kind: 'task' | 'project'; name: string; created: string; data: { title: string; tasks?: unknown[] } };

/** Saves a task or project as a template, asking for its name. */
export async function saveAsTemplate(kind: 'task' | 'project', fromId: number, suggested: string) {
  const name = prompt(`Save this ${kind} as a template called:`, suggested);
  if (!name?.trim()) return;
  try { await api('POST', '/templates', { kind, from_id: fromId, name }); alert(`Saved. Use it from ${kind === 'task' ? 'a project\'s Add Task box' : 'Settings → Templates or a project\'s menu'}.`); }
  catch (e) { alert((e as Error).message); }
}
export type InfraNode = { id: number; title: string; icon: string; color: string; type: string | null; kind: string | null; children: InfraNode[] };
export type Dependent = { id: number; title: string; icon: string; color: string; field: string; depth: number };
export type Attachment = { id: number; task_id: number | null; name: string; mime: string; size: number; created: string };
export type ChecklistItem = { id: number; parent_id: number | null; text: string; done: boolean; position: number };
export type Appearance = {
  theme: 'light' | 'dark' | 'system' | 'midnight' | 'paper' | 'nord' | 'dracula' | 'solarized-light' | 'solarized-dark'
    | 'forest' | 'ocean' | 'rose' | 'sand' | 'graphite' | 'catppuccin' | 'contrast'
    | 'gruvbox-dark'
    | 'gruvbox-light'
    | 'tokyo-night'
    | 'one-dark'
    | 'monokai'
    | 'everforest'
    | 'kanagawa'
    | 'rose-pine'
    | 'rose-pine-dawn'
    | 'ayu-mirage'
    | 'night-owl'
    | 'github-light'
    | 'github-dark'
    | 'synthwave';
  accent: string | null;
  font: 'jakarta' | 'figtree' | 'plex' | 'atkinson' | 'inter' | 'manrope' | 'dm-sans' | 'outfit' | 'nunito' | 'lexend' | 'source-sans' | 'system';
  taskView: 'panel' | 'page';
  nav: { order: string[]; hidden: string[] };
  showArchived: boolean;
};
export type Token = { id: number; name: string; prefix: string; created: string; last_used: string | null };
export type Filter = { field: string | number; op: string; value?: string };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${url}`, {
    method,
    headers: body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/auth/')) window.dispatchEvent(new Event('smj:logout'));
    throw new ApiError(res.status, data?.error ?? res.statusText);
  }
  return data as T;
}

export const get = <T = any>(url: string) => api<T>('GET', url);

export async function upload(file: File, taskId?: number): Promise<{ id: number; url: string }> {
  const fd = new FormData();
  if (taskId) fd.append('task_id', String(taskId));
  fd.append('file', file);
  return api('POST', '/attachments', fd);
}

export const PRIORITIES = ['Unset', 'Low', 'Medium', 'High', 'Urgent', 'Do Now'];
export const SECTIONS = [['issue', 'Issue'], ['workaround', 'Workaround'], ['resolution', 'Proposed Resolution']] as const;
export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
