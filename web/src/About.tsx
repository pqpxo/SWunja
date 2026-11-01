import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff } from 'lucide-react';
import { api, get, type Appearance } from './api';
import { useData } from './App';
import { orderedNav } from './nav';
import { CHANGELOG } from './changelog';

/** Settings → Navigation: reorder and hide the sidebar's menu items. */
export function NavTab() {
  const { appearance: a, setAppearance } = useData();
  const [err, setErr] = useState('');
  const items = orderedNav(a);
  const hidden = new Set(a.nav.hidden);
  const save = async (patch: Partial<Appearance>) => {
    try { setErr(''); setAppearance(await api<Appearance>('PUT', '/appearance', patch)); } catch (e) { setErr((e as Error).message); }
  };
  const move = (i: number, by: number) => {
    const ids = items.map(x => x.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    save({ nav: { order: ids, hidden: a.nav.hidden } });
  };
  const toggle = (id: string) => save({ nav: { order: items.map(x => x.id), hidden: hidden.has(id) ? a.nav.hidden.filter(x => x !== id) : [...a.nav.hidden, id] } });
  return (
    <>
      <section className="card">
        <h2 className="card-title">Sidebar Menu</h2>
        <p className="muted">Put the pages you use most at the top and hide the ones you don't. Settings always stays at the bottom.</p>
        <ul className="nav-editor">
          {items.map((it, i) => (
            <li key={it.id} className={hidden.has(it.id) ? 'off' : ''}>
              <it.icon size={17} /><span className="grow">{it.label}</span>
              <button className="icon-btn" aria-label={`${hidden.has(it.id) ? 'Show' : 'Hide'} ${it.label}`} title={hidden.has(it.id) ? 'Show' : 'Hide'} onClick={() => toggle(it.id)}>
                {hidden.has(it.id) ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              <button className="icon-btn" aria-label={`Move ${it.label} up`} title="Move Up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={15} /></button>
              <button className="icon-btn" aria-label={`Move ${it.label} down`} title="Move Down" disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown size={15} /></button>
            </li>
          ))}
        </ul>
        <button className="ghost" onClick={() => save({ nav: { order: [], hidden: ['projects'] } })}>Reset to Default</button>
      </section>
      <section className="card">
        <h2 className="card-title">Projects</h2>
        <label className="check"><input type="checkbox" checked={a.showArchived} onChange={e => save({ showArchived: e.target.checked })} /> Show archived projects in the sidebar</label>
        <p className="hint">Archived projects can always be found with Search (Ctrl K).</p>
      </section>
      {err && <p className="error">{err}</p>}
    </>
  );
}

const GUIDE: [string, string[]][] = [
  ['Projects and Sub-Projects', [
    'Add a project with New Project at the bottom of the sidebar, and a sub-project with + Sub-Project on its page. Sub-projects inherit their parent\'s type and icon until you give them their own.',
    'A project type (Settings → Project Types) decides which custom fields a project and its tasks have, such as Host, OS, IP Address or Runs On.',
    'The details panel on the right of a project holds its fields, health checks, what uses it, and notes. The ⋯ menu moves, archives, deletes or saves it as a template.',
  ]],
  ['Tasks', [
    'Type in Add a task and press Enter. Open a task for its description, the Issue / Workaround / Proposed Resolution sections, the Tasks, Requirements and Resources lists, labels, attachments, comments and history.',
    'List shows tasks A to Z; Board lets you drag them between columns. Completing a task writes a Change entry to the project\'s logbook (switch this off with Log Completed).',
  ]],
  ['Logbook, Maintenance and Runbooks', [
    'The Logbook records changes, incidents, maintenance and observations, with rollback steps. Other tools can write to it through the logbook webhook (Settings → API Tokens & MCP).',
    'Maintenance holds recurring jobs with when they were last done and when they are next due. Marking one done logs it; overdue jobs show a badge in the sidebar and can notify you.',
    'Runbooks are step-by-step procedures. Each step is rich text (headings, code, links), and a runbook has the same Tasks, Requirements and Resources lists as a task. Applies To picks a project, then a sub-project, then a task, or N/A.',
    'Start Run on a runbook to follow it: ticks are saved as you go (you can stop and come back), and Finish Run writes a logbook entry with how many steps were done, which were skipped, and your notes. Run History shows every run.',
    'Attach a runbook to a maintenance job and its steps appear as a checklist when you mark the job done; that counts as a run too.',
  ]],
  ['Infrastructure and Network', [
    'Set Runs On to link an app to its container, a container to its VM or LXC, and that to its host. Infrastructure shows the tree; What Depends On answers "what breaks if this goes down?".',
    'Network lists your subnets and VLANs, which project holds each address (from the IP Address field), the ports services publish, UniFi clients, and clashes such as one address on two machines.',
  ]],
  ['Activity', [
    'The Activity page collects work done elsewhere: Claude Code sessions and folders tracked with swjtrack on your Linux hosts. Each item shows the task it most likely belongs to; Claude picks it when an API key is set in Settings → Integrations, otherwise it is matched by shared words.',
    'Accept adds a comment marked "Suggestion from agent" and an activity record (every command and file) to that task’s history; nothing else on the task changes. Pick Another or Create Task choose a different home, and Dismiss drops it. Accepting also remembers which project that folder belongs to.',
  ]],
  ['Monitoring and Notifications', [
    'Add a health check (HTTP or TCP) in a project\'s details. Two failures in a row mark it down, log an incident and send a notification; recovery is added to the same incident.',
    'Settings → Integrations sets up notifications (ntfy, Gotify, Pushover, Home Assistant, email, webhook) and GitHub release checks, which compare a project\'s Version field with its latest release.',
  ]],
  ['Imports', [
    'Proxmox and UniFi Network (Settings → Integrations) bring in hosts, VMs, containers, devices, networks and addresses. Always Preview first; running an import again updates what is there instead of adding copies.',
    'Settings → Import & Export downloads everything as one file, and imports a SWunja (or older Samunja) or Vikunja export.',
  ]],
  ['Shortcuts and Search', [
    'Ctrl K (Cmd K on a Mac) searches projects, tasks, the logbook, maintenance and runbooks. On a project, / jumps to the task search box.',
    'Templates (Settings → Templates) create a task or a whole project with its fields, lists and tasks already filled in.',
  ]],
  ['Claude and the API', [
    'Create a token in Settings → API Tokens & MCP. Claude Code connects to the MCP endpoint shown there and can read and update everything you can, from projects and tasks to the logbook, network and imports.',
    'Backups (Settings → Backups) run on a schedule and are kept in the data volume; connect Google Drive there to keep copies off this server too.',
  ]],
];

/** Settings → About: version, what SWunja is, and how to use it. */
export function AboutTab() {
  const [info, setInfo] = useState<{ version: string; node: string; started: string } | null>(null);
  useEffect(() => { get('/info').then(setInfo).catch(() => {}); }, []);
  return (
    <>
      <section className="card about">
        <h2 className="card-title"><img className="about-logo" src="/logo.png" alt="" />SWunja</h2>
        <p>A self-hosted task tracker for a homelab: projects and tasks with custom fields, plus a logbook, recurring maintenance, runbooks, ideas, an infrastructure map,
          an IP and port register, health checks with notifications, and imports from Proxmox and UniFi. Claude can work with all of it over MCP.</p>
        <dl className="about-facts">
          <dt>Version</dt><dd>{info?.version ?? '…'}</dd>
          <dt>Server</dt><dd>Node.js {info?.node.replace(/^v/, '') ?? '…'}, SQLite</dd>
          <dt>Running Since</dt><dd>{info ? new Date(info.started).toLocaleString() : '…'}</dd>
        </dl>
      </section>
      <details className="card changelog-card">
        <summary><h2 className="card-title">Changelog <span className="muted small">· {CHANGELOG.length} releases</span></h2></summary>
        {CHANGELOG.map((r, i) => (
          <details key={r.version} className="guide changelog" open={i === 0}>
            <summary>{r.version} <span className="muted small">· {new Date(`${r.date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span></summary>
            <ul>{r.changes.map((c, j) => <li key={j}>{c}</li>)}</ul>
          </details>
        ))}
      </details>
      <section className="card">
        <h2 className="card-title">How to Use It</h2>
        {GUIDE.map(([title, paras], i) => (
          <details key={title} className="guide" open={i === 0}>
            <summary>{title}</summary>
            {paras.map((p, j) => <p key={j}>{p}</p>)}
          </details>
        ))}
      </section>
    </>
  );
}
