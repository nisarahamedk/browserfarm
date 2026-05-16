import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';
import type { BrowserfarmConfig } from './config.js';
import { allocatePort, discoverChromePath, launchChrome, waitForCdp } from './chrome.js';

const execFileAsync = promisify(execFile);
const PROFILE_PREFIX = 'session-';

type SessionStatus = 'starting' | 'ready' | 'stopping' | 'stopped' | 'crashed' | 'expired';

type Session = {
  id: string;
  status: SessionStatus;
  pid: number | null;
  port: number;
  profileDir: string;
  cdpUrl: string;
  debugUrl: string;
  cdpPath: string;
  createdAt: string;
  expiresAt: string;
  process: ReturnType<typeof launchChrome> | null;
  ttlTimer: NodeJS.Timeout | null;
};

export type PublicSession = Pick<Session, 'id' | 'status' | 'cdpUrl' | 'debugUrl' | 'createdAt' | 'expiresAt'>;

export class CapacityError extends Error {
  constructor(maxSessions: number) {
    super(`Maximum active sessions reached (${maxSessions})`);
    this.name = 'CapacityError';
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly chromePath: string;

  constructor(private readonly config: BrowserfarmConfig) {
    this.chromePath = discoverChromePath(config.chromePath);
  }

  get activeSessions(): number {
    return [...this.sessions.values()].filter((session) => session.status === 'starting' || session.status === 'ready').length;
  }

  get maxSessions(): number {
    return this.config.maxSessions;
  }

  async cleanupStaleProfiles(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.trashDir, { recursive: true });
    const [sessionEntries, trashEntries] = await Promise.all([
      readdir(this.sessionsDir, { withFileTypes: true }),
      readdir(this.trashDir, { withFileTypes: true }),
    ]);

    const staleProfileDirs = sessionEntries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(PROFILE_PREFIX))
      .map((entry) => path.join(this.sessionsDir, entry.name));
    const trashProfileDirs = trashEntries.filter((entry) => entry.isDirectory()).map((entry) => path.join(this.trashDir, entry.name));

    await Promise.all([...staleProfileDirs, ...trashProfileDirs].map((profileDir) => this.removeProfileEventually(profileDir)));
  }

  async createSession(): Promise<PublicSession> {
    if (this.activeSessions >= this.config.maxSessions) {
      throw new CapacityError(this.config.maxSessions);
    }

    await mkdir(this.sessionsDir, { recursive: true });

    const id = `sess_${nanoid(26).toLowerCase()}`;
    const createdAtDate = new Date();
    const expiresAtDate = new Date(createdAtDate.getTime() + this.config.defaultTtlSeconds * 1000);
    const port = await allocatePort(this.config.cdpBindHost);
    const profileDir = path.join(this.sessionsDir, `${PROFILE_PREFIX}${id}`);
    await mkdir(profileDir, { recursive: true });

    const session: Session = {
      id,
      status: 'starting',
      pid: null,
      port,
      profileDir,
      cdpUrl: '',
      debugUrl: '',
      cdpPath: '',
      createdAt: createdAtDate.toISOString(),
      expiresAt: expiresAtDate.toISOString(),
      process: null,
      ttlTimer: null,
    };
    this.sessions.set(id, session);

    try {
      const child = launchChrome(
        [
          `--remote-debugging-address=${this.config.cdpBindHost}`,
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
        ],
        this.chromePath,
      );

      session.process = child;
      session.pid = child.pid ?? null;
      child.unref();
      const startupFailure = new Promise<never>((_, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          if (session.status === 'starting') {
            reject(new Error(`Chrome exited before CDP was ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
          }
        });
      });
      child.once('exit', () => {
        if (session.status !== 'stopping' && session.status !== 'expired' && session.status !== 'stopped') {
          session.status = 'crashed';
          void this.removeSession(session, { removeFromRegistry: true });
        }
      });

      const version = await Promise.race([waitForCdp(port, this.config.cdpBindHost), startupFailure]);
      const browserPath = version.webSocketDebuggerUrl ? new URL(version.webSocketDebuggerUrl).pathname : '/devtools/browser';
      session.cdpPath = browserPath;
      session.debugUrl = publicDebugUrl(this.config.publicHost, this.config.port, session.id, this.config.authToken);
      session.cdpUrl = publicCdpUrl(this.config.publicHost, this.config.port, session.id, this.config.authToken);
      session.status = 'ready';
      session.ttlTimer = setTimeout(() => {
        session.status = 'expired';
        void this.removeSession(session, { removeFromRegistry: true });
      }, this.config.defaultTtlSeconds * 1000);
      session.ttlTimer.unref();

      return toPublicSession(session);
    } catch (error) {
      await this.removeSession(session, { removeFromRegistry: true });
      throw error;
    }
  }

  listSessions(): PublicSession[] {
    return [...this.sessions.values()].map(toPublicSession);
  }

  getSession(id: string): PublicSession | null {
    const session = this.sessions.get(id);
    return session ? toPublicSession(session) : null;
  }

  getCdpTarget(id: string): string | null {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'ready' || !session.cdpPath) {
      return null;
    }

    return `ws://${internalCdpHost(this.config.cdpBindHost)}:${session.port}${session.cdpPath}`;
  }

  getDebugTarget(id: string): string | null {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'ready') {
      return null;
    }

    return publicHttpUrl(internalCdpHost(this.config.cdpBindHost), session.port, '/json/version');
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    await this.removeSession(session, { removeFromRegistry: true });
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.removeSession(session, { removeFromRegistry: true })));
  }

  private get sessionsDir(): string {
    return path.join(this.config.dataDir, 'sessions');
  }

  private get trashDir(): string {
    return path.join(this.config.dataDir, 'trash');
  }

  private async removeSession(session: Session, options: { removeFromRegistry: boolean }): Promise<void> {
    if (session.ttlTimer) {
      clearTimeout(session.ttlTimer);
      session.ttlTimer = null;
    }

    if (session.status !== 'expired' && session.status !== 'crashed') {
      session.status = 'stopping';
    }

    await killProcessTree(session.pid);
    session.status = session.status === 'expired' || session.status === 'crashed' ? session.status : 'stopped';

    if (options.removeFromRegistry) {
      this.sessions.delete(session.id);
    }

    await this.removeProfileEventually(session.profileDir);
  }

  private async removeProfileEventually(profileDir: string): Promise<void> {
    try {
      await removeProfileWithRetries(profileDir);
    } catch (error) {
      console.warn(`profile cleanup deferred for ${profileDir}:`, error);
      void this.deferProfileCleanup(profileDir);
    }
  }

  private async deferProfileCleanup(profileDir: string): Promise<void> {
    const trashPath = path.join(this.trashDir, `${path.basename(profileDir)}-${Date.now()}`);
    try {
      await mkdir(this.trashDir, { recursive: true });
      await rename(profileDir, trashPath);
    } catch (error) {
      console.warn(`unable to move profile to trash ${profileDir}:`, error);
      return;
    }

    void retryInBackground(() => removeProfileWithRetries(trashPath), `profile cleanup ${trashPath}`);
  }
}

async function removeProfileWithRetries(profileDir: string): Promise<void> {
  const delays = [100, 250, 500, 1000, 2000];
  let lastError: unknown;

  for (const delay of [0, ...delays]) {
    if (delay > 0) {
      await sleep(delay);
    }

    try {
      await rm(profileDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function retryInBackground(operation: () => Promise<void>, label: string): Promise<void> {
  const delays = [5_000, 15_000, 30_000, 60_000];

  for (const delay of delays) {
    await sleep(delay);
    try {
      await operation();
      return;
    } catch (error) {
      console.warn(`${label} retry failed:`, error);
    }
  }
}

async function killProcessTree(pid: number | null): Promise<void> {
  if (!pid) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F']);
      return;
    }

    process.kill(-pid, 'SIGTERM');
    await sleep(800);
    try {
      process.kill(-pid, 0);
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  } catch {
    // Process may already be gone.
  }
}

function toPublicSession(session: Session): PublicSession {
  return {
    id: session.id,
    status: session.status,
    cdpUrl: session.cdpUrl,
    debugUrl: session.debugUrl,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

function publicHttpUrl(host: string, port: number, pathname: string): string {
  return `http://${host}:${port}${pathname}`;
}

function publicWsUrl(host: string, port: number, pathname: string): string {
  return `ws://${host}:${port}${pathname}`;
}

function publicCdpUrl(host: string, port: number, sessionId: string, authToken: string | null): string {
  const baseUrl = publicWsUrl(host, port, `/sessions/${sessionId}/cdp`);
  return authToken ? `${baseUrl}?token=${encodeURIComponent(authToken)}` : baseUrl;
}

function publicDebugUrl(host: string, port: number, sessionId: string, authToken: string | null): string {
  const baseUrl = publicHttpUrl(host, port, `/sessions/${sessionId}/json/version`);
  return authToken ? `${baseUrl}?token=${encodeURIComponent(authToken)}` : baseUrl;
}

function internalCdpHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
