import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { startAdkLive } from '../src/experiments/gemini/adk.js';
import { liveModel } from '../src/experiments/gemini/live.js';

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('Set GEMINI_API_KEY in .env');
let audio = false;
const started = Date.now();
const timer = setTimeout(() => {
  console.error('ADK audio check timed out');
  process.exitCode = 1;
  session.close();
}, 25000);
const session = startAdkLive({
  apiKey: key,
  sessionId: randomUUID(),
  tools: [],
  instruction:
    'This is a synthetic connectivity test. Say only hello, briefly, in Hindi and English.',
  initialText: 'Please say hello now.',
  onReady: () => console.log(JSON.stringify({ adkSessionReady: true, model: liveModel })),
  onEvent: (event) => {
    const part = event.content?.parts?.find((p) => p.inlineData?.data);
    if (part?.inlineData && !audio) {
      audio = true;
      clearTimeout(timer);
      console.log(
        JSON.stringify({
          audioReceived: true,
          mimeType: part.inlineData.mimeType,
          firstAudioMs: Date.now() - started,
        }),
      );
      session.close();
    }
  },
  onEnd: (reason) => {
    if (!audio) {
      console.error(JSON.stringify({ adkSessionFailed: reason }));
      process.exitCode = 1;
    }
  },
});
await session.done;
clearTimeout(timer);
