import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPublish } from './publish';

let tmpDir: string;
const mockClient = {
  publish: vi.fn(),
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

function writeConfig(channelTokens: Record<string, string> = {}) {
  const channels: Record<string, unknown> = {};
  for (const [ch, tok] of Object.entries(channelTokens)) {
    channels[ch] = { publish_token: tok };
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({
      server: 'https://test.workers.dev',
      admin_token: 'admin-jwt',
      channels,
    }),
  );
}

describe('publish command', () => {
  it('publishes an event with type and data', async () => {
    writeConfig({ signals: 'pub-tok' });
    mockClient.publish.mockResolvedValueOnce({
      id: 'evt-1',
      channel_id: 'signals',
      type: 'alert',
      data: '{"v":1}',
    });

    const result = await runPublish('signals', {
      type: 'alert',
      data: '{"v":1}',
    });

    expect(mockClient.publish).toHaveBeenCalledWith('signals', {
      type: 'alert',
      data: { v: 1 },
    });
    expect(result.id).toBe('evt-1');
  });

  it('publishes from a JSON file', async () => {
    writeConfig({ signals: 'pub-tok' });
    const filePath = path.join(tmpDir, 'event.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({ type: 'test', data: { a: 1 } }),
    );

    mockClient.publish.mockResolvedValueOnce({
      id: 'evt-2',
      channel_id: 'signals',
      type: 'test',
      data: '{"a":1}',
    });

    const result = await runPublish('signals', { file: filePath });
    expect(result.id).toBe('evt-2');
  });

  it('publishes data-only event without type', async () => {
    writeConfig({ signals: 'pub-tok' });
    mockClient.publish.mockResolvedValueOnce({
      id: 'evt-3',
      channel_id: 'signals',
      type: null,
      data: '{"hello":"world"}',
    });

    await runPublish('signals', { data: '{"hello":"world"}' });

    expect(mockClient.publish).toHaveBeenCalledWith('signals', {
      data: { hello: 'world' },
    });
  });

  it('falls back to admin token when no publish token exists', async () => {
    writeConfig();
    mockClient.publish.mockResolvedValueOnce({ id: 'evt-4' });

    await runPublish('signals', { data: '{}' });
    expect(mockClient.publish).toHaveBeenCalled();
  });

  it('throws on invalid JSON data', async () => {
    writeConfig({ signals: 'pub-tok' });

    await expect(runPublish('signals', { data: 'not json' })).rejects.toThrow();
  });
});
