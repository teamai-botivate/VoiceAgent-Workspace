import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeUlaw,
  encodeUlaw,
  Pcm24ToUlaw8,
  ulawToPcm16,
} from '../src/experiments/gemini/audio.js';
import { setupMessage } from '../src/experiments/gemini/live.js';
import { executeTool, toolDeclarations } from '../src/experiments/gemini/tools.js';

vi.mock('../src/config/env.js', () => ({ requireConfig: () => 'gemini-test-tool-secret-only' }));

describe('isolated Gemini experiment', () => {
  it('decodes standard μ-law silence and extrema', () => {
    expect(decodeUlaw(255)).toBe(0);
    expect(decodeUlaw(127)).toBe(0);
    expect(decodeUlaw(0)).toBe(-32124);
    expect(decodeUlaw(128)).toBe(32124);
  });
  it('round-trips every nonzero μ-law code', () => {
    for (let i = 0; i < 256; i++) if (i !== 127) expect(encodeUlaw(decodeUlaw(i))).toBe(i);
  });
  it('upsamples telephone frames to 16 kHz PCM of the same duration', () => {
    const pcm = ulawToPcm16(Buffer.alloc(160, 255));
    expect(pcm.length).toBe(640);
    expect(pcm.equals(Buffer.alloc(640))).toBe(true);
  });
  it('preserves chunk boundaries and clears partial data after interruption', () => {
    const input = Buffer.alloc(960);
    for (let i = 0; i < 480; i++) input.writeInt16LE(1200, i * 2);
    const whole = new Pcm24ToUlaw8().convert(input);
    const converter = new Pcm24ToUlaw8();
    const split = Buffer.concat([
      converter.convert(input.subarray(0, 7)),
      converter.convert(input.subarray(7)),
    ]);
    expect(split.equals(whole)).toBe(true);
    expect(whole.length).toBe(160);
    converter.convert(Buffer.from([1, 2]));
    converter.reset();
    expect(converter.convert(Buffer.alloc(6))[0]).toBe(255);
  });
  it('does not expose tenant or session identity in model tool schemas', () => {
    expect(toolDeclarations).toHaveLength(7);
    for (const tool of toolDeclarations) {
      const json = JSON.stringify(tool.parametersJsonSchema);
      expect(json).not.toContain('tenantId');
      expect(json).not.toContain('callSessionId');
      expect(json).not.toContain('followupId');
    }
    expect(JSON.stringify(setupMessage())).not.toContain('api_key');
  });
  it('rejects unknown and prototype tool names without database access', async () => {
    const app = { inject: vi.fn() } as unknown as FastifyInstance;
    for (const name of ['arbitrary_sql', '__proto__', 'constructor']) {
      expect(
        await executeTool(app, name, {}, { tenantId: 't', followupId: 'f', callSessionId: 'c' }),
      ).toEqual({ success: false, error: 'UNKNOWN_TOOL' });
    }
    expect(app.inject).not.toHaveBeenCalled();
  });
  it('blocks unconfirmed pricing writes', async () => {
    const app = { inject: vi.fn() } as unknown as FastifyInstance;
    const result = await executeTool(
      app,
      'pricing_outcome',
      { explicitConfirmation: false },
      { tenantId: 't', followupId: 'f', callSessionId: 'c' },
    );
    expect(result).toMatchObject({ success: false, error: 'INVALID_ARGUMENTS' });
    expect(app.inject).not.toHaveBeenCalled();
  });
  it('overrides model-supplied call identity before invoking existing tools', async () => {
    const inject = vi.fn().mockResolvedValue({ json: () => ({ success: true }) });
    const app = { inject } as unknown as FastifyInstance;
    await executeTool(
      app,
      'business_answer',
      {
        questionCategory: 'gst_policy',
        tenantId: 'attacker',
        followupId: 'other',
        callSessionId: 'other',
      },
      { tenantId: 'trusted', followupId: 'approved', callSessionId: 'bound' },
    );
    expect(inject).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          questionCategory: 'gst_policy',
          tenantId: 'trusted',
          followupId: 'approved',
          callSessionId: 'bound',
        },
      }),
    );
  });
});
