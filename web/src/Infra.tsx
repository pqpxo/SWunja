import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { get, type Dependent, type InfraNode } from './api';
import { useData } from './App';
import { ProjectIcon } from './icons';
import { useCollapsed } from './ui';

type Fold = ReturnType<typeof useCollapsed>;
function Node({ n, fold }: { n: InfraNode; fold: Fold }) {
  const open = !fold.collapsed.has(n.id);
  return (
    <li>
      <div className="infra-node">
        <button className="twisty" aria-label={open ? `Hide what runs on ${n.title}` : `Show what runs on ${n.title}`} aria-expanded={open}
          style={{ visibility: n.children.length ? 'visible' : 'hidden' }} onClick={() => fold.toggle(n.id)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        <ProjectIcon icon={n.icon} color={n.color} size={16} />
        <a href={`#/p/${n.id}`}>{n.title}</a>
        {n.kind && <span className="pill">{n.kind}</span>}
        {n.type && <span className="sub">{n.type}</span>}
        {n.children.length > 0 && <span className="count">{n.children.length}</span>}
      </div>
      {n.children.length > 0 && open && <ul>{n.children.map(c => <Node key={c.id} n={c} fold={fold} />)}</ul>}
    </li>
  );
}

/** Everything linked to a project through link fields such as Runs On, nearest first. */
function DependentsList({ list }: { list: Dependent[] }) {
  if (!list.length) return <p className="hint">Nothing depends on it.</p>;
  const byDepth = [...new Set(list.map(d => d.depth))];
  return (
    <div className="dependents">
      {byDepth.map(depth => (
        <div key={depth} className="dep-group">
          <span className="field-name">{depth === 1 ? 'Directly' : `${depth} Levels Down`}</span>
          <div className="pills">
            {list.filter(d => d.depth === depth).map(d => (
              <a key={d.id} className="pill dep-pill" href={`#/p/${d.id}`} title={`via ${d.field}`}><ProjectIcon icon={d.icon} color={d.color} size={13} />{d.title}</a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function InfraPage() {
  const { projects } = useData();
  const [tree, setTree] = useState<InfraNode[]>([]);
  const [target, setTarget] = useState('');
  const [deps, setDeps] = useState<Dependent[] | null>(null);
  const fold = useCollapsed('smj:infra-collapsed');
  const parents = (list: InfraNode[]): number[] => list.flatMap(n => (n.children.length ? [n.id, ...parents(n.children)] : []));
  useEffect(() => { get<InfraNode[]>('/infra').then(setTree); }, [projects]);
  useEffect(() => {
    if (!target) return setDeps(null);
    get<Dependent[]>(`/projects/${target}/dependents?transitive=true`).then(setDeps);
  }, [target, projects]);
  return (
    <div className="page">
      <header className="page-header">
        <nav className="crumbs"><a href="#/">Home</a></nav>
        <h1 className="page-title">Infrastructure</h1>
        <p className="lede">Hosts, the VMs, LXCs and containers on them, and the apps they run, built from each project's “Runs On” field.</p>
      </header>
      <div className="infra-layout">
        <section className="card">
          <div className="card-title-row">
            <h2 className="card-title">Hierarchy</h2>
            {tree.length > 0 && <span className="row gap">
              <button className="ghost small" onClick={() => fold.setAll([])}>Expand All</button>
              <button className="ghost small" onClick={() => fold.setAll(parents(tree))}>Collapse All</button>
            </span>}
          </div>
          {tree.length
            ? <ul className="infra-tree">{tree.map(n => <Node key={n.id} n={n} fold={fold} />)}</ul>
            : <p className="hint">Nothing linked yet. Give a project the Host type (or add the Runs On field to it) and pick what it runs on.</p>}
        </section>
        <section className="card">
          <h2 className="card-title">What Depends On…</h2>
          <select aria-label="Project to check" value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">Pick a host or project</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          {deps && <DependentsList list={deps} />}
        </section>
      </div>
    </div>
  );
}

/** "Used By" on a project's Details card: what points at this project (direct only). */
export function UsedBy({ projectId }: { projectId: number }) {
  const { projects } = useData();
  const [deps, setDeps] = useState<Dependent[]>([]);
  const [pref, setPref] = useState(() => { try { return localStorage.getItem('smj:usedby'); } catch { return null; } });
  useEffect(() => { get<Dependent[]>(`/projects/${projectId}/dependents`).then(setDeps); }, [projectId, projects]);
  if (!deps.length) return null;
  const open = pref ? pref === 'open' : deps.length <= 12;
  const toggle = () => { const v = open ? 'closed' : 'open'; setPref(v); try { localStorage.setItem('smj:usedby', v); } catch { /* private mode */ } };
  return (
    <div className="used-by">
      <button className="fold-head" aria-expanded={open} onClick={toggle}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="field-name">Used By</span><span className="count">{deps.length}</span>
      </button>
      {open && <div className="pills">
        {deps.map(d => <a key={d.id} className="pill dep-pill" href={`#/p/${d.id}`} title={`via ${d.field}`}><ProjectIcon icon={d.icon} color={d.color} size={13} />{d.title}</a>)}
      </div>}
    </div>
  );
}
