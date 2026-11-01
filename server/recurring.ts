// Repeating tasks: when one is finished, a fresh copy appears with the next due date and takes over the repeat.
import type { DatabaseSync } from 'node:sqlite';
import * as s from './services.ts';
import { copyTask } from './templates.ts';

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Adds the interval to a YYYY-MM-DD day; months and years clamp to the month's last day (31 Jan + 1 month = 28 Feb). */
export function addInterval(day: string, r: Pick<s.Repeat, 'every' | 'unit'>): string {
  const [y, m, d] = day.split('-').map(Number);
  if (r.unit === 'day' || r.unit === 'week') return ymd(new Date(Date.UTC(y, m - 1, d + r.every * (r.unit === 'week' ? 7 : 1))));
  const months = (m - 1) + r.every * (r.unit === 'year' ? 12 : 1);
  const last = new Date(Date.UTC(y, months + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(y, months, Math.min(d, last))));
}

/** The next due day: counted from completion (today), or from the due date and moved on until it's in the future. */
export function nextDue(r: s.Repeat, due: string | null, today: string): string {
  if (r.from === 'done' || !due) return addInterval(today, r);
  let next = addInterval(due, r);
  while (next <= today) next = addInterval(next, r);
  return next;
}

function repeat(db: DatabaseSync, t: s.Task) {
  if (!t.repeat) return;
  const due = nextDue(t.repeat, t.due_date?.slice(0, 10) ?? null, ymd(new Date()));
  const n = copyTask(db, t);
  db.prepare('UPDATE tasks SET repeat=NULL WHERE id=?').run(t.id);
  db.prepare('UPDATE tasks SET repeat=?, due_date=? WHERE id=?').run(JSON.stringify(t.repeat), due, n.id);
  s.logEvent(db, t.id, 'repeated', `next: #${n.id} due ${due}`);
}

s.onCompleted.push(repeat);
