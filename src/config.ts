import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export type BrowserfarmConfig = {
  host: string;
  port: number;
  publicHost: string;
  authToken: string | null;
  chromePath: string | null;
  dataDir: string;
  maxSessions: number;
  defaultTtlSeconds: number;
  cdpBindHost: string;
};

const configSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8787),
  publicHost: z.string().default('127.0.0.1'),
  authToken: z.string().min(1).nullable().default(null),
  chromePath: z.string().min(1).nullable().default(null),
  dataDir: z.string().min(1).nullable().default(null),
  maxSessions: z.coerce.number().int().min(1).default(3),
  defaultTtlSeconds: z.coerce.number().int().min(1).default(1800),
  cdpBindHost: z.string().default('127.0.0.1'),
});

type RawConfig = Partial<z.input<typeof configSchema>>;

export function defaultConfigPath(platform = process.platform): string {
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'browserfarm', 'config.json');
  }

  return path.join(homedir(), '.browserfarm', 'config.json');
}

export function defaultDataDir(platform = process.platform): string {
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'browserfarm');
  }

  return path.join(homedir(), '.browserfarm');
}

export function loadConfig(configPath = process.env.BROWSERFARM_CONFIG ?? defaultConfigPath()): BrowserfarmConfig {
  const fileConfig = readConfigFile(configPath);
  const envConfig = readEnvConfig();
  const parsed = configSchema.parse({ ...fileConfig, ...envConfig });

  return {
    ...parsed,
    dataDir: parsed.dataDir ?? defaultDataDir(),
  };
}

function readConfigFile(configPath: string): RawConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, 'utf8');
  return JSON.parse(raw) as RawConfig;
}

function readEnvConfig(): RawConfig {
  return compact({
    host: process.env.BROWSERFARM_HOST,
    port: process.env.BROWSERFARM_PORT,
    publicHost: process.env.BROWSERFARM_PUBLIC_HOST,
    authToken: normalizeNullable(process.env.BROWSERFARM_AUTH_TOKEN),
    chromePath: normalizeNullable(process.env.BROWSERFARM_CHROME_PATH),
    dataDir: process.env.BROWSERFARM_DATA_DIR,
    maxSessions: process.env.BROWSERFARM_MAX_SESSIONS,
    defaultTtlSeconds: process.env.BROWSERFARM_DEFAULT_TTL_SECONDS,
    cdpBindHost: process.env.BROWSERFARM_CDP_BIND_HOST,
  });
}

function normalizeNullable(value: string | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === '' || value.toLowerCase() === 'null') {
    return null;
  }

  return value;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
