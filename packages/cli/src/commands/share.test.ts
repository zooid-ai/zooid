import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runShare } from './share';

let tmpDir: string;
const mockClient = {
  listChannels: vi.fn(),
  getClaim: vi.fn(),
};

vi.mock('@zooid/sdk', () => ({
  ZooidClient: vi.fn(() => mockClient),
}));

const mockDirectoryFetch = vi.fn();
vi.mock('../lib/directory', () => ({
  DIRECTORY_BASE_URL: 'https://directory.zooid.dev',
  directoryFetch: (...args: unknown[]) => mockDirectoryFetch(...args),
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

describe('share command', () => {
  it('shares specified public channels', async () => {
    writeConfig();
    mockClient.listChannels.mockResolvedValueOnce([
      { id: 'ch-a', name: 'Channel A', description: 'Desc A', tags: ['ai'], is_public: true, event_count: 5 },
      { id: 'ch-b', name: 'Channel B', description: null, tags: [], is_public: true, event_count: 0 },
    ]);
    mockClient.getClaim.mockResolvedValueOnce({ claim: 'claim-b64', signature: 'sig-b64' });
    mockDirectoryFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ server_url: TEST_SERVER, channels: [{ id: 'ch-a' }] }), { status: 200 }),
    );

    await runShare(['ch-a']);

    expect(mockClient.getClaim).toHaveBeenCalledWith(['ch-a']);
    expect(mockDirectoryFetch).toHaveBeenCalledWith(
      '/api/servers',
      expect.objectContaining({
        method: 'POST',
      }),
    );

    // Verify the body sent to directory
    const call = mockDirectoryFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.claim).toBe('claim-b64');
    expect(body.signature).toBe('sig-b64');
    expect(body.server_url).toBe(TEST_SERVER);
    expect(body.channels).toEqual([
      { channel_id: 'ch-a', name: 'Channel A', description: 'Desc A', tags: ['ai'] },
    ]);
  });

  it('shares all public channels when none specified', async () => {
    writeConfig();
    mockClient.listChannels.mockResolvedValueOnce([
      { id: 'pub-1', name: 'Public 1', description: null, tags: [], is_public: true, event_count: 0 },
      { id: 'priv-1', name: 'Private 1', description: null, tags: [], is_public: false, event_count: 0 },
      { id: 'pub-2', name: 'Public 2', description: null, tags: [], is_public: true, event_count: 0 },
    ]);
    mockClient.getClaim.mockResolvedValueOnce({ claim: 'c', signature: 's' });
    mockDirectoryFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ channels: [] }), { status: 200 }),
    );

    await runShare([]);

    // Should only share public channels
    expect(mockClient.getClaim).toHaveBeenCalledWith(['pub-1', 'pub-2']);
  });

  it('throws when trying to share a private channel', async () => {
    writeConfig();
    mockClient.listChannels.mockResolvedValueOnce([
      { id: 'priv', name: 'Private', description: null, tags: [], is_public: false, event_count: 0 },
    ]);

    await expect(runShare(['priv'])).rejects.toThrow('Cannot share private channels');
  });

  it('throws when channel does not exist', async () => {
    writeConfig();
    mockClient.listChannels.mockResolvedValueOnce([
      { id: 'ch-a', name: 'A', description: null, tags: [], is_public: true, event_count: 0 },
    ]);

    await expect(runShare(['nonexistent'])).rejects.toThrow('Channels not found: nonexistent');
  });

  it('throws when no public channels exist and none specified', async () => {
    writeConfig();
    mockClient.listChannels.mockResolvedValueOnce([
      { id: 'priv', name: 'Private', description: null, tags: [], is_public: false, event_count: 0 },
    ]);

    await expect(runShare([])).rejects.toThrow('No public channels');
  });

  it('throws on directory API error', async () => {
    writeConfig();
    mockClient.listChannels.mockResolvedValueOnce([
      { id: 'ch-a', name: 'A', description: null, tags: [], is_public: true, event_count: 0 },
    ]);
    mockClient.getClaim.mockResolvedValueOnce({ claim: 'c', signature: 's' });
    mockDirectoryFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_signature', message: 'Ed25519 signature verification failed' }), { status: 403 }),
    );

    await expect(runShare(['ch-a'])).rejects.toThrow('invalid_signature: Ed25519 signature verification failed');
  });
});
