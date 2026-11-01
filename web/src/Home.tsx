import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, FolderKanban, ListTodo, NotebookPen, Server } from 'lucide-react';
import { get, type Activity, type HealthCheck, type LogEntry, type Maintenance, type Task, type Update } from './api';
import { LOG_KINDS } from './Logbook';
import { ProjectIcon } from './icons';
import { useData } from './App';
import { ago, Prio } from './ui';

type Summary = {
  done_week: number; done_prev_week: number;
  projects: { id: number; title: string; color: string; icon: string; closed: string | null; open: number; done: number }[];
  backup: { last: string | null; kept: number; drive: boolean; drive_last: { name: string; at: string } | null; drive_error: string | null };
  hosts: { host: string; folders: number; unsynced: number; seen: string }[];
  claude: { input: number; output: number };
  network: { subnets: number; ports: number; clients: number };
  last_run: { runbook_id: number; title: string; started: string; finished: string | null } | null;
  runbook_tests: { id: number; title: string; test_due: string; last_run: string | null }[];
  version: string;
};
type Data = { checks: HealthCheck[]; maint: Maintenance[]; tasks: Task[]; activity: Activity[]; log: LogEntry[]; updates: Update[]; sum: Summary };

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const nice = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 864e5);
const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** One figure in the status line: a label, the value (red when it needs you) and a short note; links to where it lives. */
function Stat({ label, value, note, href, bad }: { label: string; value: ReactNode; note: ReactNode; href: string; bad?: boolean }) {
  return (
    <a className={`home-stat ${bad ? 'bad' : ''}`} href={href}>
      <span className="home-stat-label">{label}</span>
      <span className="home-stat-value">{value}</span>
      <span className="home-stat-note">{note}</span>
    </a>
  );
}

function Panel({ area, icon, title, link, children }: { area: string; icon: ReactNode; title: string; link?: [string, string]; children: ReactNode }) {
  return (
    <section className={`card home-panel area-${area}`} aria-label={title}>
      <header className="home-panel-head">{icon}<h2>{title}</h2>{link && <a href={link[0]}>{link[1]} →</a>}</header>
      <div className="home-panel-body">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="home-empty"><CheckCircle2 size={15} />{children}</p>;

/** Home: what needs you, what's next and how everything is doing, on one screen. */
export function HomePage() {
  const { projects } = useData();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const week = new Date(Date.now() - 7 * 864e5).toISOString();
    Promise.all([
      get<HealthCheck[]>('/health-checks'), get<Maintenance[]>('/maintenance'), get<Task[]>('/tasks?done=false&limit=1000'),
      get<Activity[]>('/activity?limit=200'), get<LogEntry[]>(`/log?since=${encodeURIComponent(week)}&limit=14`), get<Update[]>('/updates'), get<Summary>('/home'),
    ]).then(([checks, maint, tasks, activity, log, updates, sum]) => setD({ checks, maint, tasks, activity, log, updates, sum }))
      .catch(e => setErr((e as Error).message));
  }, []);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const todayLong = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  if (err) return <div className="page"><p className="error">{err}</p></div>;
  if (!d) return (
    <div className="page home" aria-busy="true">
      <header className="page-header"><h1 className="page-title">{greeting}</h1><p className="lede">{todayLong}</p></header>
      <div className="home-status skeleton" />
      <div className="home-board">{['next', 'svc', 'soon', 'log', 'proj'].map(a => <section key={a} className={`card home-panel area-${a} skeleton`} />)}</div>
    </div>
  );

  const today = day(new Date()), inWeek = day(new Date(Date.now() + 7 * 864e5)), inFortnight = day(new Date(Date.now() + 14 * 864e5));
  const { sum } = d;
  const checks = d.checks.filter(c => c.enabled).sort((a, b) => Number(b.status === 'down') - Number(a.status === 'down') || a.project_title.localeCompare(b.project_title));
  const down = checks.filter(c => c.status === 'down');
  const overdueMaint = d.maint.filter(m => m.status === 'overdue');
  const live = d.tasks.filter(t => t.closed !== 'on_hold');
  const overdueTasks = live.filter(t => t.due_date && t.due_date.slice(0, 10) < today);
  // on-hold tasks and projects come back on their review date
  const held = [
    ...d.tasks.filter(t => t.closed === 'on_hold' && t.closure?.review_on).map(t => ({ key: `ht${t.id}`, date: t.closure!.review_on!, title: t.title, where: t.project_title, href: `#/t/${t.id}` })),
    ...projects.filter(p => p.closed === 'on_hold' && p.closure?.review_on).map(p => ({ key: `hp${p.id}`, date: p.closure!.review_on!, title: p.title, where: 'Project', href: `#/p/${p.id}` })),
  ];
  const reviewDue = held.filter(h => h.date <= today);
  const testsDue = sum.runbook_tests.filter(r => r.test_due <= today);
  const attention = down.length + overdueMaint.length + overdueTasks.length + reviewDue.length + testsDue.length;
  const waiting = d.activity.filter(a => a.status === 'pending' || a.status === 'matched');
  const changed = d.tasks.filter(t => t.unseen);
  const updates = d.updates.filter(u => u.update_available);
  const urgent = live.filter(t => t.priority >= 3).length;
  const dueWeekMaint = d.maint.filter(m => m.next_due >= today && m.next_due <= inWeek);

  // highest priority first, then soonest due, then most recently changed
  const next = [...live].sort((a, b) => b.priority - a.priority || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || b.updated.localeCompare(a.updated));
  const maint = [...d.maint].sort((a, b) => a.next_due.localeCompare(b.next_due)).slice(0, 5);
  const soon = [
    ...d.maint.filter(m => m.next_due >= today && m.next_due <= inFortnight).map(m => ({ key: `m${m.id}`, date: m.next_due, title: m.title, where: m.project_title, href: '#/maintenance', kind: 'Maintenance' })),
    ...live.filter(t => t.due_date && t.due_date.slice(0, 10) >= today && t.due_date.slice(0, 10) <= inFortnight)
      .map(t => ({ key: `t${t.id}`, date: t.due_date!.slice(0, 10), title: t.title, where: t.project_title, href: `#/t/${t.id}`, kind: 'Task' })),
    ...held.filter(h => h.date > today && h.date <= inFortnight).map(h => ({ ...h, kind: 'Review on hold' })),
    ...sum.runbook_tests.filter(r => r.test_due > today && r.test_due <= inFortnight)
      .map(r => ({ key: `r${r.id}`, date: r.test_due, title: r.title, where: r.last_run ? `last run ${nice(r.last_run.slice(0, 10))}` : 'never run', href: `#/runbooks/${r.id}`, kind: 'Runbook test' })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const logDays = d.log.reduce<[string, LogEntry[]][]>((acc, e) => {
    const key = day(new Date(e.at));
    const last = acc[acc.length - 1];
    if (last?.[0] === key) last[1].push(e); else acc.push([key, [e]]);
    return acc;
  }, []);
  const dayLabel = (ymd: string) => { const n = daysBetween(ymd, today); return n === 0 ? 'Today' : n === 1 ? 'Yesterday' : new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' }); };
  const dueText = (ymd: string) => { const n = daysBetween(today, ymd); return n < 0 ? `${plural(-n, 'day')} overdue` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : nice(ymd); };
  const backupAge = sum.backup.last ? (Date.now() - Date.parse(sum.backup.last)) / 36e5 : Infinity;

  const lede = attention + waiting.length + changed.length === 0 ? 'Nothing needs you right now.'
    : [attention && `${plural(attention, 'thing')} need${attention === 1 ? 's' : ''} attention`, waiting.length && `${waiting.length} activit${waiting.length === 1 ? 'y' : 'ies'} to review`,
      changed.length && `${plural(changed.length, 'task')} changed outside SWunja`].filter(Boolean).join(' · ');

  return (
    <div className="page home">
      <header className="page-header">
        <h1 className="page-title">{greeting}</h1>
        <p className="lede">{todayLong} · {lede}</p>
      </header>

      <nav className="home-status" aria-label="At a glance">
        <Stat label="Open Tasks" value={live.length} href="#/" note={urgent ? `${urgent} high or urgent` : 'none high or urgent'} />
        <Stat label="Done This Week" value={sum.done_week} href="#/logbook" note={`${sum.done_prev_week} the week before`} />
        <Stat label="Services" href="#/infra" bad={down.length > 0} value={checks.length ? `${checks.length - down.length}/${checks.length} up` : '–'}
          note={!checks.length ? 'no health checks yet' : down.length ? `${down.map(c => c.project_title).join(', ')} down` : 'all responding'} />
        <Stat label="Maintenance" href="#/maintenance" bad={overdueMaint.length > 0} value={overdueMaint.length ? `${overdueMaint.length} overdue` : dueWeekMaint.length ? `${dueWeekMaint.length} due` : 'On track'}
          note={maint[0] ? `next: ${maint[0].title}, ${dueText(maint[0].next_due)}` : 'nothing scheduled'} />
        <Stat label="Last Backup" href="#/settings/backups" bad={backupAge > 36 || !!sum.backup.drive_error} value={sum.backup.last ? ago(sum.backup.last) : 'Never'}
          note={sum.backup.drive_error ? 'Google Drive copy failed' : sum.backup.drive ? 'copied to Google Drive' : `${sum.backup.kept} kept on this server`} />
        <Stat label="Updates" href={updates[0] ? `#/p/${updates[0].project_id}` : '#/infra'} value={updates.length || 'None'}
          note={updates.length ? updates.map(u => `${u.project_title} ${u.latest}`).join(', ') : d.updates.length ? `${plural(d.updates.length, 'repo')} up to date` : 'no GitHub repos tracked'} />
      </nav>

      {attention > 0 && (
        <section className="home-attention" aria-label="Needs attention">
          <AlertTriangle size={16} /><strong>Needs attention</strong>
          <ul>
            {down.map(c => <li key={`c${c.id}`}><a href={`#/p/${c.project_id}`}>{c.project_title}</a> down{c.last_change && ` for ${ago(c.last_change).replace(' ago', '')}`}</li>)}
            {overdueMaint.map(m => <li key={`m${m.id}`}><a href="#/maintenance">{m.title}</a> {dueText(m.next_due)}</li>)}
            {overdueTasks.map(t => <li key={`t${t.id}`}><a href={`#/t/${t.id}`}>{t.title}</a> {dueText(t.due_date!.slice(0, 10))}</li>)}
            {reviewDue.map(h => <li key={h.key}><a href={h.href}>{h.title}</a> on hold, due for review</li>)}
            {testsDue.map(r => <li key={`r${r.id}`}><a href={`#/runbooks/${r.id}`}>{r.title}</a> {r.last_run ? `not run since ${nice(r.last_run.slice(0, 10))}` : 'never run'}, due a test</li>)}
          </ul>
        </section>
      )}

      <div className="home-board">
        <Panel area="next" icon={<ListTodo size={16} />} title="Up Next" link={['#/', 'All Tasks']}>
          {next.length ? <ol className="home-rows">
            {next.slice(0, 14).map(t => {
              const due = t.due_date?.slice(0, 10);
              return <li key={t.id} className={t.unseen ? 'unseen' : ''}>
                <span className="home-prio">{t.priority ? <Prio p={t.priority} /> : null}</span>
                <a className="home-row-title" href={`#/t/${t.id}`}>{t.title}</a>
                <span className="home-row-meta">{t.project_title}{due && <> · <span className={due < today ? 'late' : ''}>{dueText(due)}</span></>}</span>
              </li>;
            })}
          </ol> : <Empty>No open tasks. Add one from any project.</Empty>}
          {next.length > 14 && <a className="home-more" href="#/">{next.length - 14} more open tasks →</a>}
        </Panel>

        <Panel area="svc" icon={<Server size={16} />} title="Services" link={['#/infra', 'Infrastructure']}>
          {checks.length ? <ul className="home-services">
            {checks.map(c => <li key={c.id} className={c.status}>
              <span className="home-dot" aria-label={c.status} />
              <a href={`#/p/${c.project_id}`}>{c.project_title}</a>
              <span className="home-row-meta">{c.status === 'down' ? 'down' : c.last_ms !== null ? `${c.last_ms} ms` : 'waiting'}</span>
            </li>)}
          </ul> : <Empty>No health checks yet. Add one from a project's Details card.</Empty>}
          <h3 className="home-sub">Maintenance <a href="#/maintenance">All →</a></h3>
          {maint.length ? <ul className="home-rows compact">
            {maint.map(m => <li key={m.id}>
              <a className="home-row-title" href="#/maintenance">{m.title}</a>
              <span className={`home-row-meta ${m.status === 'overdue' ? 'late' : ''}`}>{dueText(m.next_due)}</span>
            </li>)}
          </ul> : <Empty>No recurring maintenance set up.</Empty>}
        </Panel>

        <Panel area="soon" icon={<CalendarClock size={16} />} title="Coming Up" link={['#/maintenance', 'Next 14 days']}>
          {soon.length ? <ul className="home-rows compact">
            {soon.slice(0, 8).map(x => <li key={x.key}>
              <span className="home-date">{dueText(x.date)}</span>
              <a className="home-row-title" href={x.href}>{x.title}</a>
              <span className="home-row-meta">{x.kind} · {x.where}</span>
            </li>)}
          </ul> : <Empty>Nothing due in the next 14 days.</Empty>}
          <h3 className="home-sub">Waiting on You</h3>
          {waiting.length + changed.length ? <ul className="home-rows compact">
            {waiting.length > 0 && <li><a className="home-row-title" href="#/activity">{plural(waiting.length, 'activity item')} to review</a><span className="home-row-meta">{[...new Set(waiting.map(a => a.host))].join(', ')}</span></li>}
            {changed.slice(0, 4).map(t => <li key={t.id}><span className="pill unseen-pill">{t.unseen === 'new' ? 'New' : 'Updated'}</span><a className="home-row-title" href={`#/t/${t.id}`}>{t.title}</a></li>)}
          </ul> : <Empty>Nothing from Claude, the API or swjtrack.</Empty>}
        </Panel>

        <Panel area="log" icon={<NotebookPen size={16} />} title="Recent Changes" link={['#/logbook', 'Logbook']}>
          {logDays.length ? logDays.map(([k, es]) => (
            <div key={k} className="home-day">
              <h3 className="home-sub">{dayLabel(k)}</h3>
              <ul className="home-rows compact">
                {es.map(e => <li key={e.id}>
                  <span className={`pill log-kind kind-${e.kind}`}>{LOG_KINDS.find(x => x[0] === e.kind)?.[1]}</span>
                  <a className="home-row-title" href={e.task_id ? `#/t/${e.task_id}` : `#/p/${e.project_id}`}>{e.title}</a>
                  <span className="home-row-meta">{e.project_title}</span>
                </li>)}
              </ul>
            </div>
          )) : <Empty>Nothing logged in the last 7 days.</Empty>}
        </Panel>

        <Panel area="proj" icon={<FolderKanban size={16} />} title="Projects">
          <ul className="home-rows compact home-projects">
            {sum.projects.map(p => {
              const total = p.open + p.done;
              return <li key={p.id}>
                <ProjectIcon icon={p.icon} color={p.color} size={15} />
                <a className="home-row-title" href={`#/p/${p.id}`}>{p.title}</a>
                {p.closed === 'on_hold' ? <span className="pill closed-pill on_hold">On Hold</span>
                  : <span className="home-row-meta">{p.open ? `${p.open} open` : total ? 'all done' : 'no tasks'}</span>}
                <span className="home-bar" role="img" aria-label={`${p.done} of ${total} done`}><i style={{ width: `${total ? (p.done / total) * 100 : 0}%` }} /></span>
              </li>;
            })}
          </ul>
        </Panel>
      </div>

      <footer className="home-system" aria-label="System">
        <span><b>Backups</b> {sum.backup.kept} kept{sum.backup.drive && (sum.backup.drive_last ? `, Drive ${ago(sum.backup.drive_last.at)}` : ', Drive connected')}</span>
        <span><b>swjtrack</b> {sum.hosts.length ? sum.hosts.map(h => `${h.host} ${ago(h.seen)}${h.unsynced ? ` (${h.unsynced} unsynced)` : ''}`).join(', ') : 'no hosts yet'}</span>
        <span><b>Claude</b> {kTokens(sum.claude.input + sum.claude.output)} tokens this month</span>
        <span><b>Network</b> {plural(sum.network.subnets, 'subnet')}, {plural(sum.network.ports, 'port')}, {sum.network.clients} UniFi clients</span>
        <span><b>Last runbook</b> {sum.last_run ? <a href={`#/runbooks/${sum.last_run.runbook_id}`}>{sum.last_run.title}</a> : 'none run yet'}{sum.last_run && `, ${ago(sum.last_run.finished ?? sum.last_run.started)}`}</span>
        <span><b>SWunja</b> <a href="#/settings/about">v{sum.version}</a></span>
      </footer>
    </div>
  );
}
