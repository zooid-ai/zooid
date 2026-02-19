import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSubscribeWebhook, runSubscribePoll } from './subscribe';

let tmpDir: string;
const mockClient = {
  subscribe: vi.fn(),
  registerWebhook: vi.fn(),
};

vi.mock('@zooid/sdk', () => ({
  ZooidClient: vi.fn(() => mockClient),
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zooid-test-'));
  vi.stubEnv('ZOOID_CONFIG_DIR', tmpDir);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig() {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({ server: 'https://test.workers.dev' }),
  );
}

describe('subscribe command', () => {
  describe('runSubscribeWebhook()', () => {
    it('registers a webhook', async () => {
      writeConfig();
      mockClient.registerWebhook.mockResolvedValueOnce({
        id: 'wh-1', channel_id: 'signals',
        url: 'https://hook.example.com', expires_at: '2026-02-20T00:00:00Z',
      });

      const result = await runSubscribeWebhook('signals', 'https://hook.example.com');
      expect(result.id).toBe('wh-1');
      expect(mockClient.registerWebhook).toHaveBeenCalledWith(
        'signals', 'https://hook.example.com',
      );
    });
  });

  describe('runSubscribePoll()', () => {
    it('calls subscribe with callback, interval, mode, and type', async () => {
      writeConfig();
      const mockUnsub = vi.fn();
      mockClient.subscribe.mockResolvedValueOnce(mockUnsub);

      const unsub = await runSubscribePoll('signals', {
        interval: 3000,
        mode: 'poll',
        type: 'alert',
        callback: vi.fn(),
      });

      expect(mockClient.subscribe).toHaveBeenCalledWith(
        'signals', expect.any(Function), { interval: 3000, mode: 'poll', type: 'alert' },
      );
      expect(typeof unsub).toBe('function');
    });

    it('defaults mode and type to undefined', async () => {
      writeConfig();
      const mockUnsub = vi.fn();
      mockClient.subscribe.mockResolvedValueOnce(mockUnsub);

      await runSubscribePoll('signals', {
        interval: 5000,
        callback: vi.fn(),
      });

      expect(mockClient.subscribe).toHaveBeenCalledWith(
        'signals', expect.any(Function), { interval: 5000, mode: undefined, type: undefined },
      );
    });
  });
});
