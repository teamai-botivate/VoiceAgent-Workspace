import {
  type BaseLlmConnection,
  type BaseTool,
  type Event,
  Gemini,
  InMemoryRunner,
  type LiveRequest,
  LiveRequestQueue,
  LlmAgent,
  type LlmRequest,
  setLogger,
} from '@google/adk';
import { LiveServerMessage, Modality } from '@google/genai';
import { liveModel, setupMessage } from './live.js';

// ADK debug logs can contain raw audio/tool content. Our gateway logs only safe
// lifecycle codes and timings, not provider error messages or caller transcripts.
setLogger(null);

// ADK 2.1.0 buffers Gemini 2.5 tool calls until turnComplete, while Live
// waits for their results. Dispatch immediately through ADK's normal tool flow.
export function normalizeLiveToolCall(message: LiveServerMessage): LiveServerMessage {
  if (!message.toolCall?.functionCalls?.length) return message;
  const normalized = Object.assign(new LiveServerMessage(), message);
  delete normalized.toolCall;
  normalized.serverContent = {
    ...message.serverContent,
    modelTurn: {
      role: 'model',
      parts: message.toolCall.functionCalls.map((functionCall) => ({ functionCall })),
    },
  };
  return normalized;
}

export class BoundedLiveQueue extends LiveRequestQueue {
  private bytes = 0;
  override send(req: LiveRequest): void {
    const size = req.blob?.data ? Buffer.byteLength(req.blob.data, 'base64') : 0;
    if (this.bytes + size > 64000) throw new Error('ADK_INPUT_BACKPRESSURE');
    super.send(req);
    this.bytes += size;
  }
  override async get(signal?: AbortSignal): Promise<LiveRequest> {
    const req = await super.get(signal);
    this.bytes -= req.blob?.data ? Buffer.byteLength(req.blob.data, 'base64') : 0;
    return req;
  }
}

class ReadyGemini extends Gemini {
  constructor(
    key: string,
    private readonly connected: () => void,
    private readonly active: () => boolean,
    diagnostic?: (error: unknown) => void,
  ) {
    super({ model: liveModel, apiKey: key, vertexai: false });
    const connect = this.liveApiClient.live.connect.bind(this.liveApiClient.live);
    this.liveApiClient.live.connect = (params) =>
      connect({
        ...params,
        callbacks: {
          ...params.callbacks,
          onmessage: (message) => {
            params.callbacks.onmessage(normalizeLiveToolCall(message));
          },
          onclose: (event) => {
            if (this.active() && event.code !== 1000)
              diagnostic?.(new Error(`Live closed ${event.code}: ${event.reason}`));
            params.callbacks.onclose?.(event);
          },
        },
      });
  }
  override async connect(request: LlmRequest): Promise<BaseLlmConnection> {
    const connection = await super.connect(request);
    if (!this.active()) {
      await connection.close();
      throw new Error('CALL_ENDED');
    }
    this.connected();
    return connection;
  }
}

export function startAdkLive(options: {
  apiKey: string;
  sessionId: string;
  tools: BaseTool[];
  onReady: () => void;
  onEvent: (event: Event) => void;
  onEnd: (reason: string) => void;
  onError?: (error: unknown) => void;
  initialText?: string;
  instruction?: string;
}): { sendAudio: (pcm: Buffer) => void; close: () => void; done: Promise<void> } {
  const queue = new BoundedLiveQueue();
  const abort = new AbortController();
  let active = true;
  const appName = 'pratap_gemini_adk';
  const userId = options.sessionId;
  const setup = setupMessage() as { setup: { systemInstruction: { parts: { text: string }[] } } };
  const agent = new LlmAgent({
    name: 'pratap',
    model: new ReadyGemini(options.apiKey, options.onReady, () => active, options.onError),
    instruction: options.instruction ?? setup.setup.systemInstruction.parts[0]?.text ?? '',
    tools: options.tools,
  });
  const runner = new InMemoryRunner({ appName, agent });
  const close = () => {
    if (!active) return;
    active = false;
    queue.close();
    abort.abort();
  };
  const done = (async () => {
    try {
      await runner.sessionService.createSession({ appName, userId, sessionId: options.sessionId });
      if (!active) return;
      queue.sendContent({
        role: 'user',
        parts: [
          {
            text:
              options.initialText ??
              'Begin this approved dummy follow-up call. Load the database context and greet me.',
          },
        ],
      });
      for await (const event of runner.runLive({
        userId,
        sessionId: options.sessionId,
        liveRequestQueue: queue,
        abortSignal: abort.signal,
        runConfig: {
          responseModalities: [Modality.AUDIO],
          maxLlmCalls: 100,
          saveInputBlobsAsArtifacts: false,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: { silenceDurationMs: 650, prefixPaddingMs: 100 },
          },
        },
      })) {
        if (!active) break;
        if (event.errorCode || event.goAway) {
          options.onEnd('ADK_PROVIDER_ENDED');
          break;
        }
        options.onEvent(event);
      }
      if (active) options.onEnd('ADK_STREAM_CLOSED');
    } catch (error) {
      options.onError?.(error);
      if (active) options.onEnd('ADK_SESSION_FAILED');
    } finally {
      close();
      await runner.sessionService.deleteSession({ appName, userId, sessionId: options.sessionId });
    }
  })();
  return {
    close,
    done,
    sendAudio: (pcm) => {
      if (!active) throw new Error('CALL_ENDED');
      queue.sendRealtime({ mimeType: 'audio/pcm;rate=16000', data: pcm.toString('base64') });
    },
  };
}
