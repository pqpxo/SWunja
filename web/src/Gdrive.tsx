import { useEffect, useRef, useState } from 'react';
import { CloudUpload, ExternalLink } from 'lucide-react';
import { api, get } from './api';
import { ago } from './ui';

type Drive = { client_id: string; has_secret: boolean; connected: boolean; folder_name: string; keep: number; last_upload: { name: string; at: string } | null; last_error: string | null };
type Code = { user_code: string; verification_url: string; interval: number };

/** Settings → Backups: copy each nightly backup to Google Drive (off-host). */
export function GoogleDriveCard() {
  const [d, setD] = useState<Drive | null>(null);
  const [form, setForm] = useState({ client_id: '', client_secret: '' });
  const [code, setCode] = useState<Code | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<number>(0);
  const load = () => get<Drive>('/gdrive').then(x => { setD(x); setForm(f => ({ ...f, client_id: x.client_id })); });
  useEffect(() => { load(); return () => window.clearTimeout(timer.current); }, []);
  if (!d) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setMsg(''); setBusy(true);
    try { await fn(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  // after "Connect": ask the server every few seconds whether the code has been approved at google.com/device
  const poll = (every: number) => {
    timer.current = window.setTimeout(async () => {
      const r = await api<{ status: string }>('POST', '/gdrive/connect/poll').catch(e => ({ status: 'error', message: (e as Error).message }));
      if (r.status === 'waiting') return poll(every);
      setCode(null);
      setMsg(r.status === 'connected' ? '' : r.status === 'denied' ? 'Access was declined in Google.' : 'The code expired; click Connect to get a new one.');
      if (r.status === 'connected') await api('POST', '/gdrive/upload').catch(() => {}); // first copy straight away
      load();
    }, every * 1000);
  };
  const ready = d.client_id && d.has_secret;

  return (
    <section className="card gdrive">
      <h2 className="card-title">Google Drive</h2>
      <p className="muted">Copies each new backup to a <b>{d.folder_name}</b> folder in your Google Drive, so it survives if this server fails, and keeps the newest copies there.
        SWunja can only see files it created in your Drive.</p>

      {d.connected ? <>
        <p><span className="pill status-ok">Connected</span>{' '}
          {d.last_upload ? <>Last copy <b>{d.last_upload.name}</b>, {ago(d.last_upload.at)}.</> : 'No copy yet.'}</p>
        {d.last_error && <p className="error">Last attempt failed: {d.last_error}</p>}
        <div className="row gap wrap">
          <button className="primary" disabled={busy} onClick={() => act(async () => {
            const r = await api<{ name?: string; error?: string }>('POST', '/gdrive/upload');
            setMsg(r.name ? `Uploaded ${r.name}` : r.error ?? ''); await load();
          })}><CloudUpload size={15} />Upload Latest Now</button>
          <label className="row gap small">Keep newest
            <input type="number" min={1} max={365} className="num" aria-label="Copies to keep" defaultValue={d.keep}
              onBlur={e => +e.target.value !== d.keep && act(async () => { await api('PUT', '/gdrive', { keep: +e.target.value }); await load(); })} /> copies</label>
          <span className="grow" />
          <button className="ghost danger" disabled={busy} onClick={() => confirm('Disconnect Google Drive? Copies already in Drive stay there.') && act(async () => { await api('DELETE', '/gdrive'); await load(); })}>Disconnect</button>
        </div>
      </> : <>
        <details className="guide" open={!ready}>
          <summary>One-time setup in Google Cloud (about 5 minutes)</summary>
          <ol className="gdrive-steps">
            <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud <ExternalLink size={12} /></a> and create a project, e.g. "SWunja".</li>
            <li>Enable the <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Drive API <ExternalLink size={12} /></a> for it.</li>
            <li>In <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noreferrer">Google Auth Platform <ExternalLink size={12} /></a>, set it up: app name "SWunja", your email, audience <b>External</b>.
              Then under <b>Audience</b>, click <b>Publish app</b> (In production) so the connection doesn't expire after 7 days.</li>
            <li>Under <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">Clients <ExternalLink size={12} /></a>, create a client of type <b>TVs and Limited Input devices</b>, and copy its Client ID and Client secret here.</li>
          </ol>
        </details>
        <form className="channel-grid" onSubmit={e => { e.preventDefault(); act(async () => { await api('PUT', '/gdrive', { client_id: form.client_id, client_secret: form.client_secret || undefined }); setForm(f => ({ ...f, client_secret: '' })); await load(); }); }}>
          <label className="field"><span className="field-name">Client ID</span>
            <input value={form.client_id} placeholder="1234-abc.apps.googleusercontent.com" onChange={e => setForm({ ...form, client_id: e.target.value })} /></label>
          <label className="field"><span className="field-name">Client Secret</span>
            <input type="password" autoComplete="new-password" value={form.client_secret} placeholder={d.has_secret ? 'Saved; leave blank to keep' : 'GOCSPX-…'} onChange={e => setForm({ ...form, client_secret: e.target.value })} /></label>
          <div className="field"><span className="field-name">&nbsp;</span><button disabled={busy || !form.client_id.trim() || (!d.has_secret && !form.client_secret)}>Save</button></div>
        </form>
        {ready && !code && <button className="primary" disabled={busy} onClick={() => act(async () => { const c = await api<Code>('POST', '/gdrive/connect'); setCode(c); poll(c.interval); })}>Connect Google Drive</button>}
        {code && (
          <div className="gdrive-code">
            <p>Open <a href={code.verification_url} target="_blank" rel="noreferrer">{code.verification_url.replace(/^https:\/\//, '')} <ExternalLink size={12} /></a>, sign in, and enter this code:</p>
            <p className="gdrive-user-code">{code.user_code}</p>
            <p className="muted small">Waiting for you to approve… (Google may say the app isn't verified: choose Advanced → Go to SWunja.)</p>
          </div>
        )}
      </>}
      {msg && <p className={msg.startsWith('Uploaded') ? 'hint' : 'error'}>{msg}</p>}
    </section>
  );
}
