import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { CapacityError, SessionManager } from './session-manager.js';

const config = loadConfig();
const sessions = new SessionManager(config);
const app = new Hono();

app.use('*', async (c, next) => {
  if (c.req.path === '/health' || !config.authToken) {
    return next();
  }

  const authorization = c.req.header('authorization');
  if (authorization !== `Bearer ${config.authToken}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  return next();
});

app.get('/health', (c) => {
  return c.json({
    ok: true,
    activeSessions: sessions.activeSessions,
    maxSessions: sessions.maxSessions,
  });
});

app.post('/sessions', async (c) => {
  const contentLength = c.req.header('content-length');
  if (contentLength && Number(contentLength) > 0) {
    const body = await c.req.json().catch(() => null);
    if (body === null || (typeof body === 'object' && Object.keys(body).length > 0)) {
      return c.json({ error: 'invalid_request', message: 'POST /sessions accepts no body or an empty JSON object.' }, 400);
    }
  }

  try {
    return c.json(await sessions.createSession(), 201);
  } catch (error) {
    if (error instanceof CapacityError) {
      return c.json({ error: 'capacity_reached', message: error.message }, 429);
    }

    console.error(error);
    return c.json({ error: 'session_start_failed', message: error instanceof Error ? error.message : String(error) }, 500);
  }
});

app.get('/sessions', (c) => {
  return c.json({ sessions: sessions.listSessions() });
});

app.get('/sessions/:id', (c) => {
  const session = sessions.getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
  }

  return c.json(session);
});

app.delete('/sessions/:id', async (c) => {
  const deleted = await sessions.deleteSession(c.req.param('id'));
  if (!deleted) {
    return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
  }

  return c.json({ ok: true });
});

await sessions.cleanupStaleProfiles();

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    console.log(`browserfarm listening on http://${info.address}:${info.port}`);
  },
);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`received ${signal}; stopping browserfarm`);
  server.close();
  await sessions.shutdown();
  process.exit(0);
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));
