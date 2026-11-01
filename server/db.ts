import { DatabaseSync } from 'node:sqlite';
import { SECTION_KEYS, htmlToLines, splitSections } from './sections.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS project_types (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  type_id INTEGER REFERENCES project_types(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  log_completed INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS buckets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket_id INTEGER REFERENCES buckets(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 5),
  due_date TEXT,
  issue TEXT NOT NULL DEFAULT '',
  workaround TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT '',
  resources TEXT NOT NULL DEFAULT '',
  checklist_style TEXT NOT NULL DEFAULT 'bullets',
  requirements_style TEXT NOT NULL DEFAULT 'bullets',
  requirements_enabled INTEGER NOT NULL DEFAULT 0,
  checklist_enabled INTEGER NOT NULL DEFAULT 0,
  resources_style TEXT NOT NULL DEFAULT 'bullets',
  resources_enabled INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS task_labels (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','number','date','select','checkbox','url','link')),
  target TEXT NOT NULL CHECK (target IN ('project','task')),
  options TEXT NOT NULL DEFAULT '[]',
  UNIQUE (name, target)
);
CREATE TABLE IF NOT EXISTS type_fields (
  type_id INTEGER NOT NULL REFERENCES project_types(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type_id, field_id)
);
-- entity_id is a project or task id depending on the field's target; cleaned up by triggers below
CREATE TABLE IF NOT EXISTS field_values (
  field_id INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (field_id, entity_id)
);
CREATE TRIGGER IF NOT EXISTS projects_del_values AFTER DELETE ON projects BEGIN
  DELETE FROM field_values WHERE entity_id = OLD.id AND field_id IN (SELECT id FROM fields WHERE target='project');
END;
CREATE TRIGGER IF NOT EXISTS tasks_del_values AFTER DELETE ON tasks BEGIN
  DELETE FROM field_values WHERE entity_id = OLD.id AND field_id IN (SELECT id FROM fields WHERE target='task');
END;
-- fields added by hand: to a project (project fields for it, task fields for all its tasks; inherited by sub-projects) or to one task
CREATE TABLE IF NOT EXISTS project_fields (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, field_id)
);
CREATE TABLE IF NOT EXISTS task_fields (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, field_id)
);
CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES checklist_items(id) ON DELETE CASCADE,
  list TEXT NOT NULL DEFAULT 'tasks',
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS checklist_task ON checklist_items(task_id, position);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'system',
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
CREATE TRIGGER IF NOT EXISTS projects_del_links AFTER DELETE ON projects BEGIN
  DELETE FROM field_values WHERE value = CAST(OLD.id AS TEXT) AND field_id IN (SELECT id FROM fields WHERE type='link');
END;
-- logbook: what was changed, when, by whom, and how to undo it
CREATE TABLE IF NOT EXISTS log_entries (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  maintenance_id INTEGER REFERENCES maintenance(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('change','incident','maintenance','observation')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  rollback TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'system',
  at TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS log_project_at ON log_entries(project_id, at);
-- runbooks: reusable procedures (steps as a JSON list of rich text), for a project and its sub-projects, one task, or global;
-- lists holds the Tasks / Requirements / Resources lists as JSON
CREATE TABLE IF NOT EXISTS runbooks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  lists TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- runbook_runs: one time a runbook was followed: which steps were ticked, notes, and the logbook entry it wrote.
-- steps is the runbook's steps when it finished (ticked holds indexes into it); finished is NULL while it is in progress.
CREATE TABLE IF NOT EXISTS runbook_runs (
  id INTEGER PRIMARY KEY,
  runbook_id INTEGER NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  maintenance_id INTEGER REFERENCES maintenance(id) ON DELETE SET NULL,
  log_id INTEGER REFERENCES log_entries(id) ON DELETE SET NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  ticked TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'system',
  started TEXT NOT NULL,
  finished TEXT
);
CREATE INDEX IF NOT EXISTS runs_runbook ON runbook_runs(runbook_id, started);
-- ideas: notes dumped against a project; status new | maybe | parked | done | rejected (reason says why not);
-- task_id is the task it became
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  reason TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ideas_project ON ideas(project_id);
-- activity: one batch of work from Claude Code or a tracked folder, waiting to be matched to a task and accepted
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('claude-code','swjtrack','mcp')),
  host TEXT NOT NULL,
  folder TEXT NOT NULL,
  batch_id TEXT UNIQUE,
  session_id TEXT,
  started TEXT,
  ended TEXT,
  summary TEXT NOT NULL DEFAULT '',
  prompts TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  commands TEXT NOT NULL DEFAULT '[]',
  commits TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','matched','accepted','dismissed')),
  suggestion TEXT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  error TEXT,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS activity_status ON activity(status, created);
-- activity_hosts: swjtrack's last report per host and folder (unsynced items, oldest), for "have you synced?" reminders
CREATE TABLE IF NOT EXISTS activity_hosts (
  host TEXT NOT NULL,
  folder TEXT NOT NULL,
  unsynced INTEGER NOT NULL DEFAULT 0,
  oldest TEXT,
  seen TEXT NOT NULL,
  reminded TEXT,
  PRIMARY KEY (host, folder)
);
-- folder_bindings: a folder (and everything under it) belongs to this project; learned from accepted activity
CREATE TABLE IF NOT EXISTS folder_bindings (
  folder TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- templates: a saved task or project (JSON) to create new ones from
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('task','project')),
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- integration secrets (channel tokens, GitHub token): write-only through the API, never exported
CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notify_channels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ntfy','gotify','homeassistant','email','webhook','pushover')),
  config TEXT NOT NULL DEFAULT '{}',
  events TEXT NOT NULL DEFAULT '["health","maintenance","update"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- health checks: an HTTP or TCP probe per project; incident_id is the open logbook incident while down
CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('http','tcp')),
  target TEXT NOT NULL,
  every_min INTEGER NOT NULL DEFAULT 5,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('up','down','unknown')),
  fails INTEGER NOT NULL DEFAULT 0,
  last_checked TEXT,
  last_change TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  last_ms INTEGER,
  incident_id INTEGER REFERENCES log_entries(id) ON DELETE SET NULL,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- latest GitHub release per project (a cache; notified = the release already announced)
CREATE TABLE IF NOT EXISTS update_checks (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  latest TEXT,
  url TEXT,
  checked TEXT,
  error TEXT NOT NULL DEFAULT '',
  notified TEXT
);
-- IP register: subnets / VLANs, and the ports services publish (addresses are the "IP Address" field)
CREATE TABLE IF NOT EXISTS networks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  cidr TEXT NOT NULL,
  vlan INTEGER,
  gateway TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS ports (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  port INTEGER NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp','udp')),
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- the clients UniFi Network last reported (a cache, refreshed every 15 minutes); key is the MAC, or UniFi's id without one
CREATE TABLE IF NOT EXISTS unifi_clients (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  mac TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  uplink TEXT NOT NULL DEFAULT '',
  connected_at TEXT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
);
-- recurring maintenance: every N units, with when it was last done and when it is next due
CREATE TABLE IF NOT EXISTS maintenance (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  every INTEGER NOT NULL CHECK (every >= 1),
  unit TEXT NOT NULL CHECK (unit IN ('day','week','month','year')),
  last_done TEXT,
  next_due TEXT NOT NULL,
  runbook_id INTEGER REFERENCES runbooks(id) ON DELETE SET NULL,
  notified_due TEXT,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), last_used TEXT);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), last_used TEXT
);
`;

type Preset = { type: string; fields: { name: string; type: string; target: string; options?: string[] }[] };

const PRESETS: Preset[] = [
  { type: 'Application', fields: [
    { name: 'Host', type: 'select', target: 'project', options: ['server1'] },
    { name: 'OS', type: 'select', target: 'project', options: ['Ubuntu', 'Debian', 'Proxmox', 'Windows', 'Raspberry Pi OS'] },
    { name: 'GitHub', type: 'url', target: 'project' },
    { name: 'Platform', type: 'select', target: 'project', options: ['Docker', 'Python', 'Node', 'ESPHome', 'Raspbian', 'Arduino'] },
    { name: 'Access', type: 'select', target: 'project', options: ['Local', 'Public'] },
    { name: 'URL', type: 'url', target: 'project' },
  ] },
  { type: 'Electronics', fields: [
    { name: 'Platform', type: 'select', target: 'project' },
    { name: 'Device', type: 'select', target: 'project', options: ['ESP32', 'ESP8266', 'Raspberry Pi', 'Arduino'] },
  ] },
  { type: 'Home Assistant', fields: [
    { name: 'Device', type: 'text', target: 'task' },
    { name: 'Connectivity', type: 'select', target: 'task', options: ['WiFi', 'Zigbee', 'Z-Wave', 'Bluetooth', 'Ethernet'] },
  ] },
];

function seed(db: DatabaseSync) {
  const getField = db.prepare('SELECT id FROM fields WHERE name=? AND target=?');
  const addField = db.prepare('INSERT INTO fields (name,type,target,options) VALUES (?,?,?,?)');
  const addType = db.prepare('INSERT INTO project_types (name) VALUES (?)');
  const link = db.prepare('INSERT INTO type_fields (type_id,field_id,position) VALUES (?,?,?)');
  for (const p of PRESETS) {
    const typeId = addType.run(p.type).lastInsertRowid;
    p.fields.forEach((f, i) => {
      const existing = getField.get(f.name, f.target) as { id: number } | undefined;
      const fid = existing?.id ?? addField.run(f.name, f.type, f.target, JSON.stringify(f.options ?? [])).lastInsertRowid;
      link.run(typeId, fid, i);
    });
  }
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL;');
  allowLinkFields(db);
  db.exec('PRAGMA foreign_keys=ON;'); // node:sqlite enables these by default; set explicitly after the rebuild above
  db.exec(SCHEMA);
  migrate(db);
  if (!db.prepare("SELECT 1 FROM meta WHERE key='seeded'").get()) {
    tx(db, () => {
      seed(db);
      db.prepare("INSERT INTO meta VALUES ('seeded','1')").run();
    });
  }
  if (!db.prepare("SELECT 1 FROM meta WHERE key='infra_seeded'").get()) {
    tx(db, () => {
      seedInfra(db);
      db.prepare("INSERT INTO meta VALUES ('infra_seeded','1')").run();
    });
  }
  if (!db.prepare("SELECT 1 FROM meta WHERE key='version_seeded'").get()) {
    tx(db, () => {
      seedVersion(db);
      db.prepare("INSERT INTO meta VALUES ('version_seeded','1')").run();
    });
  }
  return db;
}

/**
 * Older databases have a CHECK on fields.type without 'link'. SQLite can't alter a CHECK, so rebuild the table
 * (same ids, so every reference stays valid). Runs before foreign keys are switched on.
 */
function allowLinkFields(db: DatabaseSync) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fields'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'link'")) return;
  // node:sqlite turns foreign keys ON by default: with them on, DROP TABLE fields would cascade-delete every
  // field value and type link. They can only be switched off outside a transaction.
  db.exec('PRAGMA foreign_keys=OFF;');
  const brokenBefore = db.prepare('PRAGMA foreign_key_check').all().length;
  db.exec(`BEGIN;
    CREATE TABLE fields_new (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('text','number','date','select','checkbox','url','link')),
      target TEXT NOT NULL CHECK (target IN ('project','task')),
      options TEXT NOT NULL DEFAULT '[]',
      UNIQUE (name, target)
    );
    INSERT INTO fields_new (id,name,type,target,options) SELECT id,name,type,target,options FROM fields;
    -- triggers that mention fields block the rename; SCHEMA recreates them right after
    DROP TRIGGER IF EXISTS projects_del_values;
    DROP TRIGGER IF EXISTS tasks_del_values;
    DROP TRIGGER IF EXISTS projects_del_links;
    DROP TABLE fields;
    ALTER TABLE fields_new RENAME TO fields;
    COMMIT;`);
  const broken = db.prepare('PRAGMA foreign_key_check').all().length;
  if (broken > brokenBefore) throw new Error(`fields rebuild broke ${broken - brokenBefore} references; restore from backup`);
}

/** Channel kinds are a CHECK, which SQLite can't alter: rebuild notify_channels (same ids, so channel secrets still match). Nothing references it. */
function allowPushover(db: DatabaseSync) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notify_channels'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'pushover'")) return;
  tx(db, () => db.exec(`
    CREATE TABLE notify_channels_new (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('ntfy','gotify','homeassistant','email','webhook','pushover')),
      config TEXT NOT NULL DEFAULT '{}',
      events TEXT NOT NULL DEFAULT '["health","maintenance","update"]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    INSERT INTO notify_channels_new SELECT id,name,kind,config,events,enabled,created FROM notify_channels;
    DROP TABLE notify_channels;
    ALTER TABLE notify_channels_new RENAME TO notify_channels;`));
}

/** A Version field on Application, compared with the latest GitHub release. */
function seedVersion(db: DatabaseSync) {
  const hit = db.prepare("SELECT id FROM fields WHERE lower(name)='version' AND target='project'").get() as { id: number } | undefined;
  const fid = hit?.id ?? Number(db.prepare("INSERT INTO fields (name,type,target) VALUES ('Version','text','project')").run().lastInsertRowid);
  const app = db.prepare("SELECT id FROM project_types WHERE name='Application'").get() as { id: number } | undefined;
  if (app) db.prepare('INSERT OR IGNORE INTO type_fields (type_id,field_id,position) VALUES (?,?,(SELECT coalesce(max(position),0)+1 FROM type_fields WHERE type_id=?))').run(app.id, fid, app.id);
}

/** Infrastructure presets: a "Runs On" link field, a Host type, and Runs On on Application. Removable like the other presets. */
function seedInfra(db: DatabaseSync) {
  const field = (name: string, type: string, options: string[] = []) => {
    const hit = db.prepare("SELECT id FROM fields WHERE lower(name)=lower(?) AND target='project'").get(name) as { id: number } | undefined;
    return hit?.id ?? Number(db.prepare("INSERT INTO fields (name,type,target,options) VALUES (?,?,'project',?)").run(name, type, JSON.stringify(options)).lastInsertRowid);
  };
  const ids = [
    field('Kind', 'select', ['Physical', 'VM', 'LXC', 'Container', 'Device']),
    field('IP Address', 'text'),
    field('OS', 'select', ['Ubuntu', 'Debian', 'Proxmox', 'Windows', 'Raspberry Pi OS']),
    field('Runs On', 'link'),
  ];
  const runsOn = ids[3];
  const link = db.prepare('INSERT OR IGNORE INTO type_fields (type_id,field_id,position) VALUES (?,?,?)');
  if (!db.prepare("SELECT 1 FROM project_types WHERE lower(name)='host'").get()) {
    const host = Number(db.prepare("INSERT INTO project_types (name) VALUES ('Host')").run().lastInsertRowid);
    ids.forEach((fid, i) => link.run(host, fid, i));
  }
  const app = db.prepare("SELECT id FROM project_types WHERE name='Application'").get() as { id: number } | undefined;
  if (app) link.run(app.id, runsOn, (db.prepare('SELECT coalesce(max(position),0)+1 p FROM type_fields WHERE type_id=?').get(app.id) as { p: number }).p);
}

// Additive changes for databases created by older versions.
function migrate(db: DatabaseSync) {
  allowPushover(db);
  const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(c => c.name);
  for (const c of SECTION_KEYS) if (!cols.includes(c)) db.exec(`ALTER TABLE tasks ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
  const ckcols = (db.prepare('PRAGMA table_info(checklist_items)').all() as { name: string }[]).map(c => c.name);
  if (!(db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(c => c.name === 'last_used')) db.exec('ALTER TABLE sessions ADD COLUMN last_used TEXT');
  if (!ckcols.includes('parent_id')) db.exec('ALTER TABLE checklist_items ADD COLUMN parent_id INTEGER REFERENCES checklist_items(id) ON DELETE CASCADE');
  if (!ckcols.includes('list')) db.exec("ALTER TABLE checklist_items ADD COLUMN list TEXT NOT NULL DEFAULT 'tasks'");
  if (!cols.includes('requirements_style')) db.exec("ALTER TABLE tasks ADD COLUMN requirements_style TEXT NOT NULL DEFAULT 'bullets'");
  if (!cols.includes('checklist_enabled')) db.exec('ALTER TABLE tasks ADD COLUMN checklist_enabled INTEGER NOT NULL DEFAULT 1');
  if (!cols.includes('resources_style')) db.exec("ALTER TABLE tasks ADD COLUMN resources_style TEXT NOT NULL DEFAULT 'bullets'");
  if (!cols.includes('resources_enabled')) db.exec('ALTER TABLE tasks ADD COLUMN resources_enabled INTEGER NOT NULL DEFAULT 1');
  if (!cols.includes('requirements_enabled')) db.exec('ALTER TABLE tasks ADD COLUMN requirements_enabled INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('checklist_style')) db.exec("ALTER TABLE tasks ADD COLUMN checklist_style TEXT NOT NULL DEFAULT 'bullets'");
  const pcols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(c => c.name);
  if (!pcols.includes('icon')) db.exec("ALTER TABLE projects ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
  const mcols = (db.prepare('PRAGMA table_info(maintenance)').all() as { name: string }[]).map(c => c.name);
  if (mcols.length && !mcols.includes('runbook_id')) db.exec('ALTER TABLE maintenance ADD COLUMN runbook_id INTEGER REFERENCES runbooks(id) ON DELETE SET NULL');
  const portCols = (db.prepare('PRAGMA table_info(ports)').all() as { name: string }[]).map(c => c.name);
  if (portCols.length && !portCols.includes('source')) db.exec("ALTER TABLE ports ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  const ccols = (db.prepare('PRAGMA table_info(comments)').all() as { name: string }[]).map(c => c.name);
  if (ccols.length && !ccols.includes('source')) db.exec("ALTER TABLE comments ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  // channels saved before activity reminders existed: switch them on wherever maintenance alerts already go
  if (!db.prepare("SELECT 1 FROM meta WHERE key='activity_event_added'").get()) {
    const chs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notify_channels'").get()
      ? db.prepare('SELECT id, events FROM notify_channels').all() as { id: number; events: string }[] : [];
    for (const c of chs) {
      const ev = JSON.parse(c.events) as string[];
      if (ev.includes('maintenance') && !ev.includes('activity')) db.prepare('UPDATE notify_channels SET events=? WHERE id=?').run(JSON.stringify([...ev, 'activity']), c.id);
    }
    db.prepare("INSERT INTO meta VALUES ('activity_event_added','1')").run();
  }
  const rcols = (db.prepare('PRAGMA table_info(runbooks)').all() as { name: string }[]).map(c => c.name);
  if (rcols.length && !rcols.includes('task_id')) db.exec('ALTER TABLE runbooks ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL');
  if (rcols.length && !rcols.includes('lists')) db.exec("ALTER TABLE runbooks ADD COLUMN lists TEXT NOT NULL DEFAULT '{}'");
  // rollback steps, an expected result per step (same order as steps), time estimate, risk, downtime
  if (rcols.length && !rcols.includes('rollback')) db.exec(`ALTER TABLE runbooks ADD COLUMN rollback TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE runbooks ADD COLUMN expected TEXT NOT NULL DEFAULT '[]'; ALTER TABLE runbooks ADD COLUMN est_minutes INTEGER;
    ALTER TABLE runbooks ADD COLUMN risk TEXT NOT NULL DEFAULT ''; ALTER TABLE runbooks ADD COLUMN downtime INTEGER NOT NULL DEFAULT 0;`);
  // test_every: months between test runs (NULL = no reminder)
  if (rcols.length && !rcols.includes('test_every')) db.exec('ALTER TABLE runbooks ADD COLUMN test_every INTEGER');
  // changed_at: last change made outside the browser (Claude, API, monitors, accepted activity); seen_at: last opened in the browser
  for (const t of ['tasks', 'projects']) {
    const c = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(x => x.name);
    if (!c.includes('changed_at')) db.exec(`ALTER TABLE ${t} ADD COLUMN changed_at TEXT`);
    if (!c.includes('seen_at')) db.exec(`ALTER TABLE ${t} ADD COLUMN seen_at TEXT`);
    // closed: completed | abandoned | on_hold (NULL = open); closure: its notes etc. as JSON
    if (!c.includes('closed')) db.exec(`ALTER TABLE ${t} ADD COLUMN closed TEXT; ALTER TABLE ${t} ADD COLUMN closure TEXT;`);
    // repeat: {every, unit, from} as JSON for repeating tasks (recurring.ts)
    if (t === 'tasks' && !c.includes('repeat')) db.exec('ALTER TABLE tasks ADD COLUMN repeat TEXT');
  }
  if (mcols.length && !mcols.includes('notified_due')) db.exec('ALTER TABLE maintenance ADD COLUMN notified_due TEXT');
  if (!pcols.includes('log_completed')) db.exec('ALTER TABLE projects ADD COLUMN log_completed INTEGER');
  if (!db.prepare("SELECT 1 FROM meta WHERE key='sections_split'").get()) {
    tx(db, () => {
      splitExistingDescriptions(db);
      db.prepare("INSERT INTO meta VALUES ('sections_split','1')").run();
    });
  }
  if (!db.prepare("SELECT 1 FROM meta WHERE key='resources_listified'").get()) {
    tx(db, () => {
      listifyResources(db);
      db.prepare("INSERT INTO meta VALUES ('resources_listified','1')").run();
    });
  }
  if (!db.prepare("SELECT 1 FROM meta WHERE key='lists_off_by_default'").get()) {
    tx(db, () => {
      listsOffUnlessUsed(db);
      db.prepare("INSERT INTO meta VALUES ('lists_off_by_default','1')").run();
    });
  }
}

/** One-off: tasks written before sections existed keep Issue/Workaround/... as headings in the description. */
export function splitExistingDescriptions(db: DatabaseSync) {
  const rows = db.prepare(`SELECT id, description FROM tasks WHERE ${SECTION_KEYS.map(k => `${k}=''`).join(' AND ')}`).all() as { id: number; description: string }[];
  for (const r of rows) {
    const parts = splitSections(r.description);
    if (SECTION_KEYS.every(k => !parts[k])) continue;
    db.prepare(`UPDATE tasks SET description=?, ${SECTION_KEYS.map(k => `${k}=?`).join(', ')} WHERE id=?`)
      .run(parts.description, ...SECTION_KEYS.map(k => parts[k] ?? ''), r.id);
  }
}

/** One-off: Resources used to be rich text; turn each paragraph/list item into a resource item and clear the old text. */
export function listifyResources(db: DatabaseSync) {
  const rows = db.prepare("SELECT id, resources FROM tasks WHERE resources<>''").all() as { id: number; resources: string }[];
  const insert = db.prepare("INSERT INTO checklist_items (task_id,list,text,position) VALUES (?,'resources',?,?)");
  for (const r of rows) {
    const start = (db.prepare("SELECT coalesce(max(position),0) p FROM checklist_items WHERE task_id=? AND list='resources' AND parent_id IS NULL").get(r.id) as { p: number }).p;
    htmlToLines(r.resources).forEach((line, i) => insert.run(r.id, line, start + i + 1));
    db.prepare("UPDATE tasks SET resources='' WHERE id=?").run(r.id);
  }
}

/** One-off: Tasks and Resources used to start switched on; now every list starts off, so keep only lists that already have items on. */
export function listsOffUnlessUsed(db: DatabaseSync) {
  const used = (list: string) => `EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.task_id=tasks.id AND ci.list='${list}')`;
  db.exec(`UPDATE tasks SET checklist_enabled=${used('tasks')}, resources_enabled=${used('resources')}`);
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
