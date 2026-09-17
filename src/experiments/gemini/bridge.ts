import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { z } from 'zod';
import { startAdkLive } from './adk.js';
import { Pcm24ToUlaw8, ulawToPcm16 } from './audio.js';
import { createAdkTools } from './tools.js';

export function bridgeAdk(
  phone: WebSocket,
  options: {
    app: FastifyInstance;
    apiKey: string;
    callSid: string;
    context: { tenantId: string; followupId: string; callSessionId: string };
    onClosed: (reason: string) => void;
    startLive?: typeof startAdkLive;
    initialText?: string;
    onError?: (error: unknown) => void;
  },
): void {
  let streamSid = '';
  let live: ReturnType<typeof startAdkLive> | undefined;
  let ended = false;
  let firstAudio = false;
  let finalized = false;
  let endMarkSent = false;
  let inputBytes = 0;
  const input: Buffer[] = [];
  const converter = new Pcm24ToUlaw8();
  const startedAt = Date.now();
  const finish = (reason: string) => {
    if (ended) return;
    ended = true;
    clearTimeout(deadline);
    clearTimeout(setupDeadline);
    options.app.log.info({ reason, experiment: 'gemini-adk' }, 'Audio bridge closed');
    options.onClosed(reason);
    input.length = 0;
    live?.close();
    phone.close();
  };
  const deadline = setTimeout(() => finish('MAX_CALL_DURATION'), 300000);
  const setupDeadline = setTimeout(() => finish('ADK_SETUP_TIMEOUT'), 20000);
  phone.on('error', () => finish('TWILIO_SOCKET_ERROR'));
  phone.on('close', () => finish('TWILIO_SOCKET_CLOSED'));
  phone.on('message', (data) => {
    try {
      if (ended) return;
      const message = JSON.parse(data.toString());
      if (message.event === 'mark' && message.mark?.name === 'outcome-complete' && endMarkSent)
        return finish('OUTCOME_COMPLETE');
      if (message.event === 'stop') return finish('TWILIO_STOP');
      if (message.event === 'start') {
        if (
          live ||
          message.start?.callSid !== options.callSid ||
          message.start?.mediaFormat?.encoding !== 'audio/x-mulaw' ||
          message.start?.mediaFormat?.sampleRate !== 8000 ||
          message.start?.mediaFormat?.channels !== 1
        )
          return finish('INVALID_START');
        streamSid = z.string().min(1).parse(message.start.streamSid);
        options.app.log.info({ experiment: 'gemini-adk' }, 'Twilio stream accepted');
        live = (options.startLive ?? startAdkLive)({
          ...(options.onError ? { onError: options.onError } : {}),
          ...(options.initialText ? { initialText: options.initialText } : {}),
          apiKey: options.apiKey,
          sessionId: options.context.callSessionId,
          tools: createAdkTools(
            options.app,
            options.context,
            () => !ended,
            () => {
              finalized = true;
            },
          ),
          onReady: () => {
            if (ended) return;
            clearTimeout(setupDeadline);
            options.app.log.info(
              { setupMs: Date.now() - startedAt, experiment: 'gemini-adk' },
              'ADK Live connected',
            );
          },
          onEnd: finish,
          onEvent: (event) => {
            if (ended || phone.readyState !== WebSocket.OPEN) return;
            if (event.interrupted) {
              converter.reset();
              phone.send(JSON.stringify({ event: 'clear', streamSid }));
            }
            for (const part of event.content?.parts ?? []) {
              if (!part.inlineData?.data) continue;
              if (!/^audio\/pcm(;rate=24000)?$/.test(part.inlineData.mimeType ?? ''))
                return finish('UNSUPPORTED_OUTPUT_AUDIO');
              if (phone.bufferedAmount > 256000) return finish('TWILIO_OUTPUT_BACKPRESSURE');
              const audio = converter.convert(Buffer.from(part.inlineData.data, 'base64'));
              for (let offset = 0; offset < audio.length; offset += 160)
                phone.send(
                  JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: audio.subarray(offset, offset + 160).toString('base64') },
                  }),
                );
              if (!firstAudio) {
                firstAudio = true;
                options.app.log.info(
                  { setupToAudioMs: Date.now() - startedAt, experiment: 'gemini-adk' },
                  'First ADK audio',
                );
              }
            }
            if (event.turnComplete && finalized && !endMarkSent) {
              endMarkSent = true;
              phone.send(
                JSON.stringify({ event: 'mark', streamSid, mark: { name: 'outcome-complete' } }),
              );
            }
          },
        });
        for (const pcm of input) live.sendAudio(pcm);
        input.length = 0;
        inputBytes = 0;
      }
      if (message.event === 'media') {
        if (
          !streamSid ||
          message.streamSid !== streamSid ||
          message.media?.track !== 'inbound' ||
          typeof message.media?.payload !== 'string' ||
          message.media.payload.length > 4096
        )
          return finish('INVALID_MEDIA');
        const pcm = ulawToPcm16(Buffer.from(message.media.payload, 'base64'));
        if (!live) {
          inputBytes += pcm.length;
          if (inputBytes > 64000) return finish('PRESTART_BACKPRESSURE');
          input.push(pcm);
        } else live.sendAudio(pcm);
      }
    } catch {
      finish('INVALID_PROTOCOL_OR_BACKPRESSURE');
    }
  });
}
