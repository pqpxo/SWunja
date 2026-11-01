import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fstatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { HttpError, actor, checkToken } from './services.ts';
import { registerApi } from './api.ts';
import { buildMcp } from './mcp.ts';
import { startJobs } from './jobs.ts';

// Which reverse proxies may set X-Forwarded-For/-Proto/-Host: by default only private addresses (a proxy on the LAN or
// in Docker, such as Nginx Proxy Manager or Caddy), so a client on the internet can't fake them. TRUST_PROXY overrides:
// true, false, or a comma-separated list of addresses/CIDRs.
const PRIVATE = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7';
export const trustProxy = (v = process.env.TRUST_PROXY) => (!v ? PRIVATE : v === 'true' ? true : v === 'false' ? false : v);

// Everything (scripts, styles, fonts) is served from here, so the policy can be strict. Inline styles stay allowed:
// the editor and React set them. Images may come from https, as pasted into descriptions.
const HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; "
    + "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
};

export async function buildApp(dataDir: string, o: { jobs?: boolean } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'samunja.db'));
  // behind a trusted reverse proxy req.protocol, req.host and req.ip (the login limit) come from X-Forwarded-*
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 10 * 1024 * 1024, trustProxy: trustProxy() });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Internal error' });
  });

  app.addHook('onSend', async (_req, reply) => { reply.headers(HEADERS); });
  registerApi(app, db, dataDir);

  // MCP over Streamable HTTP, stateless: a fresh server + transport per request.
  app.route({
    method: ['GET', 'POST', 'DELETE'], url: '/mcp',
    handler: async (req, reply) => {
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!checkToken(db, token)) return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Invalid or missing API token' });
      if (req.method !== 'POST') return reply.code(405).header('allow', 'POST').send({ error: 'Method not allowed' });
      const server = buildMcp(db, dataDir);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.hijack();
      reply.raw.on('close', () => { transport.close(); server.close(); });
      await actor.run('mcp', async () => {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      });
    },
  });

  const webDist = fileURLToPath(new URL('../web/dist', import.meta.url));
  if (existsSync(webDist)) {
    await app.register(fstatic, { root: webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || req.method !== 'GET' ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));
  }
  if (o.jobs) {
    const timer = startJobs(db, dataDir, app.log);
    app.addHook('onClose', async () => clearInterval(timer));
  }
  return app;
}

if (process.argv[1]?.endsWith('main.ts')) {
  const app = await buildApp(process.env.DATA_DIR ?? '/data', { jobs: true });
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
  // PID 1 in Docker gets no default SIGTERM handling; close cleanly so `docker stop` is quick
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => app.close().then(() => process.exit(0)));
}
