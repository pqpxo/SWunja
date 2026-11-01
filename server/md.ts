import TurndownService from 'turndown';
import { marked } from 'marked';

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
td.addRule('underline', { filter: ['u'], replacement: c => `<u>${c}</u>` });

export const toMd = (html: string) => (html ? td.turndown(html) : '');
export const toHtml = (md: string) => (md ? (marked.parse(md, { async: false }) as string) : '');
