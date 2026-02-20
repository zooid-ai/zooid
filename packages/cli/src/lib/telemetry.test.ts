import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isEnabled,
  showNoticeIfNeeded,
  writeEvent,
  getInstallId,
  getQueuePath,
  writeTelemetryFlag,
} from './telemetry';
import type { TelemetryEvent } from './telemetry';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zooid-telemetry-'));
  vi.stubEnv('ZOOID_CONFIG_DIR', tmpDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
}

function writeConfig(data: Record<string, unknown>): void {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(data));
}

function readQueue(): TelemetryEvent[] {
  return JSON.parse(fs.readFileSync(getQueuePath(), 'utf-8'));
}

function makeEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    install_id: 'test-uuid',
    command: 'status',
    exit_code: 0,
    duration_ms: 42,
    cli_version: '0.0.0',
    os: 'darwin',
    arch: 'arm64',
    node_version: 'v20.0.0',
    ts: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('telemetry', () => {
  describe('isEnabled()', () => {
    it('returns true by default (no config, no env)', () => {
      expect(isEnabled()).toBe(true);
    });

    it('returns true when config telemetry is true', () => {
      writeConfig({ telemetry: true });
      expect(isEnabled()).toBe(true);
    });

    it('returns false when config telemetry is false', () => {
      writeConfig({ telemetry: false });
      expect(isEnabled()).toBe(false);
    });

    it('respects ZOOID_TELEMETRY=0 env var', () => {
      vi.stubEnv('ZOOID_TELEMETRY', '0');
      writeConfig({ telemetry: true }); // Config says on, env says off
      expect(isEnabled()).toBe(false);
    });

    it('respects ZOOID_TELEMETRY=false env var', () => {
      vi.stubEnv('ZOOID_TELEMETRY', 'false');
      expect(isEnabled()).toBe(false);
    });

    it('respects ZOOID_TELEMETRY=off env var', () => {
      vi.stubEnv('ZOOID_TELEMETRY', 'off');
      expect(isEnabled()).toBe(false);
    });

    it('env var overrides config (env=1 wins over config=false)', () => {
      vi.stubEnv('ZOOID_TELEMETRY', '1');
      writeConfig({ telemetry: false });
      expect(isEnabled()).toBe(true);
    });
  });

  describe('showNoticeIfNeeded()', () => {
    it('shows notice on first run and sets flag', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const shown = showNoticeIfNeeded();
      spy.mockRestore();

      expect(shown).toBe(true);
      expect(readConfig().telemetry).toBe(true);
    });

    it('does not show notice if already shown', () => {
      writeConfig({ telemetry: true });
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const shown = showNoticeIfNeeded();
      spy.mockRestore();

      expect(shown).toBe(false);
    });

    it('does not show notice if telemetry explicitly disabled', () => {
      writeConfig({ telemetry: false });
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const shown = showNoticeIfNeeded();
      spy.mockRestore();

      expect(shown).toBe(false);
    });

    it('does not show notice if ZOOID_TELEMETRY=0', () => {
      vi.stubEnv('ZOOID_TELEMETRY', '0');
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const shown = showNoticeIfNeeded();
      spy.mockRestore();

      expect(shown).toBe(false);
    });
  });

  describe('getInstallId()', () => {
    it('generates a UUID and persists it', () => {
      const id = getInstallId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(readConfig().install_id).toBe(id);
    });

    it('returns the same ID on subsequent calls', () => {
      const id1 = getInstallId();
      const id2 = getInstallId();
      expect(id1).toBe(id2);
    });

    it('preserves existing config fields', () => {
      writeConfig({ telemetry: true, current: 'https://example.com' });
      getInstallId();
      const config = readConfig();
      expect(config.telemetry).toBe(true);
      expect(config.current).toBe('https://example.com');
      expect(config.install_id).toBeTruthy();
    });
  });

  describe('writeEvent()', () => {
    it('writes an event to the queue file', () => {
      const event = makeEvent();
      writeEvent(event);

      const queue = readQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].command).toBe('status');
    });

    it('appends to existing queue', () => {
      writeEvent(makeEvent({ command: 'publish' }));
      writeEvent(makeEvent({ command: 'tail' }));

      const queue = readQueue();
      expect(queue).toHaveLength(2);
      expect(queue[0].command).toBe('publish');
      expect(queue[1].command).toBe('tail');
    });

    it('caps queue at 1000 events', () => {
      // Write 1001 events
      for (let i = 0; i < 1001; i++) {
        writeEvent(makeEvent({ command: `cmd-${i}` }));
      }

      const queue = readQueue();
      expect(queue).toHaveLength(1000);
      // First event should be cmd-1 (cmd-0 was trimmed)
      expect(queue[0].command).toBe('cmd-1');
      expect(queue[999].command).toBe('cmd-1000');
    });

    it('queue file is inspectable JSON', () => {
      writeEvent(makeEvent());
      const raw = fs.readFileSync(getQueuePath(), 'utf-8');
      // Should be pretty-printed with indentation
      expect(raw).toContain('  ');
      // Should be valid JSON
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('includes channel_id and server_url when provided', () => {
      writeEvent(
        makeEvent({
          command: 'tail',
          channel_id: 'crypto-signals',
          server_url: 'https://my.zooid.dev',
        }),
      );

      const queue = readQueue();
      expect(queue[0].channel_id).toBe('crypto-signals');
      expect(queue[0].server_url).toBe('https://my.zooid.dev');
    });

    it('omits channel_id and server_url when not provided', () => {
      writeEvent(makeEvent());

      const queue = readQueue();
      expect(queue[0].channel_id).toBeUndefined();
      expect(queue[0].server_url).toBeUndefined();
    });

    it('includes error message for failed commands', () => {
      writeEvent(
        makeEvent({
          command: 'publish',
          exit_code: 1,
          error: 'Cannot connect to https://my.zooid.dev — fetch failed',
        }),
      );

      const queue = readQueue();
      expect(queue[0].exit_code).toBe(1);
      expect(queue[0].error).toBe(
        'Cannot connect to https://my.zooid.dev — fetch failed',
      );
    });

    it('omits error field for successful commands', () => {
      writeEvent(makeEvent({ exit_code: 0 }));

      const queue = readQueue();
      expect(queue[0].exit_code).toBe(0);
      expect(queue[0].error).toBeUndefined();
    });
  });

  describe('writeTelemetryFlag()', () => {
    it('sets telemetry to true', () => {
      writeTelemetryFlag(true);
      expect(readConfig().telemetry).toBe(true);
    });

    it('sets telemetry to false', () => {
      writeTelemetryFlag(false);
      expect(readConfig().telemetry).toBe(false);
    });

    it('preserves other config fields', () => {
      writeConfig({ current: 'https://example.com' });
      writeTelemetryFlag(true);
      const config = readConfig();
      expect(config.current).toBe('https://example.com');
      expect(config.telemetry).toBe(true);
    });
  });
});
