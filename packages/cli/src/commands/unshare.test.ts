import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runUnshare } from './unshare';

let tmpDir: string;
const mockClient = {
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

describe('unshare command', () => {
  it('sends delete claim to directory API', async () => {
    writeConfig();
    mockClient.getClaim.mockResolvedValueOnce({ claim: 'del-claim', signature: 'del-sig' });
    mockDirectoryFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await runUnshare('my-channel');

    expect(mockClient.getClaim).toHaveBeenCalledWith(['my-channel'], 'delete');
    expect(mockDirectoryFetch).toHaveBeenCalledWith(
      '/api/servers/channels',
      expect.objectContaining({ method: 'DELETE' }),
    );

    const call = mockDirectoryFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.server_url).toBe(TEST_SERVER);
    expect(body.channel_id).toBe('my-channel');
    expect(body.claim).toBe('del-claim');
    expect(body.signature).toBe('del-sig');
  });

  it('throws when no server configured', async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

    await expect(runUnshare('ch')).rejects.toThrow();
  });

  it('throws on directory API error', async () => {
    writeConfig();
    mockClient.getClaim.mockResolvedValueOnce({ claim: 'c', signature: 's' });
    mockDirectoryFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'not_found', message: 'Channel not found in directory' }), { status: 404 }),
    );

    await expect(runUnshare('missing-ch')).rejects.toThrow('not_found: Channel not found in directory');
  });
});
