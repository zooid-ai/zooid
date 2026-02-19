import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, getConfigPath, type ZooidConfig } from './config';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zooid-test-'));
  vi.stubEnv('ZOOID_CONFIG_DIR', tmpDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('config', () => {
  describe('getConfigPath()', () => {
    it('returns path inside ZOOID_CONFIG_DIR when set', () => {
      const p = getConfigPath();
      expect(p).toBe(path.join(tmpDir, 'config.json'));
    });
  });

  describe('loadConfig()', () => {
    it('returns empty config when file does not exist', () => {
      const config = loadConfig();
      expect(config).toEqual({});
    });

    it('loads config from file', () => {
      const data: ZooidConfig = {
        server: 'https://example.com',
        admin_token: 'tok',
      };
      fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(data));

      const config = loadConfig();
      expect(config.server).toBe('https://example.com');
      expect(config.admin_token).toBe('tok');
    });

    it('returns empty config on invalid JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'config.json'), 'not json');
      const config = loadConfig();
      expect(config).toEqual({});
    });
  });

  describe('saveConfig()', () => {
    it('writes config to file and creates directory', () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });

      const config: ZooidConfig = {
        server: 'https://test.com',
        admin_token: 'abc',
        channels: {
          'my-ch': { publish_token: 'pt', subscribe_token: 'st' },
        },
      };
      saveConfig(config);

      const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8');
      const loaded = JSON.parse(raw);
      expect(loaded.server).toBe('https://test.com');
      expect(loaded.channels['my-ch'].publish_token).toBe('pt');
    });

    it('merges with existing config', () => {
      saveConfig({ server: 'https://old.com' });
      saveConfig({ admin_token: 'new-tok' });

      const config = loadConfig();
      expect(config.server).toBe('https://old.com');
      expect(config.admin_token).toBe('new-tok');
    });
  });
});
