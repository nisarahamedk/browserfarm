import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
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
  const token = c.req.query('token');
  if (authorization !== `Bearer ${config.authToken}` && token !== config.authToken) {
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

app.get('/sessions/:id/json/version', async (c) => {
  const targetUrl = sessions.getDebugTarget(c.req.param('id'));
  if (!targetUrl) {
    return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
  }

  try {
    const response = await fetch(targetUrl);
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    });
  } catch (error) {
    return c.json({ error: 'debug_proxy_failed', message: error instanceof Error ? error.message : String(error) }, 502);
  }
});

app.get('/sessions/:id', (c) => {
  const session = sessions.getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
  }

  return c.json(session);
});

app.get('/sessions/:id/cdp', (c) => {
  return c.json({ error: 'upgrade_required', message: 'Connect to this endpoint with WebSocket.' }, 426);
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

const cdpProxy = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const match = /^\/sessions\/([^/]+)\/cdp$/.exec(url.pathname);
  if (!match) {
    socket.destroy();
    return;
  }

  if (config.authToken && request.headers.authorization !== `Bearer ${config.authToken}` && url.searchParams.get('token') !== config.authToken) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const targetUrl = sessions.getCdpTarget(match[1]);
  if (!targetUrl) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  cdpProxy.handleUpgrade(request, socket, head, (client) => {
    proxyWebSocket(client, targetUrl);
  });
});

function proxyWebSocket(client: WebSocket, targetUrl: string): void {
  const upstream = new WebSocket(targetUrl);
  let upstreamOpen = false;
  const queued: Array<{ message: WebSocket.RawData; isBinary: boolean }> = [];

  upstream.on('open', () => {
    upstreamOpen = true;
    for (const { message, isBinary } of queued.splice(0)) {
      upstream.send(message, { binary: isBinary });
    }
  });

  client.on('message', (message, isBinary) => {
    if (upstreamOpen) {
      upstream.send(message, { binary: isBinary });
      return;
    }

    queued.push({ message, isBinary });
  });

  upstream.on('message', (message, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message, { binary: isBinary });
    }
  });

  const closeBoth = () => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close();
    }
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  };

  client.on('close', closeBoth);
  client.on('error', closeBoth);
  upstream.on('close', closeBoth);
  upstream.on('error', closeBoth);
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`received ${signal}; stopping browserfarm`);
  cdpProxy.close();
  server.close();
  await sessions.shutdown();
  process.exit(0);
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));
