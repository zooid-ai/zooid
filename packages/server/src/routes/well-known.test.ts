import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../index';
import { setupTestDb } from '../test-utils';

describe('GET /.well-known/zooid.json', () => {
  beforeAll(() => setupTestDb());
  it('returns 200 with server metadata', async () => {
    const res = await app.request('/.well-known/zooid.json', {}, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      version: string;
      algorithm: string;
      public_key_format: string;
      server_id: string;
      poll_interval: number;
      delivery: string[];
    };
    expect(body.version).toBe('0.1');
    expect(body.algorithm).toBe('Ed25519');
    expect(body.public_key_format).toBe('spki');
    expect(body.server_id).toBeTruthy();
    expect(body.poll_interval).toBeTypeOf('number');
    expect(body.delivery).toEqual(
      expect.arrayContaining(['poll', 'webhook', 'websocket', 'rss']),
    );
  });

  it('returns valid JSON content type', async () => {
    const res = await app.request('/.well-known/zooid.json', {}, env);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
