import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
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
    return [...this.sessions.values()].filter((session) => session.status !== 'stopping').length;
  }

  get maxSessions(): number {
    return this.config.maxSessions;
  }

  async cleanupStaleProfiles(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const entries = await readdir(this.sessionsDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(PROFILE_PREFIX))
        .map((entry) => rm(path.join(this.sessionsDir, entry.name), { recursive: true, force: true })),
    );
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
      debugUrl: publicHttpUrl(this.config.publicHost, port, '/json/version'),
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
      session.cdpUrl = publicWsUrl(this.config.publicHost, port, browserPath);
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

  private async removeSession(session: Session, options: { removeFromRegistry: boolean }): Promise<void> {
    if (session.ttlTimer) {
      clearTimeout(session.ttlTimer);
      session.ttlTimer = null;
    }

    if (session.status !== 'expired' && session.status !== 'crashed') {
      session.status = 'stopping';
    }

    await killProcessTree(session.pid);
    await rm(session.profileDir, { recursive: true, force: true });
    session.status = session.status === 'expired' || session.status === 'crashed' ? session.status : 'stopped';

    if (options.removeFromRegistry) {
      this.sessions.delete(session.id);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
