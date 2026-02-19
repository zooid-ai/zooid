import { loadConfig, saveConfig } from '../lib/config';

const VALID_KEYS = ['server', 'admin-token'] as const;

export function runConfigSet(key: string, value: string): void {
  if (key === 'server') {
    saveConfig({ server: value });
  } else if (key === 'admin-token') {
    saveConfig({ admin_token: value });
  } else {
    throw new Error(`Unknown config key: "${key}". Valid keys: ${VALID_KEYS.join(', ')}`);
  }
}

export function runConfigGet(key: string): string | undefined {
  const config = loadConfig();

  if (key === 'server') return config.server;
  if (key === 'admin-token') return config.admin_token;

  throw new Error(`Unknown config key: "${key}". Valid keys: ${VALID_KEYS.join(', ')}`);
}
