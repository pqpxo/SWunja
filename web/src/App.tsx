import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Menu as MenuIcon, Plus, Search, Settings as SettingsIcon } from 'lucide-react';
import { api, get, type Appearance, type Field, type Label, type Project, type ProjectType } from './api';
import { ProjectView, ProjectsPage } from './ProjectView';
import { TaskPanel } from './TaskPanel';
import { LogbookPage } from './Logbook';
import { MaintenancePage } from './Maintenance';
import { InfraPage } from './Infra';
import { RunbooksPage } from './Runbooks';
import { ActivityPage } from './Activity';
import { HomePage } from './Home';
import { NetworkPage } from './Network';
import { Palette } from './Palette';
import { useDownProjects } from './Monitor';
import { Settings } from './Settings';
import { applyAppearance } from './theme';
import { InlineAdd, useCollapsed } from './ui';
import { ProjectIcon } from './icons';
import { orderedNav } from './nav';

type Data = {
  projects: Project[]; labels: Label[]; types: ProjectType[]; fields: Field[]; reload: () => Promise<void>;
  appearance: Appearance; setAppearance: (a: Appearance) => void;
};
const DEFAULT_APPEARANCE: Appearance = { theme: 'light', accent: null, font: 'jakarta', taskView: 'panel', nav: { order: [], hidden: ['projects'] }, showArchived: false };
const DataCtx = createContext<Data>(null!);
export const useData = () => useContext(DataCtx);

function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '');
}

export const go = (path: string) => { location.hash = `#/${path}`; };

const Logo = () => <img className="logo" src="/logo.png" alt="" />;

function AuthScreen({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setup && pw !== pw2) return setErr('Passwords do not match');
    try {
      await api('POST', setup ? '/auth/login' : '/auth/setup', { password: pw });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="auth card" onSubmit={submit}>
        <div className="brand"><Logo />SWunja</div>
        <h1>{setup ? 'Welcome Back' : 'Set Up SWunja'}</h1>
        <p className="muted">{setup ? 'Log in to your task tracker.' : 'Choose a password (8+ characters) to protect this instance.'}</p>
        <input type="password" autoFocus placeholder="Password" aria-label="Password" value={pw} onChange={e => setPw(e.target.value)} />
        {!setup && <input type="password" placeholder="Repeat password" aria-label="Repeat password" value={pw2} onChange={e => setPw2(e.target.value)} />}
        {err && <p className="error">{err}</p>}
        <button className="primary">{setup ? 'Log In' : 'Set Password'}</button>
      </form>
    </div>
  );
}

type Fold = ReturnType<typeof useCollapsed>;
function Tree({ projects, parent, depth, current, down, fold }: { projects: Project[]; parent: number | null; depth: number; current: number | null; down: Set<number>; fold: Fold }) {
  const kids = projects.filter(p => p.parent_id === parent);
  return (
    <>
      {kids.map(p => {
        const hasKids = projects.some(c => c.parent_id === p.id);
        const isOpen = !fold.collapsed.has(p.id);
        return (
          <div key={p.id}>
            <div className={`tree-item ${current === p.id ? 'active' : ''} ${p.archived ? 'archived' : ''}`} style={{ paddingLeft: 4 + depth * 16 }}>
              <button className="twisty" aria-label={isOpen ? 'Collapse' : 'Expand'} style={{ visibility: hasKids ? 'visible' : 'hidden' }}
                onClick={() => fold.toggle(p.id)}>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
              <a href={`#/p/${p.id}`} aria-current={current === p.id ? 'page' : undefined}>
                <span className="tree-icon"><ProjectIcon icon={p.icon} color={p.color} size={15} /></span>{p.title}
                {p.closed === 'on_hold' && <span className="hold-mark" title="On hold" aria-label="on hold">❚❚</span>}
                {down.has(p.id) && <span className="down-dot" title="A health check is failing" aria-label="down" />}
                {(p.unseen || p.unseen_tasks > 0) && <span className="unseen-dot" title={p.unseen ? `${p.unseen === 'new' ? 'New' : 'Updated'} since you last opened it` : `${p.unseen_tasks} task${p.unseen_tasks === 1 ? '' : 's'} new or updated`} aria-label="new or updated" />}
              </a>
            </div>
            {hasKids && isOpen && <Tree projects={projects} parent={p.id} depth={depth + 1} current={current} down={down} fold={fold} />}
          </div>
        );
      })}
    </>
  );
}

function Shell() {
  const data = useData();
  const route = useHashRoute();
  const down = useDownProjects();
  const fold = useCollapsed('smj:collapsed');
  const pid = /^p\/(\d+)/.exec(route)?.[1];
  // opening a project from anywhere (Infrastructure, Network, search) unfolds its parents and scrolls it into view
  useEffect(() => {
    if (!pid) return;
    const up: number[] = [];
    for (let p = data.projects.find(x => x.id === +pid); p?.parent_id; p = data.projects.find(x => x.id === p!.parent_id)) up.push(p.parent_id);
    if (up.some(id => fold.collapsed.has(id))) fold.setAll([...fold.collapsed].filter(id => !up.includes(id)));
  }, [pid, data.projects]); // eslint-disable-line react-hooks/exhaustive-deps
  // runs after the unfolded tree has rendered
  useEffect(() => { document.querySelector('.sidebar .tree-item.active')?.scrollIntoView({ block: 'nearest' }); }, [pid, fold.collapsed]);
  const tid = /^t\/(\d+)/.exec(route)?.[1];
  // overdue maintenance count for the sidebar badge; refreshed when maintenance changes or the page changes
  const [overdue, setOverdue] = useState(0);
  useEffect(() => {
    const load = () => get<unknown[]>('/maintenance?overdue=true').then(l => setOverdue(l.length)).catch(() => {});
    load();
    addEventListener('smj:maint', load);
    return () => removeEventListener('smj:maint', load);
  }, [route]);
  // activity waiting for a decision, for the sidebar badge
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    const load = () => get<{ waiting: number }>('/activity/count').then(r => setWaiting(r.waiting)).catch(() => {});
    load();
    addEventListener('smj:activity', load);
    return () => removeEventListener('smj:activity', load);
  }, [route]);
  // phones: the sidebar is a slide-out menu, closed again whenever the page changes
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => { setNavOpen(false); }, [route]);
  useEffect(() => {
    if (!navOpen) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [navOpen]);
  const visible = data.projects.filter(p => data.appearance.showArchived || !p.archived);
  const [addingProject, setAddingProject] = useState(false);
  const newProject = async (title: string) => {
    const p = await api<Project>('POST', '/projects', { title });
    await data.reload();
    go(`p/${p.id}`);
  };
  return (
    <div className="shell">
      <header className="topbar">
        <button className="icon-btn topbar-btn" aria-label="Menu" aria-expanded={navOpen} onClick={() => setNavOpen(true)}><MenuIcon size={20} />
          {overdue + waiting > 0 && <span className="topbar-dot" aria-hidden />}</button>
        <a className="brand" href="#/home"><Logo />SWunja</a>
        <span className="grow" />
        <button className="icon-btn topbar-btn" aria-label="Search" onClick={() => dispatchEvent(new Event('smj:search'))}><Search size={19} /></button>
      </header>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden />}
      <nav className={`sidebar ${navOpen ? 'open' : ''}`}>
        <a className="brand" href="#/"><Logo />SWunja</a>
        {orderedNav(data.appearance).filter(it => !data.appearance.nav.hidden.includes(it.id)).map(it => it.id === 'search'
          ? <button key={it.id} className="nav search-nav" onClick={() => dispatchEvent(new Event('smj:search'))}><it.icon size={17} />Search<kbd>Ctrl K</kbd></button>
          : <a key={it.id} className={`nav ${(it.active ? it.active(route) : route === it.href!.slice(2)) ? 'active' : ''}`} href={it.href}><it.icon size={17} />{it.label}
              {it.id === 'maintenance' && overdue > 0 && <span className="nav-badge" title={`${overdue} overdue`}>{overdue}</span>}
              {it.id === 'activity' && waiting > 0 && <span className="nav-badge" title={`${waiting} waiting`}>{waiting}</span>}</a>)}
        <div className="section-title">Projects
          <button type="button" className="section-add" aria-label="New project" title="New Project" onClick={() => setAddingProject(true)}><Plus size={14} /></button>
        </div>
        {addingProject && <InlineAdd key="np" className="new-project" initialOpen label="" placeholder="Project name, Enter" onSubmit={newProject} onClose={() => setAddingProject(false)} />}
        <div className="tree">
          {/* an archived parent hides its whole subtree unless "Show archived" is on */}
          <Tree projects={visible} parent={null} depth={0} current={pid ? +pid : null} down={down} fold={fold} />
        </div>
        <div className="grow" />
        <a className={`nav settings-nav ${route.startsWith('settings') ? 'active' : ''}`} href="#/settings"><SettingsIcon size={17} />Settings</a>
      </nav>
      <main className="main">
        {route.startsWith('settings') ? <Settings tab={route.split('/')[1]} />
          : route === 'projects' ? <ProjectsPage />
          : route === 'home' ? <HomePage />
          : route === 'logbook' ? <LogbookPage />
          : route === 'activity' ? <ActivityPage />
          : route === 'maintenance' ? <MaintenancePage />
          : route === 'infra' ? <InfraPage />
          : route === 'network' ? <NetworkPage />
          : route.startsWith('runbooks') ? <RunbooksPage openId={Number(route.split('/')[1]) || undefined} />
          : tid ? <TaskPanel key={tid} id={+tid} mode="page" onChange={() => {}} />
          : pid ? <ProjectView key={pid} projectId={+pid} />
          : <ProjectView key="all" projectId={null} />}
      </main>
      <Palette />
    </div>
  );
}

export function App() {
  const [auth, setAuth] = useState<{ setup: boolean; authed: boolean } | null>(null);
  const [data, setData] = useState<Omit<Data, 'reload' | 'appearance' | 'setAppearance'> | null>(null);
  const [appearance, setAppearanceState] = useState<Appearance>(DEFAULT_APPEARANCE);
  const setAppearance = useCallback((a: Appearance) => { setAppearanceState(a); applyAppearance(a); }, []);
  const checkAuth = () => get('/auth/status').then(setAuth);
  const reload = useCallback(async () => {
    const [projects, labels, types, fields] = await Promise.all([get('/projects'), get('/labels'), get('/types'), get('/fields')]);
    setData({ projects, labels, types, fields });
  }, []);
  useEffect(() => {
    get<Appearance>('/appearance').then(setAppearance).catch(() => { /* defaults from CSS */ });
    checkAuth();
    const out = () => setAuth(a => (a ? { ...a, authed: false } : a));
    addEventListener('smj:logout', out);
    return () => removeEventListener('smj:logout', out);
  }, []);
  useEffect(() => { if (auth?.authed) reload(); }, [auth?.authed, reload]);

  if (!auth) return null;
  if (!auth.authed) return <AuthScreen setup={auth.setup} onDone={checkAuth} />;
  if (!data) return <div className="loading">Loading…</div>;
  return <DataCtx.Provider value={{ ...data, reload, appearance, setAppearance }}><Shell /></DataCtx.Provider>;
}
