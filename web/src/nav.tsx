import { BookOpen, CalendarClock, House, Inbox, LayoutGrid, ListTodo, Network, NotebookPen, Router, Search, type LucideIcon } from 'lucide-react';
import type { Appearance } from './api';

/** The sidebar's menu items. Their order and visibility are saved in the appearance settings. */
export type NavItem = { id: string; label: string; icon: LucideIcon; href?: string; active?: (route: string) => boolean };
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: House, href: '#/home' },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'tasks', label: 'All Tasks', icon: ListTodo, href: '#/', active: r => r === '' },
  { id: 'logbook', label: 'Logbook', icon: NotebookPen, href: '#/logbook' },
  { id: 'activity', label: 'Activity', icon: Inbox, href: '#/activity' },
  { id: 'maintenance', label: 'Maintenance', icon: CalendarClock, href: '#/maintenance' },
  { id: 'infra', label: 'Infrastructure', icon: Network, href: '#/infra' },
  { id: 'network', label: 'Network', icon: Router, href: '#/network' },
  { id: 'runbooks', label: 'Runbooks', icon: BookOpen, href: '#/runbooks', active: r => r.startsWith('runbooks') },
  { id: 'projects', label: 'Projects by Field', icon: LayoutGrid, href: '#/projects' },
];

/** Saved order first; an item it doesn't mention (added in a later version) goes just before the item that follows it by default. */
export function orderedNav(a: Appearance): NavItem[] {
  const order = a.nav?.order ?? [];
  const rank = (i: NavItem): number => {
    if (order.includes(i.id)) return order.indexOf(i.id);
    const next = NAV_ITEMS.slice(NAV_ITEMS.indexOf(i) + 1).find(x => order.includes(x.id));
    return next ? order.indexOf(next.id) - 0.5 + NAV_ITEMS.indexOf(i) / 1000 : order.length + NAV_ITEMS.indexOf(i);
  };
  return [...NAV_ITEMS].sort((x, y) => rank(x) - rank(y));
}
