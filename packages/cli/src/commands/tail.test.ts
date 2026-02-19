import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTail } from './tail';

let tmpDir: string;
const mockClient = {
  tail: vi.fn(),
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

describe('tail command', () => {
  it('calls client.tail() and returns poll result', async () => {
    writeConfig();
    mockClient.tail.mockResolvedValueOnce({
      events: [
        { id: 'e1', type: 'signal', data: '{"v":1}', created_at: '2026-01-01T00:00:00Z' },
      ],
      cursor: 'e1',
      has_more: false,
    });

    const result = await runTail('signals');

    expect(mockClient.tail).toHaveBeenCalledWith('signals', {});
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe('e1');
    expect(result.cursor).toBe('e1');
    expect(result.has_more).toBe(false);
  });

  it('passes limit option', async () => {
    writeConfig();
    mockClient.tail.mockResolvedValueOnce({
      events: [],
      cursor: null,
      has_more: false,
    });

    await runTail('signals', { limit: 5 });

    expect(mockClient.tail).toHaveBeenCalledWith('signals', { limit: 5 });
  });

  it('passes type filter', async () => {
    writeConfig();
    mockClient.tail.mockResolvedValueOnce({
      events: [],
      cursor: null,
      has_more: false,
    });

    await runTail('signals', { type: 'alert' });

    expect(mockClient.tail).toHaveBeenCalledWith('signals', { type: 'alert' });
  });

  it('passes since option', async () => {
    writeConfig();
    mockClient.tail.mockResolvedValueOnce({
      events: [],
      cursor: null,
      has_more: false,
    });

    await runTail('signals', { since: '2026-01-01T00:00:00Z' });

    expect(mockClient.tail).toHaveBeenCalledWith('signals', {
      since: '2026-01-01T00:00:00Z',
    });
  });

  it('passes cursor option', async () => {
    writeConfig();
    mockClient.tail.mockResolvedValueOnce({
      events: [],
      cursor: null,
      has_more: false,
    });

    await runTail('signals', { cursor: 'abc' });

    expect(mockClient.tail).toHaveBeenCalledWith('signals', { cursor: 'abc' });
  });

  it('passes all options together', async () => {
    writeConfig();
    mockClient.tail.mockResolvedValueOnce({
      events: [],
      cursor: null,
      has_more: false,
    });

    await runTail('signals', {
      limit: 10,
      type: 'alert',
      since: '2026-01-01T00:00:00Z',
      cursor: 'xyz',
    });

    expect(mockClient.tail).toHaveBeenCalledWith('signals', {
      limit: 10,
      type: 'alert',
      since: '2026-01-01T00:00:00Z',
      cursor: 'xyz',
    });
  });
});
