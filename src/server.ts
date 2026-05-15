import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => {
  return c.json({
    ok: true,
    activeSessions: 0,
    maxSessions: 3,
  });
});

app.post('/sessions', (c) => {
  return c.json(
    {
      error: 'not_implemented',
      message: 'Session creation is defined in MVP_SPEC.md and not implemented yet.',
    },
    501,
  );
});

app.get('/sessions', (c) => {
  return c.json({ sessions: [] });
});

app.get('/sessions/:id', (c) => {
  return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
});

app.delete('/sessions/:id', (c) => {
  return c.json({ error: 'not_found', id: c.req.param('id') }, 404);
});

const port = Number(process.env.BROWSERFARM_PORT ?? 8787);
const host = process.env.BROWSERFARM_HOST ?? '127.0.0.1';

serve(
  {
    fetch: app.fetch,
    port,
    hostname: host,
  },
  (info) => {
    console.log(`browserfarm listening on http://${info.address}:${info.port}`);
  },
);
