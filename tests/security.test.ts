import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyElevenLabsSignature } from '../src/integrations/elevenlabs/signature.js';
import { bearerToken, safeSecretEqual } from '../src/security/secrets.js';

describe('secret comparison', () => {
  it('accepts only an exact secret', () => {
    expect(safeSecretEqual('correct-secret', 'correct-secret')).toBe(true);
    expect(safeSecretEqual('wrong-secret', 'correct-secret')).toBe(false);
    expect(safeSecretEqual(undefined, 'correct-secret')).toBe(false);
  });

  it('extracts bearer tokens strictly', () => {
    expect(bearerToken('Bearer token-value')).toBe('token-value');
    expect(bearerToken('Basic token-value')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe('ElevenLabs HMAC verification', () => {
  it('validates a current signed payload', () => {
    const rawBody = JSON.stringify({ type: 'post_call_transcription' });
    const timestamp = 1_725_430_400;
    const secret = 'webhook-secret-for-test';
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

    expect(
      verifyElevenLabsSignature({
        rawBody,
        signatureHeader: `t=${timestamp},v0=${signature}`,
        secret,
        nowSeconds: timestamp + 10,
      }),
    ).toBe(true);
  });

  it('rejects tampering and stale signatures', () => {
    const rawBody = '{}';
    const timestamp = 1_725_430_400;
    const secret = 'webhook-secret-for-test';
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

    expect(
      verifyElevenLabsSignature({
        rawBody: '{"tampered":true}',
        signatureHeader: `t=${timestamp},v0=${signature}`,
        secret,
        nowSeconds: timestamp,
      }),
    ).toBe(false);
    expect(
      verifyElevenLabsSignature({
        rawBody,
        signatureHeader: `t=${timestamp},v0=${signature}`,
        secret,
        nowSeconds: timestamp + 1_801,
      }),
    ).toBe(false);
  });
});
