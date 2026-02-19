import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir: string;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn() })),
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zooid-test-'));
  vi.stubEnv('ZOOID_CONFIG_DIR', tmpDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('dev command', () => {
  it('runDev is an async function', async () => {
    const { runDev } = await import('./dev');
    expect(typeof runDev).toBe('function');
  });

  it('throws when server directory not found', async () => {
    const { runDev } = await import('./dev');
    await expect(runDev()).rejects.toThrow();
  });
});
