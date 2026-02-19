import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ChannelTokens {
  publish_token?: string;
  subscribe_token?: string;
}

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

export function loadConfig(): ZooidConfig {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8');
    return JSON.parse(raw) as ZooidConfig;
  } catch {
    return {};
  }
}

export function saveConfig(partial: Partial<ZooidConfig>): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadConfig();
  const merged = { ...existing, ...partial };

  // Deep merge channels
  if (partial.channels && existing.channels) {
    merged.channels = { ...existing.channels, ...partial.channels };
  }

  fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2) + '\n');
}
