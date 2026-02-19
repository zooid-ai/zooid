import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConfigSet, runConfigGet } from './config';

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
    it('sets server URL', () => {
      runConfigSet('server', 'https://my-server.workers.dev');

      const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8');
      const config = JSON.parse(raw);
      expect(config.server).toBe('https://my-server.workers.dev');
    });

    it('sets admin-token', () => {
      runConfigSet('admin-token', 'eyJ123');

      const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8');
      const config = JSON.parse(raw);
      expect(config.admin_token).toBe('eyJ123');
    });

    it('throws on unknown key', () => {
      expect(() => runConfigSet('unknown', 'val')).toThrow('Unknown config key');
    });
  });

  describe('runConfigGet()', () => {
    it('returns server URL', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify({ server: 'https://example.com' }),
      );
      expect(runConfigGet('server')).toBe('https://example.com');
    });

    it('returns undefined for unset key', () => {
      expect(runConfigGet('server')).toBeUndefined();
    });
  });
});
