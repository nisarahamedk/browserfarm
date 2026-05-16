#!/usr/bin/env node

const baseUrl = process.env.BROWSERFARM_URL ?? 'http://host.docker.internal:8787';
const token = process.env.BROWSERFARM_AUTH_TOKEN ?? null;

const headers = token ? { authorization: `Bearer ${token}` } : {};

const createResponse = await fetch(`${baseUrl}/sessions`, {
  method: 'POST',
  headers,
});

if (!createResponse.ok) {
  throw new Error(`create session failed: ${createResponse.status} ${await createResponse.text()}`);
}

const session = await createResponse.json();
console.log(`created ${session.id}`);

try {
  const debugResponse = await fetch(session.debugUrl);
  if (!debugResponse.ok) {
    throw new Error(`debug url failed: ${debugResponse.status} ${await debugResponse.text()}`);
  }

  const version = await debugResponse.json();
  if (!version.webSocketDebuggerUrl) {
    throw new Error('debug endpoint did not return webSocketDebuggerUrl');
  }

  const versionResult = await cdpCall(session.cdpUrl, 'Browser.getVersion');
  if (!versionResult.product || !versionResult.protocolVersion) {
    throw new Error(`unexpected CDP version response: ${JSON.stringify(versionResult)}`);
  }

  console.log('container smoke passed');
} finally {
  const deleteResponse = await fetch(`${baseUrl}/sessions/${session.id}`, {
    method: 'DELETE',
    headers,
  });
  if (!deleteResponse.ok) {
    console.error(`delete session failed: ${deleteResponse.status} ${await deleteResponse.text()}`);
    process.exitCode = 1;
  }
}

function cdpCall(cdpUrl, method) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cdpUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out waiting for ${method}`));
    }, 10_000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method }));
    });

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) {
        return;
      }

      clearTimeout(timeout);
      ws.close();

      if (message.error) {
        reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
        return;
      }

      resolve(message.result);
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error(`websocket error calling ${method}`));
    });
  });
}
