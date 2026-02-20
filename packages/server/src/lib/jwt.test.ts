import { describe, it, expect } from 'vitest';
import { createToken, verifyToken } from './jwt';

const TEST_SECRET = 'test-secret-key-for-jwt-testing-purposes';

describe('JWT', () => {
  describe('createToken', () => {
    it('creates a valid admin token', async () => {
      const token = await createToken({ scope: 'admin' }, TEST_SECRET);
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('creates a publish token scoped to a channel', async () => {
      const token = await createToken(
        { scope: 'publish', channel: 'test-channel' },
        TEST_SECRET,
      );
      const payload = await verifyToken(token, TEST_SECRET);
      expect(payload.scope).toBe('publish');
      expect(payload.channel).toBe('test-channel');
    });

    it('creates a subscribe token scoped to a channel', async () => {
      const token = await createToken(
        { scope: 'subscribe', channel: 'test-channel' },
        TEST_SECRET,
      );
      const payload = await verifyToken(token, TEST_SECRET);
      expect(payload.scope).toBe('subscribe');
      expect(payload.channel).toBe('test-channel');
    });

    it('includes sub claim when provided', async () => {
      const token = await createToken(
        { scope: 'publish', channel: 'test-channel', sub: 'bot-1' },
        TEST_SECRET,
      );
      const payload = await verifyToken(token, TEST_SECRET);
      expect(payload.sub).toBe('bot-1');
    });

    it('includes iat claim', async () => {
      const token = await createToken({ scope: 'admin' }, TEST_SECRET);
      const payload = await verifyToken(token, TEST_SECRET);
      expect(payload.iat).toBeTypeOf('number');
    });

    it('includes exp claim when expiry is provided', async () => {
      const token = await createToken({ scope: 'admin' }, TEST_SECRET, {
        expiresIn: 3600,
      });
      const payload = await verifyToken(token, TEST_SECRET);
      expect(payload.exp).toBeTypeOf('number');
      expect(payload.exp! - payload.iat).toBe(3600);
    });

    it('omits exp claim when no expiry', async () => {
      const token = await createToken({ scope: 'admin' }, TEST_SECRET);
      const payload = await verifyToken(token, TEST_SECRET);
      expect(payload.exp).toBeUndefined();
    });
  });

  describe('verifyToken', () => {
    it('verifies a valid token', async () => {
      const token = await createToken({ scope: 'admin' }, TEST_SECRET);
      const payload = await verifyToken(token, TEST_SECRET);
      expect(payload.scope).toBe('admin');
    });

    it('rejects a token signed with a different secret', async () => {
      const token = await createToken({ scope: 'admin' }, TEST_SECRET);
      await expect(verifyToken(token, 'wrong-secret')).rejects.toThrow();
    });

    it('rejects a malformed token', async () => {
      await expect(verifyToken('not-a-jwt', TEST_SECRET)).rejects.toThrow();
    });

    it('rejects an expired token', async () => {
      const token = await createToken({ scope: 'admin' }, TEST_SECRET, {
        expiresIn: -1,
      });
      await expect(verifyToken(token, TEST_SECRET)).rejects.toThrow();
    });
  });
});
