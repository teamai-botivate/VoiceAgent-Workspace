import { randomUUID } from 'node:crypto';
import formBody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController } from 'fastify';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { env, requireConfig } from '../../config/env.js';
import { loggerOptions } from '../../config/logger.js';
import { closeDatabase, enableForeignKeys, getDatabase } from '../../db/client.js';
import { FollowupRepository } from '../../domains/followups/repository.js';
import { startCallSchema } from '../../domains/followups/schemas.js';
import { agentToolRoutes } from '../../routes/agent-tools.js';
import { requireInternalAuth } from '../../routes/auth.js';
import { AppError } from '../../shared/errors.js';
import { bridgeAdk } from './bridge.js';
import { installMediaGateway, type PendingStream } from './gateway.js';
import { liveModel } from './live.js';

// This executable is deliberately independent of server.ts: no scheduler,
// ElevenLabs registration, or changes to its port/public URL.
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.GEMINI_PORT ?? 3200);
const baseUrl = z.string().url().parse(process.env.GEMINI_PUBLIC_BASE_URL).replace(/\/+$/, '');
if (!baseUrl.startsWith('https://')) throw new Error('GEMINI_PUBLIC_BASE_URL must use HTTPS');
const apiKey = z.string().min(1).parse(process.env.GEMINI_API_KEY);
requireConfig('AGENT_TOOL_SECRET');
requireConfig('INTERNAL_API_TOKEN');
requireConfig('TWILIO_AUTH_TOKEN');
const app = Fastify({
  logger: loggerOptions,
  bodyLimit: 256 * 1024,
  logController: new LogController({ disableRequestLogging: true }),
});
app.setErrorHandler((error, _request, reply) => {
  const code =
    error instanceof AppError ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
  return reply
    .code(code)
    .send({ success: false, error: error instanceof AppError ? error.code : 'REQUEST_FAILED' });
});
await app.register(formBody);
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
const db = getDatabase();
await enableForeignKeys(db);
const repository = new FollowupRepository(db);
await agentToolRoutes(app, repository);

type Pending = PendingStream;
const pending = new Map<string, Pending>();
const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const client = twilio(requireConfig('TWILIO_ACCOUNT_SID'), requireConfig('TWILIO_AUTH_TOKEN'), {
  timeout: 15000,
  autoRetry: false,
});
let closing = false;
function validateSignature(
  path: string,
  signature: unknown,
  params: Record<string, string>,
): boolean {
  return (
    typeof signature === 'string' &&
    twilio.validateRequest(
      requireConfig('TWILIO_AUTH_TOKEN'),
      signature,
      `${baseUrl}${path}`,
      params,
    )
  );
}
app.get('/health/live', async () => ({
  status: 'ok',
  experiment: 'gemini-live',
  engine: 'google-adk',
  model: liveModel,
}));
app.post('/internal/gemini/calls', { preHandler: requireInternalAuth }, async (request, reply) => {
  if (closing || pending.size >= 4) throw new AppError('Experiment busy', 503, 'EXPERIMENT_BUSY');
  const input = startCallSchema.parse(request.body);
  if (!env.allowedTestPhoneNumbers.has(input.toNumber))
    throw new AppError('Not allowlisted', 403, 'PHONE_NOT_ALLOWLISTED');
  await repository.assertApprovedDestination(input.tenantId, input.followupId, input.toNumber);
  const session = await repository.createCallSession(input);
  if (session.existing)
    return {
      success: true,
      data: await repository.getCallSession(input.tenantId, session.id),
      idempotent: true,
    };
  const token = randomUUID();
  const entry: Pending = {
    context: { tenantId: input.tenantId, followupId: input.followupId, callSessionId: session.id },
    callSid: null,
    connected: false,
    expires: Date.now() + 120000,
  };
  pending.set(token, entry);
  try {
    await repository.markCallInitiating(input.tenantId, session.id);
    const call = await client.calls.create({
      to: input.toNumber,
      from: requireConfig('TWILIO_PHONE_NUMBER'),
      url: `${baseUrl}/gemini/voice/${token}`,
      method: 'POST',
      timeout: 30,
      timeLimit: 300,
      statusCallback: `${baseUrl}/gemini/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });
    entry.callSid = call.sid;
    await repository.attachProviderCall({
      tenantId: input.tenantId,
      callSessionId: session.id,
      conversationId: null,
      callSid: call.sid,
    });
    return reply.code(202).send({
      success: true,
      data: { callSessionId: session.id, callSid: call.sid, provider: 'gemini-live' },
    });
  } catch {
    pending.delete(token);
    await repository.holdUncertainCall(
      input.tenantId,
      session.id,
      'Gemini experiment call initiation uncertain; do not redial automatically',
    );
    throw new AppError(
      'Call initiation uncertain; inspect Twilio before retrying',
      502,
      'INITIATION_UNCERTAIN',
    );
  }
});
app.post<{ Params: { token: string } }>('/gemini/voice/:token', async (request, reply) => {
  const body = z.record(z.string(), z.string()).parse(request.body);
  if (!validateSignature(request.url, request.headers['x-twilio-signature'], body))
    throw new AppError('Invalid signature', 403, 'INVALID_SIGNATURE');
  const entry = pending.get(request.params.token);
  if (!entry || entry.expires < Date.now() || (entry.callSid && entry.callSid !== body.CallSid))
    throw new AppError('Unknown call', 403, 'UNKNOWN_CALL');
  if (!body.CallSid) throw new AppError('Missing SID', 400, 'INVALID_CALL');
  entry.callSid = body.CallSid;
  const response = new twilio.twiml.VoiceResponse();
  response.connect().stream({
    url: `${baseUrl.replace('https:', 'wss:')}/gemini/media/${request.params.token}`,
    statusCallback: `${baseUrl}/gemini/stream-status`,
    statusCallbackMethod: 'POST',
  });
  response.say('The test call has ended. Goodbye.');
  response.hangup();
  return reply.type('text/xml').send(response.toString());
});
app.post('/gemini/status', { config: { rateLimit: false } }, async (request) => {
  const body = z.record(z.string(), z.string()).parse(request.body);
  if (!validateSignature(request.url, request.headers['x-twilio-signature'], body))
    throw new AppError('Invalid signature', 403, 'INVALID_SIGNATURE');
  if (!body.CallSid || !body.CallStatus)
    throw new AppError('Invalid callback', 400, 'INVALID_CALLBACK');
  const status = (
    {
      queued: 'initiated',
      initiated: 'initiated',
      ringing: 'ringing',
      'in-progress': 'in_progress',
      completed: 'completed',
      failed: 'failed',
      busy: 'busy',
      'no-answer': 'no_answer',
      canceled: 'cancelled',
    } as Record<string, string>
  )[body.CallStatus];
  if (!status) throw new AppError('Unknown status', 400, 'INVALID_STATUS');
  await repository.recordProviderEvent({
    provider: 'twilio',
    providerEventId: `${body.CallSid}:${body.CallStatus}:${body.SequenceNumber ?? 'status'}`,
    eventType: 'call_status',
    callSid: body.CallSid,
    status,
    occurredAt: new Date().toISOString(),
    payload: { callSid: body.CallSid, callStatus: body.CallStatus, experiment: 'gemini-live' },
  });
  return { status: 'received' };
});

installMediaGateway(app.server, sockets, {
  baseUrl,
  authToken: requireConfig('TWILIO_AUTH_TOKEN'),
  pending,
  reject: (reason) => app.log.warn({ reason, experiment: 'gemini-adk' }, 'Media upgrade rejected'),
  accept: (phone, entry, token) =>
    bridgeAdk(phone, {
      app,
      apiKey,
      callSid: entry.callSid ?? '',
      context: entry.context,
      onClosed: () => pending.delete(token),
    }),
});

app.post('/gemini/stream-status', { config: { rateLimit: false } }, async (request) => {
  const body = z.record(z.string(), z.string()).parse(request.body);
  if (!validateSignature(request.url, request.headers['x-twilio-signature'], body))
    throw new AppError('Invalid signature', 403, 'INVALID_SIGNATURE');
  app.log.info(
    { streamEvent: body.StreamEvent, experiment: 'gemini-adk' },
    'Twilio stream lifecycle',
  );
  if (body.StreamEvent === 'stream-error')
    app.log.warn(
      { reason: 'TWILIO_STREAM_ERROR', experiment: 'gemini-adk' },
      'Twilio reported stream error; inspect Twilio Debugger',
    );
  return { status: 'received' };
});

const cleanup = setInterval(() => {
  for (const [token, entry] of pending)
    if (!entry.connected && entry.expires < Date.now()) pending.delete(token);
}, 30000);
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(cleanup);
  for (const socket of sockets.clients) socket.close();
  sockets.close();
  await app.close();
  await closeDatabase();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
try {
  await app.listen({ host: env.HOST, port });
} catch {
  app.log.error({ port }, 'Gemini experiment failed to listen; check port availability');
  await shutdown();
  process.exitCode = 1;
}
