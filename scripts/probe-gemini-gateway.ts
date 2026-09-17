import { once } from 'node:events';
import Fastify, { LogController } from 'fastify';
import twilio from 'twilio';
import WebSocket, { WebSocketServer } from 'ws';
import { requireConfig } from '../src/config/env.js';
import { bridgeAdk } from '../src/experiments/gemini/bridge.js';
import { installMediaGateway, type PendingStream } from '../src/experiments/gemini/gateway.js';
import { requireAgentToolAuth } from '../src/routes/auth.js';

// Diagnostic executable only. It never dials, creates call records, or commits
// business writes. Run on the tunnel's port while the real gateway is stopped.
const origin = process.env.GEMINI_PUBLIC_BASE_URL?.replace(/\/+$/, '');
if (!origin?.startsWith('https://')) throw new Error('Set GEMINI_PUBLIC_BASE_URL');
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('Set GEMINI_API_KEY');
const app = Fastify({
  logger: true,
  logController: new LogController({ disableRequestLogging: true }),
});
const reads: string[] = [];
// Explicit opt-in only: the owner confirmed this database contains dummy data
// and authorized sending read-only context and policy results to Gemini.
const useTurso = process.argv.includes('--turso-readonly');
const databaseModule = useTurso ? await import('../src/db/client.js') : undefined;
const repository = databaseModule
  ? new (await import('../src/domains/followups/repository.js')).FollowupRepository(
      databaseModule.getDatabase(),
    )
  : undefined;
app.post('/agent-tools/:name', { preHandler: requireAgentToolAuth }, async (request) => {
  const name = (request.params as { name: string }).name;
  if (name === 'followup-context') {
    const context = {
      tenantName: 'Synthetic Demo Company',
      supplierName: 'Synthetic Supplier',
      contactName: 'Test Caller',
      preferredLanguage: 'hi',
      requirementId: 'synthetic_requirement',
      requirementNumber: 'PR-SYNTHETIC-001',
      requirementVersion: 1,
      currency: 'INR',
      items: [
        {
          id: 'synthetic_item',
          lineNumber: 1,
          itemName: 'M8 hex bolt',
          specification: 'M8',
          quantityDecimal: '10',
          unit: 'KG',
        },
      ],
    };
    reads.push(name);
    return {
      success: true,
      data: repository
        ? await repository.getContext('tenant_demo_ram', 'followup_demo_001')
        : context,
    };
  }
  if (name === 'business-answer') {
    const category = (request.body as { questionCategory: string }).questionCategory;
    if (category !== 'payment_terms')
      return { success: false, error: 'PROBE_ONLY_SUPPORTS_PAYMENT_TERMS' };
    const answer =
      'Synthetic test policy: payment within 30 days. This is not an actual business policy.';
    reads.push(name);
    return {
      success: true,
      data: {
        category,
        answer: repository
          ? await repository.getBusinessAnswer('tenant_demo_ram', category)
          : answer,
      },
    };
  }
  return { success: false, error: 'PROBE_IS_READ_ONLY' };
});
const token = crypto.randomUUID();
const context = {
  tenantId: 'tenant_demo_ram',
  followupId: 'followup_demo_001',
  callSessionId: `probe-${token}`,
};
const entry: PendingStream = {
  context,
  callSid: 'CAprobe',
  connected: false,
  expires: Date.now() + 60000,
};
const sockets = new WebSocketServer({ noServer: true });
installMediaGateway(app.server, sockets, {
  baseUrl: origin,
  authToken: requireConfig('TWILIO_AUTH_TOKEN'),
  pending: new Map([[token, entry]]),
  reject: (reason) => console.error(JSON.stringify({ rejected: reason })),
  accept: (phone) =>
    bridgeAdk(phone, {
      app,
      apiKey: key,
      callSid: 'CAprobe',
      context,
      onClosed: (reason) => console.log(JSON.stringify({ bridgeEnded: reason })),
      onError: (error) => {
        const message = error instanceof Error ? error.message : 'Unknown ADK failure';
        console.error(
          JSON.stringify({
            adkDiagnostic: message
              .replaceAll(key, '[REDACTED]')
              .replace(/key=[^&\s"]+/g, 'key=[REDACTED]')
              .slice(0, 1200),
          }),
        );
      },
      initialText:
        'For this dummy diagnostic call, fetch followup_context and business_answer for payment_terms before speaking. Then state the payment terms briefly. Do not call write tools.',
    }),
});
await app.listen({ host: '127.0.0.1', port: Number(process.env.GEMINI_PORT ?? 3200) });
const path = `/gemini/media/${token}/`;
const phone = new WebSocket(`${origin.replace('https:', 'wss:')}${path}`, {
  headers: {
    'x-twilio-signature': twilio.getExpectedTwilioSignature(
      requireConfig('TWILIO_AUTH_TOKEN'),
      `${origin}${path}`,
      {},
    ),
  },
  handshakeTimeout: 15000,
});
phone.on('error', () => {});
const timer = setTimeout(() => {
  console.error('Gateway probe timed out');
  process.exitCode = 1;
  phone.terminate();
}, 45000);
let audio = false;
try {
  await once(phone, 'open');
  console.log(JSON.stringify({ cloudflareSignedUpgrade: true }));
  phone.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (!audio && message.event === 'media' && reads.includes('business-answer')) {
      audio = true;
      console.log(
        JSON.stringify({
          adkAudioThroughGateway: true,
          ulawBytes: Buffer.from(message.media.payload, 'base64').length,
          readSource: useTurso ? 'turso-dummy-data' : 'synthetic-fixture',
          verifiedToolReads: reads,
        }),
      );
      phone.close();
    }
  });
  phone.send(
    JSON.stringify({
      event: 'start',
      start: {
        callSid: 'CAprobe',
        streamSid: 'MZprobe',
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    }),
  );
  await once(phone, 'close');
  if (!audio) {
    console.error('Gateway closed before verified fixture-backed audio');
    process.exitCode = 1;
  }
} catch {
  console.error('Gateway probe failed (secrets omitted)');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  phone.terminate();
  for (const s of sockets.clients) s.terminate();
  sockets.close();
  await app.close();
  await databaseModule?.closeDatabase();
}
