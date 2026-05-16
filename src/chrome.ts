import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { delimiter } from 'node:path';

export type ChromeVersionResponse = {
  webSocketDebuggerUrl?: string;
};

export function discoverChromePath(explicitPath: string | null): string {
  if (explicitPath) {
    return explicitPath;
  }

  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }

  for (const command of ['google-chrome', 'chromium', 'chromium-browser']) {
    const resolved = findOnPath(command);
    if (resolved) {
      return resolved;
    }
  }

  return 'google-chrome';
}

export async function allocatePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Unable to allocate a TCP port'));
        }
      });
    });
  });
}

export function launchChrome(args: string[], chromePath: string): ChildProcess {
  return spawn(chromePath, args, {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
}

export async function waitForCdp(port: number, host: string, timeoutMs = 15_000): Promise<ChromeVersionResponse> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://${host}:${port}/json/version`);
      if (response.ok) {
        return (await response.json()) as ChromeVersionResponse;
      }
      lastError = new Error(`CDP returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for Chrome CDP: ${String(lastError)}`);
}

function findOnPath(command: string): string | null {
  const pathValue = process.env.PATH ?? '';
  for (const entry of pathValue.split(delimiter)) {
    const candidate = `${entry}/${command}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
