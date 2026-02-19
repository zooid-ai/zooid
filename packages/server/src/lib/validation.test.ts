import { describe, it, expect } from 'vitest';
import { isValidChannelId } from './validation';

describe('Channel ID validation', () => {
  it('accepts valid slugs', () => {
    expect(isValidChannelId('polymarket-signals')).toBe(true);
    expect(isValidChannelId('abc')).toBe(true);
    expect(isValidChannelId('my-channel-123')).toBe(true);
  });

  it('rejects too short (< 3 chars)', () => {
    expect(isValidChannelId('ab')).toBe(false);
    expect(isValidChannelId('a')).toBe(false);
    expect(isValidChannelId('')).toBe(false);
  });

  it('rejects too long (> 64 chars)', () => {
    expect(isValidChannelId('a'.repeat(65))).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(isValidChannelId('MyChannel')).toBe(false);
  });

  it('rejects special characters', () => {
    expect(isValidChannelId('my_channel')).toBe(false);
    expect(isValidChannelId('my.channel')).toBe(false);
    expect(isValidChannelId('my channel')).toBe(false);
  });

  it('rejects leading/trailing hyphens', () => {
    expect(isValidChannelId('-my-channel')).toBe(false);
    expect(isValidChannelId('my-channel-')).toBe(false);
  });
});
