import { loadConfig, saveConfig, switchServer } from '../lib/config';
import { isEnabled, writeTelemetryFlag } from '../lib/telemetry';

const VALID_KEYS = ['server', 'admin-token', 'telemetry'] as const;

export function runConfigSet(key: string, value: string): void {
  if (key === 'server') {
    switchServer(value);
  } else if (key === 'admin-token') {
    saveConfig({ admin_token: value });
  } else if (key === 'telemetry') {
    const enabled = value === 'on' || value === 'true' || value === '1';
    writeTelemetryFlag(enabled);
  } else {
    throw new Error(
      `Unknown config key: "${key}". Valid keys: ${VALID_KEYS.join(', ')}`,
    );
  }
}

export function runConfigGet(key: string): string | undefined {
  const config = loadConfig();

  if (key === 'server') return config.server;
  if (key === 'admin-token') return config.admin_token;
  if (key === 'telemetry') return isEnabled() ? 'on' : 'off';

  throw new Error(
    `Unknown config key: "${key}". Valid keys: ${VALID_KEYS.join(', ')}`,
  );
}
