import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStatus } from './status';

let tmpDir: string;
const mockClient = {
  getMetadata: vi.fn(),
  getServerMeta: vi.fn(),
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

describe('status command', () => {
  it('returns server discovery and identity', async () => {
    writeConfig();
    mockClient.getMetadata.mockResolvedValueOnce({
      version: '0.1', algorithm: 'Ed25519', server_id: 'test-server',
      poll_interval: 30, delivery: ['poll', 'webhook', 'rss'],
    });
    mockClient.getServerMeta.mockResolvedValueOnce({
      name: 'zooid', description: null, tags: [], owner: null,
      company: null, email: null, updated_at: '2026-01-01T00:00:00Z',
    });

    const result = await runStatus();

    expect(result.discovery.algorithm).toBe('Ed25519');
    expect(result.discovery.delivery).toContain('poll');
    expect(result.identity.name).toBe('zooid');
  });

  it('throws when no server configured', async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

    await expect(runStatus()).rejects.toThrow('No server configured');
  });
});
