import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDirectoryToken } from './directory';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zooid-test-'));
  vi.stubEnv('ZOOID_CONFIG_DIR', tmpDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(extra = {}) {
  const config = { current: 'https://test.workers.dev', servers: {}, ...extra };
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(config));
}

describe('getDirectoryToken()', () => {
  it('returns token when it exists and has valid prefix', () => {
    writeConfig({ directory_token: 'zd_abc123' });
    expect(getDirectoryToken()).toBe('zd_abc123');
  });

  it('returns undefined when token is missing', () => {
    writeConfig();
    expect(getDirectoryToken()).toBeUndefined();
  });

  it('returns undefined when token has wrong prefix', () => {
    writeConfig({ directory_token: 'wrong_prefix_token' });
    expect(getDirectoryToken()).toBeUndefined();
  });

  it('returns undefined when no config file exists', () => {
    expect(getDirectoryToken()).toBeUndefined();
  });
});
