// Proxmox and UniFi ship self-signed certificates, so there is no CA to check them against. Instead the certificate's
// SHA-256 fingerprint is remembered on the first connection (trust on first use) and must match on every later one,
// so an API key is never sent to a machine pretending to be the server.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { connect, type TLSSocket } from 'node:tls';
import { HttpError } from './services.ts';

export type PinnedResponse = { status: number; text: string; fingerprint: string | null };

function tlsSocket(u: URL, timeout: number): Promise<{ sock: TLSSocket; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const sock = connect({ host, port: Number(u.port) || 443, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, timeout });
    sock.once('secureConnect', () => resolve({ sock, fingerprint: sock.getPeerCertificate().fingerprint256 }));
    sock.once('timeout', () => sock.destroy(new Error('timed out')));
    sock.once('error', reject);
  });
}

/**
 * GET over http(s). For https the certificate is read before anything is sent: with `pin` it must match,
 * otherwise the request is refused; the fingerprint seen is returned so the caller can remember it.
 */
export async function pinnedGet(url: string, headers: Record<string, string>, pin: string | null, timeout = 15_000): Promise<PinnedResponse> {
  const u = new URL(url);
  let sock: TLSSocket | undefined, fingerprint: string | null = null;
  if (u.protocol === 'https:') {
    ({ sock, fingerprint } = await tlsSocket(u, timeout));
    if (pin && fingerprint !== pin) {
      sock.destroy();
      throw new HttpError(502, `The certificate at ${u.host} has changed, so SWunja did not send the API key. `
        + 'If you renewed it, press Forget Certificate in Settings → Integrations and connect again.');
    }
  }
  return new Promise((resolve, reject) => {
    // with no agent, the request goes over the socket whose certificate was just checked
    const opts = sock ? { headers, timeout, createConnection: () => sock } : { headers, timeout };
    const req = (sock ? httpsRequest : httpRequest)(u, opts, res => {
      let text = '';
      res.on('data', c => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, fingerprint }));
    });
    req.once('timeout', () => req.destroy(new Error('timed out')));
    req.once('error', reject);
    req.end();
  });
}
