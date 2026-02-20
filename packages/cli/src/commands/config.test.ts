import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConfigSet, runConfigGet } from './config';
import { loadConfigFile, saveConfig } from '../lib/config';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zooid-test-'));
  vi.stubEnv('ZOOID_CONFIG_DIR', tmpDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('config commands', () => {
  describe('runConfigSet()', () => {
    it('sets server by switching current', () => {
      runConfigSet('server', 'https://my-server.workers.dev');

      const file = loadConfigFile();
      expect(file.current).toBe('https://my-server.workers.dev');
      expect(file.servers!['https://my-server.workers.dev']).toEqual({});
    });

    it('sets admin-token for current server', () => {
      // Set up a current server first
      runConfigSet('server', 'https://my-server.workers.dev');
      runConfigSet('admin-token', 'eyJ123');

      const file = loadConfigFile();
      expect(file.servers!['https://my-server.workers.dev'].admin_token).toBe(
        'eyJ123',
      );
    });

    it('throws on unknown key', () => {
      expect(() => runConfigSet('unknown', 'val')).toThrow(
        'Unknown config key',
      );
    });

    it('sets telemetry on', () => {
      runConfigSet('telemetry', 'on');
      const raw = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
      );
      expect(raw.telemetry).toBe(true);
    });

    it('sets telemetry off', () => {
      runConfigSet('telemetry', 'off');
      const raw = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
      );
      expect(raw.telemetry).toBe(false);
    });
  });

  describe('runConfigGet()', () => {
    it('returns server URL from current', () => {
      saveConfig({ admin_token: 'tok' }, 'https://example.com');
      expect(runConfigGet('server')).toBe('https://example.com');
    });

    it('returns undefined for unset key', () => {
      expect(runConfigGet('server')).toBeUndefined();
    });

    it('returns telemetry status', () => {
      expect(runConfigGet('telemetry')).toBe('on'); // default
      runConfigSet('telemetry', 'off');
      expect(runConfigGet('telemetry')).toBe('off');
    });
  });
});
