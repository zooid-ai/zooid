import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ChannelTokens {
  publish_token?: string;
  subscribe_token?: string;
}

/** Per-server credentials stored in ~/.zooid/config.json */
export interface ServerConfig {
  worker_url?: string;
  admin_token?: string;
  channels?: Record<string, ChannelTokens>;
}

/** On-disk config file shape */
export interface ZooidConfigFile {
  current?: string;
  servers?: Record<string, ServerConfig>;
  /** Directory token (per-GitHub-user, not per-server). */
  directory_token?: string;
}

/** Public config shape returned by loadConfig() — backward compatible */
export interface ZooidConfig {
  server?: string;
  worker_url?: string;
  admin_token?: string;
  channels?: Record<string, ChannelTokens>;
}

export function getConfigDir(): string {
  return process.env.ZOOID_CONFIG_DIR ?? path.join(os.homedir(), '.zooid');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

/** Read the raw config file, auto-migrating old flat format. */
export function loadConfigFile(): ZooidConfigFile {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw);

    // Migrate old flat format: { server, admin_token, worker_url, channels }
    if (parsed.server && !parsed.servers) {
      const serverUrl = parsed.server as string;
      const migrated: ZooidConfigFile = {
        current: serverUrl,
        servers: {
          [serverUrl]: {
            worker_url: parsed.worker_url,
            admin_token: parsed.admin_token,
            channels: parsed.channels,
          },
        },
      };
      // Write migrated format back
      const dir = getConfigDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        getConfigPath(),
        JSON.stringify(migrated, null, 2) + '\n',
      );
      return migrated;
    }

    return parsed as ZooidConfigFile;
  } catch {
    return {};
  }
}

/**
 * Resolve which server to use.
 * 1. zooid.json in cwd → use its url
 * 2. Fall back to `current` in config file
 * 3. Warn if both exist and differ
 */
export function resolveServer(): string | undefined {
  const file = loadConfigFile();

  // Try zooid.json in cwd
  let cwdUrl: string | undefined;
  try {
    const zooidJsonPath = path.join(process.cwd(), 'zooid.json');
    if (fs.existsSync(zooidJsonPath)) {
      const raw = fs.readFileSync(zooidJsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      cwdUrl = parsed.url || undefined;
    }
  } catch {
    // ignore
  }

  if (cwdUrl) {
    if (file.current && file.current !== cwdUrl) {
      console.log(
        `  Note: using server from zooid.json (${cwdUrl}), current is ${file.current}`,
      );
    }
    return cwdUrl;
  }

  return file.current;
}

/** Load config for the resolved server. */
export function loadConfig(): ZooidConfig {
  const file = loadConfigFile();
  const serverUrl = resolveServer();
  const entry = serverUrl ? file.servers?.[serverUrl] : undefined;

  return {
    server: serverUrl,
    worker_url: entry?.worker_url,
    admin_token: entry?.admin_token,
    channels: entry?.channels,
  };
}

/**
 * Save config for a specific server.
 * @param partial — fields to merge into the server entry
 * @param serverUrl — target server URL. If omitted, uses resolveServer().
 * @param options.setCurrent — whether to set this server as the active server (default true).
 *   Pass false when saving tokens for remote servers to avoid switching your active server.
 */
export function saveConfig(
  partial: Partial<ServerConfig>,
  serverUrl?: string,
  options?: { setCurrent?: boolean },
): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });

  const file = loadConfigFile();
  const url = serverUrl ?? resolveServer();
  if (!url) {
    throw new Error(
      'No server URL to save config for. Deploy first or set url in zooid.json.',
    );
  }

  if (!file.servers) file.servers = {};

  const existing = file.servers[url] ?? {};
  const merged = { ...existing, ...partial };

  // Deep merge channels
  if (partial.channels && existing.channels) {
    merged.channels = { ...existing.channels, ...partial.channels };
  }

  file.servers[url] = merged;
  if (options?.setCurrent !== false) {
    file.current = url;
  }

  fs.writeFileSync(getConfigPath(), JSON.stringify(file, null, 2) + '\n');
}

/** Load the directory token from config (top-level, not per-server). */
export function loadDirectoryToken(): string | undefined {
  const file = loadConfigFile();
  return file.directory_token;
}

/** Save the directory token to config (top-level, not per-server). */
export function saveDirectoryToken(token: string): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = loadConfigFile();
  file.directory_token = token;
  fs.writeFileSync(getConfigPath(), JSON.stringify(file, null, 2) + '\n');
}

/** Set the current server (for `config set server`). */
export function switchServer(url: string): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });

  const file = loadConfigFile();
  if (!file.servers) file.servers = {};
  if (!file.servers[url]) file.servers[url] = {};
  file.current = url;

  fs.writeFileSync(getConfigPath(), JSON.stringify(file, null, 2) + '\n');
}
