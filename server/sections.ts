// Built-in rich-text sections on every task, besides the description.
export const SECTIONS = { issue: 'Issue', workaround: 'Workaround', resolution: 'Proposed Resolution', resources: 'Resources' } as const;
export type SectionKey = keyof typeof SECTIONS;
export const SECTION_KEYS = Object.keys(SECTIONS) as SectionKey[];
/** Sections stored as rich text; Resources is a list (checklist_items, list 'resources'). */
export const TEXT_SECTION_KEYS = ['issue', 'workaround', 'resolution'] as const;
export type TextSectionKey = (typeof TEXT_SECTION_KEYS)[number];

const byTitle = new Map(Object.entries(SECTIONS).map(([k, t]) => [t.toLowerCase(), k as SectionKey]));
const headingText = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s+/g, ' ').trim().replace(/:$/, '').toLowerCase();
const trimEmpty = (html: string) => html.replace(/^(\s|<p>(\s|<br\s*\/?>)*<\/p>)+|(\s|<p>(\s|<br\s*\/?>)*<\/p>)+$/g, '');

/**
 * Moves content under "Issue / Workaround / Proposed Resolution / Resources" headings (h1-h3) into those sections.
 * Anything before the first such heading stays in the description; other headings stay where they are.
 */
export function splitSections(html: string): { description: string } & Partial<Record<SectionKey, string>> {
  const out: Record<string, string> = { description: '' };
  let key = 'description';
  let last = 0;
  for (const m of html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const hit = byTitle.get(headingText(m[2]));
    if (!hit) continue;
    out[key] = (out[key] ?? '') + html.slice(last, m.index);
    key = hit;
    last = m.index! + m[0].length;
  }
  out[key] = (out[key] ?? '') + html.slice(last);
  for (const k of Object.keys(out)) out[k] = trimEmpty(out[k]);
  return out as { description: string } & Partial<Record<SectionKey, string>>;
}

const decode = (t: string) => t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Rich text to one line per paragraph/list item; a link keeps its URL ("text (url)" unless the text is the URL). */
export function htmlToLines(html: string): string[] {
  const blocks = html.match(/<(p|li|h[1-6])[^>]*>[\s\S]*?<\/\1>/gi) ?? (html.trim() ? [html] : []);
  return blocks
    .map(b => b.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const t = decode(text.replace(/<[^>]+>/g, '')).trim();
      return t === href || !t ? href : `${t} (${href})`;
    }))
    .map(b => decode(b.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
