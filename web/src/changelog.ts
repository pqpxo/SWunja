// What changed in each release, newest first; shown in Settings → About.
// Every release bumps "version" in package.json and adds its entry here (server/version.test.ts checks they match).
export type Release = { version: string; date: string; changes: string[] };

export const CHANGELOG: Release[] = [
  {
    version: '1.19.0', date: '2026-11-01', changes: [
      'Dismissed activity can be brought back: on the Activity page\'s Dismissed tab, Restore moves an item back to Waiting with its suggestion, ready to accept.',
      'Fix: ignoring a folder in swjtrack made its files show up as deleted in the next sync. Files that are now ignored are dropped quietly instead, and anything already waiting for an ignored path is left out of the sync. Your files were never touched; swjtrack only reads folders.',
      'The agent is now 1.3.1; swjtrack update gets it.',
    ],
  },
  {
    version: '1.18.0', date: '2026-11-01', changes: [
      'swjtrack --menu: Monitored folders has an Ignored files and folders section to show, add and remove ignores.',
      'swjtrack --menu: Sync has View waiting changes, which lists the files, commands and git commits the next sync would send, for one folder or all of them. Viewing sends nothing.',
      'The agent is now 1.3.0; swjtrack update gets it.',
    ],
  },
  {
    version: '1.17.0', date: '2026-11-01', changes: [
      'swjtrack --menu opens an arrow-key menu on Linux hosts: add, replace or remove the API token (checked before saving), show, add or remove tracked folders, run a sync, set or change each folder\'s check-in interval, and update the agent.',
      'The agent is now 1.2.0. Hosts with 1.1.0 can get it with swjtrack update.',
    ],
  },
  {
    version: '1.16.0', date: '2026-11-01', changes: [
      'swjtrack can ignore whole folders: swjtrack ignore /srv/app/secrets (or ~/x, ./x) skips the files in it, commands typed there and Claude Code sessions run there. Names and globs such as backups or *.tmp still work, and now also skip matching folders.',
      'swjtrack ignore on its own lists what is ignored, and swjtrack unignore removes an entry.',
      'swjtrack update fetches the latest agent from your SWunja server and restarts its folder watcher. It only replaces itself with a script that would actually run. The agent is now 1.1.0; older agents need reinstalling once with the install command to get update.',
    ],
  },
  {
    version: '1.15.0', date: '2026-11-01', changes: [
      'Security fixes from a review before going public. None needed a login to exploit except where noted.',
      'Wrong passwords are slowed down: after 5 from one address it has to wait (1 second, doubling up to 15 minutes), and past 30 in a minute every login waits a minute.',
      'The swjtrack installer only accepts a plain server address, so a crafted Host header can no longer put commands into the install script.',
      'Proxmox and UniFi certificates are remembered the first time SWunja connects. If the certificate changes, SWunja refuses to send the API key and says so; after renewing a certificate, press Forget Certificate in Settings → Integrations.',
      'Reverse-proxy headers (X-Forwarded-*) are only trusted from private addresses. Set TRUST_PROXY to change that.',
      'Every page is served with a strict Content Security Policy, and SWunja can no longer be shown inside another site\'s frame.',
      'Logins now end after 90 days unused, and an import that would unpack to more than 1 GB is refused (you need to be logged in for both).',
    ],
  },
  {
    version: '1.14.2', date: '2026-11-01', changes: [
      'The Ideas tab now sits next to List, before Board.',
    ],
  },
  {
    version: '1.14.1', date: '2026-11-01', changes: [
      'The Changelog on Settings → About is now collapsed by default; click it to see the releases.',
    ],
  },
  {
    version: '1.14.0', date: '2026-11-01', changes: [
      'Every project has an Ideas tab: type an idea and press Enter to note it, add notes underneath, edit or delete it. Pinned ideas stay at the top, then newest first.',
      'Each idea has a status (New, Maybe, Parked, Done or Rejected) and an optional reason for rejected or parked ones. Rejected ideas are hidden unless you pick Rejected or All.',
      'Make Task turns an idea into a task in the same project with its notes carried over; the idea is marked Done and shows "Became task #N".',
      'With Sub-Projects on, a project also shows the ideas from its sub-projects. Ctrl+K search finds ideas.',
      'New MCP tools: ideas_list, ideas_add, ideas_update, ideas_to_task and ideas_delete, so you can ask Claude to "note an idea for X".',
    ],
  },
  {
    version: '1.13.1', date: '2026-11-01', changes: [
      'Works behind an HTTPS reverse proxy such as Nginx Proxy Manager: the swjtrack installer now points hosts at the https address you used, and the login cookie is marked Secure over HTTPS.',
    ],
  },
  {
    version: '1.13.0', date: '2026-11-01', changes: [
      'Runbooks can ask to be tested: set Test Every (1 to 24 months) when editing one. The runbook page shows when the next test is due, counted from its last run (or from when it was made if it has never been run).',
      'Once a test is due, the runbook gets a red Test Due pill and appears in the Needs Attention bar on Home; in the two weeks before, it shows in Coming Up.',
      'The MCP tools runbooks_create and runbooks_update take test_every.',
    ],
  },
  {
    version: '1.12.0', date: '2026-11-01', changes: [
      'Repeating tasks: set Repeat in a task\'s side card to every N days, weeks, months or years, counted from the due date or from when it was done.',
      'Ticking a repeating task done (or closing it as Completed) keeps it in history and adds the next one with the new due date, copying the description, labels, fields and lists with every item unticked. Abandoning it stops the repeat.',
      'On Hold can now have a Review On date. On that day it appears in the Needs Attention bar on Home, and it shows in Coming Up during the two weeks before.',
      'The MCP tools tasks_create and tasks_update take repeat, and tasks_close / projects_close take review_on.',
    ],
  },
  {
    version: '1.11.0', date: '2026-10-31', changes: [
      'New Home page that fills the screen. A status line along the top shows open tasks, tasks done this week, services up, maintenance, the last backup and available updates; each one links to its page and turns red when it needs you.',
      'A red Needs Attention bar appears only when a service is down, maintenance is overdue or a task is past due.',
      'Up Next lists open tasks by priority, then due date. Services shows every health check with its response time, alongside the maintenance schedule.',
      'Coming Up covers the next 14 days plus anything waiting on you; Recent Changes shows the logbook by day; Projects shows each top-level project with its open tasks and progress.',
      'A footer line shows backups (and their latest Google Drive copy), swjtrack hosts, Claude usage, the network register, the last runbook run and the SWunja version.',
    ],
  },
  {
    version: '1.10.4', date: '2026-10-31', changes: [
      'GitHub: a repository with no releases or tags now says so (with when it was checked) instead of "Release not checked yet".',
    ],
  },
  {
    version: '1.10.3', date: '2026-10-30', changes: [
      'Close Task is now a button under History (and Close Project one at the bottom of the project details card) instead of in the ⋯ menu; once closed it becomes Reopen, or Resume for On Hold.',
    ],
  },
  {
    version: '1.10.2', date: '2026-10-30', changes: [
      'The close options read Completed, Abandoned and On Hold (no question marks).',
      'New Project is now a + button at the end of the Projects heading in the sidebar; the name box opens under the heading.',
      'Settings at the bottom of the sidebar is centred.',
    ],
  },
  {
    version: '1.10.1', date: '2026-10-30', changes: ['The closure box on a closed task or project is now a softly tinted panel (accent colour for completed, amber for on hold, grey for abandoned) instead of a thick coloured edge.'],
  },
  {
    version: '1.10.0', date: '2026-10-30', changes: [
      'Close a task or project from its ⋯ menu as Completed, Abandoned or On Hold, with closure notes.',
      'Abandoned can record a reason (no longer needed, replaced, too costly, blocked, other); any closure can link the task or project that replaces or follows on from it, and Completed / Abandoned can record lessons learned.',
      'Closing can add an entry to the logbook (on by default for projects); closing a project archives it and can close its open tasks, sub-projects included.',
      'A closed task or project shows its closure at the top with Reopen (or Resume for On Hold); On Hold and Abandoned show as labels in task lists, and on-hold projects are marked in the sidebar.',
      'On-hold tasks no longer count as past due on Home. Claude can close and reopen too (tasks_close, projects_close and their reopen tools).',
    ],
  },
  {
    version: '1.9.0', date: '2026-10-30', changes: [
      'Phone layout: a slim top bar with ☰ and Search; the sidebar slides out from ☰ and closes when you pick a page (a red dot on ☰ means overdue maintenance or waiting activity).',
      'On phones, pages start straight away (the sidebar no longer sits above them), nothing is wider than the screen, and buttons are easier to tap.',
      'Phones: task lists show title, priority and due (labels and custom fields are in the task), menus open as a sheet along the bottom, Settings tabs swipe sideways, and a project\'s details card starts closed.',
      'SWunja can be added to a phone\'s home screen and opens like an app.',
    ],
  },
  {
    version: '1.8.0', date: '2026-10-30', changes: [
      'Runbooks have a Rollback section: numbered, rich-text steps to undo the procedure if it goes wrong.',
      'Each runbook step can have an expected result ("all containers show healthy"), shown under the step on the page, during runs and when marking maintenance done.',
      'Runbooks show their usual time, risk level (Low / Medium / High) and whether they need downtime, on the card and the page; set them with Edit Details.',
      'Code blocks everywhere (runbook steps, task descriptions, comments) have a Copy button.',
    ],
  },
  {
    version: '1.7.1', date: '2026-10-30', changes: ['Spacing above the Google Drive card in Settings → Backups.'],
  },
  {
    version: '1.7.0', date: '2026-10-30', changes: [
      'Off-host backups to Google Drive (Settings → Backups): connect once with a code at google.com/device, and each new backup is copied to a "SWunja Backups" folder, keeping the newest 14 (adjustable).',
      'SWunja can only see the files it creates in your Drive; failed uploads are shown on the card and retried after 15 minutes.',
    ],
  },
  {
    version: '1.6.0', date: '2026-10-30', changes: [
      'Home: one page with what needs you today. Services that are down, overdue maintenance and past-due tasks; activity waiting for you; tasks changed outside SWunja; what is due in the next 7 days; this week\'s logbook; and available updates.',
      'Sidebar items added in a new version now appear in their natural place in a customised order, instead of at the bottom.',
    ],
  },
  {
    version: '1.5.2', date: '2026-10-30', changes: [
      'Fixed: an activity with an unreadable start or end time could not be accepted.',
      'The time range in an accepted activity comment is now UK time, like the reminders.',
      'Masking -p values now applies only to MySQL/MariaDB commands, so docker -p8080:80 and ssh -p2222 show as typed.',
      'swjtrack: if SWunja\'s reply to a sync is lost, the retry no longer sends those commands twice; a damaged line in the local log no longer causes a resend.',
    ],
  },
  {
    version: '1.5.1', date: '2026-10-30', changes: [
      'Fixed: swjtrack\'s questions on the terminal (the "Sync to SWunja?" check-in, and the folder and interval steps of the setup) silently didn\'t appear; they do now.',
      'Ctrl+C during setup stops it cleanly.',
    ],
  },
  {
    version: '1.5.0', date: '2026-10-30', changes: [
      'swjtrack setup is one command that walks you through it: paste an API token (with a link to Settings → API Tokens & MCP; it is checked before saving, and a saved one can be kept), pick folders from ~/docker or type paths, choose how often to be asked to sync, and add the Claude Code hook if Claude Code is installed there.',
      'It ends with "exec bash", so swjtrack works and records commands straight away; running it again adds folders or changes the token.',
    ],
  },
  {
    version: '1.4.0', date: '2026-10-30', changes: [
      'Tasks and projects added or changed outside SWunja\'s pages (by Claude, the API, an accepted activity or a monitor) are highlighted as New or Updated in the task list, on the board and with a dot in the sidebar, until you open them.',
      'Settings → About now has this changelog, and the version number goes up with every release.',
    ],
  },
  {
    version: '1.3.0', date: '2026-10-30', changes: [
      'Activity page: work from Claude Code sessions and from folders tracked with swjtrack is matched to the task it belongs to; Accept adds a "Suggestion from agent" comment and an activity record.',
      'Claude card in Settings → Integrations (API key, model, monthly tokens) for matching and summaries.',
      'Claude can report work during a chat and offer to update the matching task (activity_report / activity_accept).',
      'swjtrack for Linux hosts: tracks a folder\'s files, commands and commits, asks to sync when due; installer at /swjtrack/install.',
      'Reminders (e.g. Pushover) when activity on a host has gone unsynced for a day.',
      'Passwords, tokens and keys in commands are masked before anything is stored or sent.',
    ],
  },
  {
    version: '1.2.0', date: '2026-10-29', changes: [
      'Renamed to SWunja, with the new logo.',
      'Runbook run history: start a run, tick steps as you go, finish into the logbook; maintenance jobs record a run too.',
      'Each runbook opens as its own page, with Run History at the bottom.',
      'Section headings have their spacing back (Run History, task lists).',
    ],
  },
  {
    version: '1.1.0', date: '2026-10-28', changes: [
      'Network: even spacing, foldable Subnets / Ports / UniFi Clients sections, large subnets use the full width.',
      'Runbooks: Applies To picks a project, then sub-project, then task (or N/A); rich-text steps; Tasks, Requirements and Resources lists.',
    ],
  },
  {
    version: '1.0.0', date: '2026-10-28', changes: [
      'Settings → About and Settings → Navigation (reorder or hide sidebar items).',
      '14 more themes; settings panes line up with the tab bar.',
      'Several Proxmox connections; project actions on the toolbar row; tasks listed A–Z.',
    ],
  },
];
