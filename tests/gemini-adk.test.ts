import { once } from 'node:events';
import { createEvent } from '@google/adk';
import { LiveServerMessage } from '@google/genai';
import Fastify from 'fastify';
import twilio from 'twilio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  BoundedLiveQueue,
  normalizeLiveToolCall,
  type startAdkLive,
} from '../src/experiments/gemini/adk.js';
import { bridgeAdk } from '../src/experiments/gemini/bridge.js';
import { installMediaGateway, type PendingStream } from '../src/experiments/gemini/gateway.js';
import { mediaToken, validateMediaSignature } from '../src/experiments/gemini/security.js';
import { createAdkTools } from '../src/experiments/gemini/tools.js';

vi.mock('../src/config/env.js', () => ({ requireConfig: () => 'test-tool-secret-only' }));
const origin = 'https://example.invalid';
const auth = 'dummy-twilio-auth-token-only';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function gateway(options: { active?: boolean; expired?: boolean; bound?: boolean } = {}) {
  const app = Fastify({ logger: false });
  const sockets = new WebSocketServer({ noServer: true });
  const entry: PendingStream = {
    context: { tenantId: 't', followupId: 'f', callSessionId: 'c' },
    callSid: options.bound === false ? null : 'CAtest',
    connected: options.active ?? false,
    expires: Date.now() + (options.expired ? -1000 : 60000),
  };
  let callbacks: Parameters<typeof startAdkLive>[0] | undefined;
  const audio = vi.fn();
  const close = vi.fn();
  const rejected = vi.fn();
  const closed = vi.fn();
  const start = vi.fn((o: Parameters<typeof startAdkLive>[0]) => {
    callbacks = o;
    o.onReady();
    return { sendAudio: audio, close, done: Promise.resolve() };
  });
  installMediaGateway(app.server, sockets, {
    baseUrl: origin,
    authToken: auth,
    pending: new Map([['test-token', entry]]),
    reject: rejected,
    accept: (phone) =>
      bridgeAdk(phone, {
        app,
        apiKey: 'dummy',
        callSid: 'CAtest',
        context: entry.context,
        onClosed: closed,
        startLive: start,
      }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  cleanups.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await app.close();
  });
  const connect = (
    path = '/gemini/media/test-token',
    signingUrl = `${origin}${path}`,
    signature?: string,
  ) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
      headers: {
        'x-twilio-signature': signature ?? twilio.getExpectedTwilioSignature(auth, signingUrl, {}),
      },
    });
    socket.on('error', () => {});
    return socket;
  };
  const begin = (phone: WebSocket, sid = 'CAtest') =>
    phone.send(
      JSON.stringify({
        event: 'start',
        start: {
          callSid: sid,
          streamSid: 'MZtest',
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        },
      }),
    );
  return {
    app,
    entry,
    rejected,
    audio,
    close,
    closed,
    start,
    connect,
    begin,
    callbacks: () => callbacks,
  };
}

describe('ADK Twilio gateway', () => {
  it('accepts exact, slash and WSS signatures but not forged origins', () => {
    const path = '/gemini/media/test-token';
    for (const uri of [`${origin}${path}`, `${origin}${path}/`, `wss://example.invalid${path}/`]) {
      expect(
        validateMediaSignature(
          auth,
          origin,
          path,
          twilio.getExpectedTwilioSignature(auth, uri, {}),
        ),
      ).toBe(true);
    }
    expect(
      validateMediaSignature(
        auth,
        origin,
        path,
        twilio.getExpectedTwilioSignature(auth, `https://attacker.invalid${path}`, {}),
      ),
    ).toBe(false);
    expect(mediaToken(`${path}/`)).toBe('test-token');
    expect(mediaToken(`${path}?token=other`)).toBeUndefined();
  });
  it('upgrades a slash-variant handshake and streams both directions, clearing interruptions', async () => {
    const g = await gateway();
    const phone = g.connect('/gemini/media/test-token/', `${origin}/gemini/media/test-token/`);
    await once(phone, 'open');
    g.begin(phone);
    await vi.waitFor(() => expect(g.start).toHaveBeenCalledOnce());
    phone.send(
      JSON.stringify({
        event: 'media',
        streamSid: 'MZtest',
        media: { track: 'inbound', payload: Buffer.alloc(160, 255).toString('base64') },
      }),
    );
    await vi.waitFor(() => expect(g.audio).toHaveBeenCalledOnce());
    expect(g.audio.mock.calls[0]?.[0].length).toBe(640);
    const message = once(phone, 'message');
    g.callbacks()?.onEvent(
      createEvent({
        author: 'pratap',
        content: {
          role: 'model',
          parts: [
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=24000',
                data: Buffer.alloc(960).toString('base64'),
              },
            },
          ],
        },
      }),
    );
    const output = JSON.parse((await message)[0].toString());
    expect(output.event).toBe('media');
    expect(Buffer.from(output.media.payload, 'base64').length).toBe(160);
    const interruption = once(phone, 'message');
    g.callbacks()?.onEvent(createEvent({ interrupted: true }));
    expect(JSON.parse((await interruption)[0].toString())).toEqual({
      event: 'clear',
      streamSid: 'MZtest',
    });
    phone.send(JSON.stringify({ event: 'stop' }));
    await once(phone, 'close');
    expect(g.close).toHaveBeenCalledOnce();
    expect(g.closed).toHaveBeenCalledOnce();
  });
  it.each([
    [{}, 'wrong', 'INVALID_SIGNATURE'],
    [{ expired: true }, undefined, 'EXPIRED_STREAM'],
    [{ active: true }, undefined, 'DUPLICATE_STREAM'],
    [{ bound: false }, undefined, 'UNBOUND_CALL'],
  ] as const)('rejects unsafe handshake %j', async (options, signature, reason) => {
    const g = await gateway(options);
    const phone = g.connect(undefined, undefined, signature);
    const [, response] = await once(phone, 'unexpected-response');
    expect(response.statusCode).toBe(403);
    phone.terminate();
    expect(g.rejected).toHaveBeenCalledWith(reason);
    expect(g.start).not.toHaveBeenCalled();
  });
  it('rejects a stream bound to a different Twilio CallSid before starting ADK', async () => {
    const g = await gateway();
    const phone = g.connect();
    await once(phone, 'open');
    g.begin(phone, 'CAwrong');
    await once(phone, 'close');
    expect(g.start).not.toHaveBeenCalled();
  });
  it('bounds ADK input and frees capacity as queued audio is consumed', async () => {
    const queue = new BoundedLiveQueue();
    const blob = { mimeType: 'audio/pcm;rate=16000', data: Buffer.alloc(32000).toString('base64') };
    queue.sendRealtime(blob);
    queue.sendRealtime(blob);
    expect(() => queue.sendRealtime(blob)).toThrow('ADK_INPUT_BACKPRESSURE');
    await queue.get();
    expect(() => queue.sendRealtime(blob)).not.toThrow();
    queue.close();
  });
  it('registers seven ADK tools without exposing trusted identity', async () => {
    const app = Fastify({ logger: false });
    const tools = createAdkTools(app, { tenantId: 't', followupId: 'f', callSessionId: 'c' });
    expect(tools).toHaveLength(7);
    const pricing = tools.find((tool) => tool.name === 'pricing_outcome')?._getDeclaration();
    expect(pricing?.parameters?.properties?.explicitConfirmation?.enum).toBeUndefined();
    expect(pricing?.parameters?.properties?.explicitConfirmation?.type).toBe('BOOLEAN');
    for (const tool of tools)
      expect(JSON.stringify(tool._getDeclaration())).not.toMatch(
        /tenantId|followupId|callSessionId/,
      );
    await app.close();
  });
  it('dispatches Live tool calls immediately without modifying provider packets', () => {
    const message = new LiveServerMessage();
    message.toolCall = {
      functionCalls: [
        { id: 'tool-1', name: 'business_answer', args: { questionCategory: 'payment_terms' } },
      ],
    };
    const normalized = normalizeLiveToolCall(message);
    expect(normalized.toolCall).toBeUndefined();
    expect(normalized.serverContent?.modelTurn?.parts?.[0]?.functionCall).toEqual(
      message.toolCall.functionCalls?.[0],
    );
    expect(message.serverContent).toBeUndefined();
    expect(message.toolCall).toBeDefined();
    const audio = new LiveServerMessage();
    expect(normalizeLiveToolCall(audio)).toBe(audio);
  });
});
