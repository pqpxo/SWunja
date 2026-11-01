<p align="center"><img src="web/public/logo.png" width="96" alt="SWunja logo"></p>

<h1 align="center">SWunja</h1>

<br />

<p align="center">A self-hosted task tracker for your homelab, with the logbook, maintenance schedule, runbooks, ideas and service checks built in. Claude can read and update all of it.</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#a-quick-tour">Tour</a> ·
  <a href="#claude-code-mcp">Claude Code</a> ·
  <a href="#activity-agent-swjtrack-optional">Activity agent</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#develop">Develop</a>
</p>

<br />

![The Home page: open tasks, services, maintenance, what's due in the next two weeks](docs/screenshots/home.png)

<br />

Most task trackers know nothing about servers, and most homelab dashboards can't hold a to-do list. SWunja keeps both in one place, so it can answer the everyday questions:
- What's broken?
- What's overdue?
- What did I change on that VM last week, and how do I undo it?
- What breaks if I reboot this host?

It's a single container with one SQLite file, built for one person.

Key features:
- **Projects and tasks** that nest as deep as you like, with list and kanban views, checklists, labels, priorities, due dates, repeating tasks and custom fields.
- **Logbook** of changes, incidents, maintenance and observations, with rollback steps for each change.
- **Maintenance schedule** for recurring jobs such as patching and certificate renewals, with overdue alerts.
- **Runbooks:** step-by-step procedures you can run, tick off and get reminded to test.
- **Ideas:** a place on each project for thoughts that aren't tasks yet.
- **Infrastructure map** (host → VM → container → app) that answers "what depends on this?".
- **Network register** of subnets, VLANs, IP addresses and ports, with clash warnings and imports from Proxmox and UniFi.
- **Health checks and release checks**, with notifications by ntfy, Gotify, Pushover, Home Assistant, email or webhook.
- **Activity agent** (`swjtrack`) that records what you do on your hosts and in Claude Code, and files it against the right task once you accept it.
- **Claude can use all of it** through the built-in MCP server.
- **Search, templates, backups** (optionally to Google Drive), import and export, and eleven themes.

<br />

## Quick start

You need Docker with Compose.

```bash
git clone https://github.com/pqpxo/SWunja.git
cd SWunja
docker compose up -d --build
```

Open `http://<your-server>:7760` and choose a password. That's it: no database to set up and no account to create. Everything is stored in the `swunja-data` volume, including the database, attachments and backups.

Whoever opens it first sets the password, so do that straight away, before you make it reachable from anywhere else. To use it away from home, put it behind a reverse proxy with HTTPS (Nginx Proxy Manager, Caddy and so on) rather than opening the port.

<br />

## A quick tour

### Home

Home is a single screen showing what needs you. The status line gives you open tasks, the week's progress, services, maintenance, the last backup and available updates. A **Needs attention** bar appears only when something is down, overdue or due for review.

Below that are three lists:
- **Up Next:** open tasks by priority.
- **Coming Up:** the next 14 days.
- **Recent Changes:** taken from the logbook.

### Projects and tasks

Projects nest as deep as you like, and each one has a **List** and a **Board** view.

<table>
  <tr>
    <td><img src="docs/screenshots/project-list.png" alt="A project's task list with labels, priorities and due dates"></td>
    <td><img src="docs/screenshots/board.png" alt="The same project as a kanban board"></td>
  </tr>
</table>

A task holds:
- a description, plus Issue, Workaround and Proposed Resolution sections;
- Tasks, Requirements and Resources checklists;
- labels, custom fields, attachments and comments;
- a history of who changed what (you, the API or Claude).

Tasks can **repeat**, for example every 3 months counted from the due date or from when you finished. When you close a task or project you mark it Completed, Abandoned or On Hold, with notes, lessons learned and an optional date to review it again.

![A task: description, issue, workaround, checklist, and the side card with state, priority, due date and repeat](docs/screenshots/task.png)

### Ideas

Each project has an **Ideas** tab for thoughts that aren't tasks yet. Type one and press Enter; add notes later if you like. Give each idea a status (New, Maybe, Parked, Done or Rejected) and a reason when you park or reject it, so you remember why. Rejected ideas are hidden unless you ask for them. Pin the ones that matter, and **Make Task** turns a good one into a task that links back to the idea. With Sub-Projects on, a project shows its sub-projects' ideas too.

![The Ideas tab: a pinned idea with notes, parked and done ideas, and the status filters](docs/screenshots/ideas.png)

### Runbooks and maintenance

**Runbooks** are step-by-step procedures. Each step can have an expected result, and a runbook can also have rollback steps, a time estimate, a risk level and a downtime flag. Running one ticks off the steps and records the run. Set **Test Every** and SWunja reminds you when a runbook hasn't been run for a while, so you find out it's stale before you need it.

**Maintenance** covers recurring jobs such as patching, certificate renewals, scrubs and restore tests, with last done, next due and overdue alerts. Marking a job done writes it to the logbook.

<table>
  <tr>
    <td><img src="docs/screenshots/runbook.png" alt="A runbook with numbered steps, expected results and a rollback step"></td>
    <td><img src="docs/screenshots/maintenance.png" alt="Maintenance list with overdue, due soon and OK jobs"></td>
  </tr>
</table>

### Logbook

The logbook records what changed, broke, was maintained or was noticed, per project, with rollback notes. Health-check outages and finished tasks add entries automatically, and scripts can add their own through a webhook.

![The logbook grouped by day: a change with its rollback, an observation, maintenance and an incident](docs/screenshots/logbook.png)

### Infrastructure and network

Give a project a **Runs On** link and SWunja builds the tree: host → VM or LXC → container → app. Ask **What depends on…** before you take something down.

The **Network** page lists subnets and VLANs, which project holds which IP address, and the ports each service publishes. It warns you about clashes. You can import from UniFi Network and Proxmox.

<table>
  <tr>
    <td><img src="docs/screenshots/infrastructure.png" alt="Infrastructure tree with what depends on docker-host"></td>
    <td><img src="docs/screenshots/network.png" alt="Network page with subnets, addresses and ports"></td>
  </tr>
</table>

### Themes and phone

There are eleven themes, including light, dark, Nord, Dracula, Catppuccin and Solarized, plus a choice of accent colour and font. Your choice is saved on the server, so every device looks the same. On a phone the layout collapses into a single column with a slide-out menu.

<table>
  <tr>
    <td width="72%"><img src="docs/screenshots/home-dark.png" alt="Home in the Midnight theme"></td>
    <td width="28%"><img src="docs/screenshots/phone.png" alt="Home on a phone"></td>
  </tr>
</table>

### Also included

- **Health checks:** HTTP and TCP checks; outages become logbook incidents.
- **Release checks:** compares each app's Version field with its latest GitHub release.
- **Notifications:** ntfy, Gotify, Pushover, Home Assistant, email or a webhook.
- **Custom fields and project types:** text, number, date, select, checkbox, URL and project-link fields, grouped into types such as Application or Host. Sub-projects inherit their parent's type.
- **Search:** <kbd>Ctrl</kbd>+<kbd>K</kbd> searches projects, tasks, the logbook, maintenance, runbooks and ideas.
- **Templates:** save any project or task as a template and reuse it.
- **Activity:** `swjtrack`, a small Linux agent, and a Claude Code hook record what you did on a host, ready to file against a task. See [Activity agent](#activity-agent-swjtrack-optional).
- **Backups:** daily SQLite and attachment backups, optionally copied to Google Drive.
- **Import and export:** one zip of everything; imports Vikunja exports too.

<br />

## Claude Code (MCP)

SWunja has a built-in [MCP](https://modelcontextprotocol.io) server. In **Settings → API Tokens & MCP**, generate a token, then:

```bash
claude mcp add --transport http swunja http://<your-server>:7760/mcp --header "Authorization: Bearer <token>"
```

Claude can then work with SWunja directly. For example:
- "What's overdue?"
- "Log that I upgraded Docker on docker-host, with rollback steps."
- "Create a runbook for restoring Nextcloud."
- "What depends on pve1?"
- "Mark the ZFS scrub done."
- "Note an idea for Homelab: try Frigate for the cameras."

Changes Claude makes show up in each task's history and are marked as new in the web UI until you open them.

<br />

## Activity agent: swjtrack (optional)

Most homelab work never makes it into a tracker: you SSH in, fix something, and move on. `swjtrack` is a small agent that notices that work and sends it to SWunja's **Activity** page. Nothing reaches a task until you accept it.

It has two parts:
- **Folder tracking** on a Linux host. It records the commands you type and the files that change inside folders you choose, plus any git commits made there.
- **A Claude Code hook.** At the end of each Claude Code session, it reports what you asked for, the commands Claude ran and the files it changed. It covers every session on that host in any folder, not just tracked ones, and sends straight away rather than waiting for you to sync.

### Install

On each host, run:

```bash
curl -fsSL http://<your-server>:7760/swjtrack/install | sh
```

It needs `python3` and nothing else: the agent is a single Python file that uses only the standard library. The installer walks you through:
1. **An API token.** Create one in **Settings → API Tokens & MCP**. The installer checks it works before saving it.
2. **Which folders to track,** for example `~/docker/nextcloud`. Only these folders are recorded by folder tracking.
3. **How often to ask you to sync** (the check-in interval, 2 hours by default).
4. **Whether to add the Claude Code hook.** It goes in `~/.claude/settings.json`, so it applies to all your Claude Code sessions on that host. To remove it, delete the `swjtrack claude-hook` entry under `SessionEnd`.

The agent lives in `~/.local/bin/swjtrack`. Its config (server and token) is in `~/.config/swjtrack/config.json`, readable only by you. A short hook added to `~/.bashrc` (and `~/.zshrc` if you have one) records commands.

### What it records

Inside a tracked folder:
- **Commands** you type, with their exit codes.
- **Files** created, edited or deleted, found by a background watcher every few seconds. Logs, swap files and SQLite journals are skipped, and `swjtrack ignore` skips anything else (see below).
- **Git commits** made since the last sync.

From Claude Code (any folder): the prompts you typed, the commands it ran and the files it changed.

It **never sends file contents**, only names, change counts, commands and commit messages. Passwords and tokens in commands are masked on the host before anything is sent. This covers things like `--password`, `curl -u user:pass`, `user:pass@` URLs, `*_TOKEN=` variables, `Authorization:` headers and long random-looking keys.

### Syncing

Folder activity is kept on the host until you sync it. (Claude Code sessions skip this and are sent when the session ends.) Once a tracked folder has activity and the check-in interval has passed, your next prompt there asks:

```
12 activities for /home/me/docker/nextcloud since 14:05. Sync to SWunja? [Y/n/show]
```

- **Y** sends it.
- **show** lists it first.
- **n** asks again after another interval.

`swjtrack sync` sends it straight away. If SWunja can't be reached, folder activity isn't lost: it stays on the host for next time. A Claude Code session that can't be sent is not retried; the hook prints an error and the session is skipped.

While you work, the agent also tells SWunja how much is waiting. If a folder still has unsynced activity after 24 hours, SWunja sends a reminder through your notification channels, at most once a day. You can change the 24 hours on the Activity page.

### Matching it to a task

Each synced batch appears on the **Activity** page with its host, folder, files, commands and commits, plus a suggested task.
- **With an Anthropic API key** (Settings → Integrations → Claude), Claude suggests the task and writes a one-line summary of the work. Claude sees the same masked names, commands, commit messages and prompts, plus the titles of likely tasks, never file contents. Settings shows the tokens used each month.
- **Without a key,** SWunja suggests the task that shares the most words with the activity.

Then you choose:
- **Accept** adds the summary as a comment on the task, with the full details in the task's history. You can pick a different task, or have it create a new one in a project.
- **Dismiss** throws the batch away.

When you accept, SWunja remembers which project that folder belongs to, so later suggestions get better.

### Commands

| Command | What it does |
| --- | --- |
| `swjtrack --menu` | Opens an arrow-key menu for everything below: the API token, tracked folders, syncing, check-in intervals and updates. |
| `swjtrack status` | Lists the tracked folders, what's waiting and when each last synced. |
| `swjtrack sync [-f DIR]` | Sends waiting activity now, for every folder or just one. |
| `swjtrack -f DIR [-i 30m]` | Tracks another folder, optionally with its own check-in interval. |
| `swjtrack stop -f DIR` | Stops tracking a folder. Sync first, or add `--discard` to drop what's waiting. |
| `swjtrack ignore PATH` | Never records anything in that folder or file, for example `~/docker/nextcloud/data`: not its files, not commands typed there and not Claude Code sessions run there. |
| `swjtrack ignore GLOB` | Never records files or folders whose name matches, for example `*.tmp` or `backups`. |
| `swjtrack ignore` | Lists what is ignored. |
| `swjtrack unignore PATH\|GLOB` | Stops ignoring it. |
| `swjtrack update` | Installs the latest agent from your SWunja server and restarts its watcher. |
| `swjtrack claude-setup` | Adds the Claude Code hook if you skipped it during install. |

### Keeping agents up to date

After you update SWunja, run `swjtrack update` on each host. Agents installed before SWunja 1.16.0 don't have it yet, so run the install command once more on those. It offers to keep your saved token, and folders you already track stay tracked (answer `none` at the folders step to add no more).

To update every time the host runs `apt-get update`, add an APT hook (replace `me` with the user who installed swjtrack):

```bash
echo 'APT::Update::Post-Invoke { "runuser -u me -- /home/me/.local/bin/swjtrack update || true"; };' | sudo tee /etc/apt/apt.conf.d/99swjtrack
```

To remove the agent, delete `~/.local/bin/swjtrack`, `~/.config/swjtrack` and `~/.local/share/swjtrack`. Then remove the block between `# >>> swjtrack >>>` and `# <<< swjtrack <<<` in `~/.bashrc` (and `~/.zshrc`).

<br />

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `SWUNJA_PORT` | `7760` | Port on the host. Set it in your shell or in a `.env` file next to `docker-compose.yml`. |
| `BACKUP_DIR` | `/data/backups` | Where backups go; point it at another disk or a NAS mount. |
| `LOG_LEVEL` | `info` | Server log level. |
| `TRUST_PROXY` | private addresses | Which reverse proxies may set `X-Forwarded-*` headers: `true`, `false`, or a comma-separated list of addresses or CIDRs. The default trusts private addresses (a proxy on your LAN or in Docker). |

`BACKUP_DIR`, `LOG_LEVEL` and `TRUST_PROXY` go in an `environment:` block under the service in `docker-compose.yml`. If you move the backups, mount that folder into the container too.

Everything else is set up in **Settings**, including backups, notification channels, the Claude API key, Google Drive, UniFi, Proxmox, the GitHub token, themes and the sidebar. API keys are write-only: once saved they're never shown again, and they're never included in exports.

To restore a backup, stop the container. Replace `samunja.db` and the `files/` folder in the data volume with the ones from the backup zip, delete `samunja.db-wal` and `samunja.db-shm`, then start the container again. Each zip includes these steps.

<br />

## Develop

You need Node 24. There's no build step for the server: Node runs the TypeScript directly.

```bash
npm install
npm test                                  # server tests (node --test)
PORT=7760 DATA_DIR=./data npm run dev     # API + MCP on :7760
npm run dev:web                           # Vite dev server, proxies /api and /mcp to :7760
npm run build                             # web UI -> web/dist
```

The stack is Fastify, `node:sqlite`, React 19, Vite and the MCP TypeScript SDK.

The screenshots show made-up demo data.

<br />

## License

MIT, see [LICENSE](LICENSE).
