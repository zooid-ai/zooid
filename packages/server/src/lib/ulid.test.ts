import { describe, it, expect } from 'vitest';
import { generateUlid } from './ulid';

describe('ULID generation', () => {
  it('generates a 26-character string', () => {
    const id = generateUlid();
    expect(id).toHaveLength(26);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateUlid()));
    expect(ids.size).toBe(100);
  });

  it('generates time-ordered IDs (lexicographic sort = chronological)', () => {
    const id1 = generateUlid();
    const id2 = generateUlid();
    expect(id2 > id1).toBe(true);
  });

  it('contains only valid Crockford Base32 characters', () => {
    const id = generateUlid();
    expect(id).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });
});
