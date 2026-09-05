import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';

describe('environment normalization', () => {
  it('normalizes empty optional credentials instead of failing unrelated commands', () => {
    expect(env.ELEVENLABS_API_KEY === undefined || env.ELEVENLABS_API_KEY.length > 0).toBe(true);
  });

  it('exposes a normalized Turso authentication field', () => {
    expect(env.TURSO_AUTH_TOKEN === undefined || env.TURSO_AUTH_TOKEN.length > 0).toBe(true);
  });
});
