import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runChannelCreate,
  runChannelList,
  runChannelAddPublisher,
} from './channel';

let tmpDir: string;
const mockClient = {
  createChannel: vi.fn(),
  listChannels: vi.fn(),
  addPublisher: vi.fn(),
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

const TEST_SERVER = 'https://test.workers.dev';

function writeConfig(overrides = {}) {
  const config = {
    current: TEST_SERVER,
    servers: {
      [TEST_SERVER]: {
        admin_token: 'admin-jwt',
        ...overrides,
      },
    },
  };
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(config));
}

describe('channel commands', () => {
  describe('runChannelCreate()', () => {
    it('creates a public channel and saves tokens to config', async () => {
      writeConfig();
      mockClient.createChannel.mockResolvedValueOnce({
        id: 'signals',
        publish_token: 'pub-tok',
        subscribe_token: 'sub-tok',
      });

      const result = await runChannelCreate('signals', {
        name: 'Signals',
        public: true,
        description: 'Test channel',
      });

      expect(mockClient.createChannel).toHaveBeenCalledWith({
        id: 'signals',
        name: 'Signals',
        is_public: true,
        description: 'Test channel',
      });
      expect(result.id).toBe('signals');
      expect(result.publish_token).toBe('pub-tok');

      const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8');
      const file = JSON.parse(raw);
      const serverEntry = file.servers[TEST_SERVER];
      expect(serverEntry.channels.signals.publish_token).toBe('pub-tok');
      expect(serverEntry.channels.signals.subscribe_token).toBe('sub-tok');
    });

    it('throws when no server configured', async () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

      await expect(runChannelCreate('test', { name: 'Test' })).rejects.toThrow(
        'No server configured',
      );
    });
  });

  describe('runChannelList()', () => {
    it('returns list of channels', async () => {
      writeConfig();
      mockClient.listChannels.mockResolvedValueOnce([
        { id: 'ch1', name: 'Channel 1', is_public: true, event_count: 5 },
        { id: 'ch2', name: 'Channel 2', is_public: false, event_count: 0 },
      ]);

      const channels = await runChannelList();
      expect(channels).toHaveLength(2);
      expect(channels[0].id).toBe('ch1');
    });
  });

  describe('runChannelAddPublisher()', () => {
    it('adds a publisher and returns token', async () => {
      writeConfig();
      mockClient.addPublisher.mockResolvedValueOnce({
        id: 'pub-1',
        name: 'my-bot',
        publish_token: 'bot-tok',
      });

      const result = await runChannelAddPublisher('signals', 'my-bot');
      expect(result.name).toBe('my-bot');
      expect(result.publish_token).toBe('bot-tok');
    });
  });
});
