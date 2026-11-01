import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor as TEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import CodeBlock from '@tiptap/extension-code-block';
import { ImagePlus, Link2 } from 'lucide-react';
import { upload } from './api';

/** Copies text; falls back to the old copy command, since SWunja is often served over plain http where the Clipboard API is unavailable. */
async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

/** Code blocks with a Copy button in the corner (in comments, descriptions and runbook steps alike). */
const CodeBlockCopy = CodeBlock.extend({
  addNodeView() {
    return () => {
      const dom = Object.assign(document.createElement('div'), { className: 'code-wrap' });
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'code-copy', textContent: 'Copy', title: 'Copy to clipboard' });
      btn.contentEditable = 'false';
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation(); // don't open the editor
        copyText(code.textContent ?? '').then(() => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); });
      });
      pre.append(code);
      dom.append(btn, pre);
      return { dom, contentDOM: code, ignoreMutation: m => btn.contains(m.target as Node), stopEvent: e => btn.contains(e.target as Node) };
    };
  },
});

type Props = { value: string; onSave: (html: string) => Promise<unknown> | void; taskId?: number; placeholder?: string; startEditing?: boolean; saveLabel?: string; clearOnSave?: boolean;
  readOnly?: boolean; onCancel?: () => void };

const isEmpty = (html: string) => !html || html.replace(/<p><\/p>/g, '').trim() === '';

// Pasted/dropped/picked files are uploaded: images are embedded, other files become a link. Returns false if there were none.
function insertFiles(editor: TEditor, files: File[], taskId?: number) {
  if (!files.length) return false;
  files.forEach(async f => {
    try {
      const a = await upload(f, taskId);
      if (f.type.startsWith('image/')) editor.chain().focus().setImage({ src: a.url, alt: f.name }).run();
      else editor.chain().focus().insertContent([{ type: 'text', text: `📎 ${f.name}`, marks: [{ type: 'link', attrs: { href: a.url } }] }, { type: 'text', text: ' ' }]).run();
      window.dispatchEvent(new Event('smj:attachments'));
    } catch (e) {
      alert(`Upload failed: ${(e as Error).message}`);
    }
  });
  return true;
}

function Toolbar({ editor, taskId }: { editor: TEditor; taskId?: number }) {
  const btn = (label: React.ReactNode, title: string, active: boolean, run: () => void) => (
    <button type="button" title={title} className={active ? 'tb on' : 'tb'} onMouseDown={e => { e.preventDefault(); run(); }}>{label}</button>
  );
  const c = () => editor.chain().focus();
  return (
    <div className="toolbar">
      {btn('B', 'Bold', editor.isActive('bold'), () => c().toggleBold().run())}
      {btn('I', 'Italic', editor.isActive('italic'), () => c().toggleItalic().run())}
      {btn('U', 'Underline', editor.isActive('underline'), () => c().toggleUnderline().run())}
      {btn('H2', 'Heading', editor.isActive('heading', { level: 2 }), () => c().toggleHeading({ level: 2 }).run())}
      {btn('H3', 'Subheading', editor.isActive('heading', { level: 3 }), () => c().toggleHeading({ level: 3 }).run())}
      {btn('•', 'Bullet list', editor.isActive('bulletList'), () => c().toggleBulletList().run())}
      {btn('1.', 'Numbered list', editor.isActive('orderedList'), () => c().toggleOrderedList().run())}
      {btn('❝', 'Quote', editor.isActive('blockquote'), () => c().toggleBlockquote().run())}
      {btn('</>', 'Code block', editor.isActive('codeBlock'), () => c().toggleCodeBlock().run())}
      {btn(<Link2 size={14} />, 'Link', editor.isActive('link'), () => {
        const prev = editor.getAttributes('link').href;
        const url = window.prompt('Link URL (empty to remove)', prev ?? 'https://');
        if (url === null) return;
        url ? c().extendMarkRange('link').setLink({ href: url }).run() : c().unsetLink().run();
      })}
      <label className="tb" title="Insert image or file"><ImagePlus size={14} /><input type="file" multiple hidden onChange={e => insertFiles(editor, [...(e.target.files ?? [])], taskId)} /></label>
    </div>
  );
}

/**
 * Rich-text field rendered by TipTap in both modes: read-only until clicked, then editable.
 * Rendering through the editor schema (never innerHTML) drops scripts, event handlers and javascript: links
 * from stored HTML, whoever wrote it (UI, REST, MCP or the Vikunja import).
 */
export function Editor({ value, onSave, taskId, placeholder = 'Click to add a description…', startEditing = false, saveLabel = 'Save', clearOnSave = false, readOnly = false, onCancel }: Props) {
  const [editing, setEditing] = useState(startEditing);
  const ref = useRef<TEditor | null>(null);
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false }, codeBlock: false }), CodeBlockCopy, Image],
    content: value,
    editable: startEditing,
    editorProps: {
      handlePaste: (_v, e) => insertFiles(ref.current!, [...(e.clipboardData?.files ?? [])], taskId),
      handleDrop: (_v, e) => insertFiles(ref.current!, [...((e as DragEvent).dataTransfer?.files ?? [])], taskId),
    },
  });
  ref.current = editor;

  // focus only when the user opened the editor, not for always-open ones (that would scroll the panel)
  const userOpened = useRef(false);
  // useEditor can hand back an instance it has already destroyed (it recreates editors on remount); touching it then crashes the app
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(editing);
    if (editing && userOpened.current) editor.commands.focus('end');
  }, [editing, editor]);
  const open = () => { userOpened.current = true; setEditing(true); };
  useEffect(() => {
    if (!editing && editor && !editor.isDestroyed && editor.getHTML() !== value) editor.commands.setContent(value);
  }, [value, editing, editor]);

  if (!editing && isEmpty(value)) return readOnly ? null : <div className="rich empty" onClick={open}>{placeholder}</div>;
  if (!editing)
    return <EditorContent editor={editor} className="rich" onClick={e => { if (!readOnly && !(e.target as HTMLElement).closest('a')) open(); }} />;

  const save = async () => {
    const html = editor?.getHTML() ?? '';
    await onSave(isEmpty(html) ? '' : html);
    if (clearOnSave) editor?.commands.clearContent();
    else setEditing(false);
  };
  return (
    <div className="editor">
      {editor && <Toolbar editor={editor} taskId={taskId} />}
      <EditorContent editor={editor} className="rich editing" />
      <div className="row gap">
        <button className="primary" onClick={save}>{saveLabel}</button>
        {onCancel ? <button onClick={onCancel}>Cancel</button>
          : !clearOnSave && <button onClick={() => { editor?.commands.setContent(value); setEditing(false); }}>Cancel</button>}
      </div>
    </div>
  );
}
