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

  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(session.cdpUrl);
  const page = await browser.newPage();
  await page.goto('data:text/html,<title>browserfarm-smoke</title>');
  const title = await page.title();
  await browser.close();

  if (title !== 'browserfarm-smoke') {
    throw new Error(`unexpected page title: ${title}`);
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
