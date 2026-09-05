import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import twilio from 'twilio';
import { z } from 'zod';
import { requireConfig } from '../config/env.js';
import type { FollowupRepository } from '../domains/followups/repository.js';
import { verifyElevenLabsSignature } from '../integrations/elevenlabs/signature.js';
import { AppError } from '../shared/errors.js';

const elevenLabsWebhookSchema = z.object({
  type: z.string(),
  event_timestamp: z.union([z.number(), z.string()]),
  data: z
    .object({
      agent_id: z.string().optional(),
      conversation_id: z.string(),
      status: z.string().optional(),
      failure_reason: z.string().optional(),
      metadata: z
        .object({
          type: z.string().optional(),
          body: z.record(z.string(), z.unknown()).optional(),
          call_duration_secs: z.number().nonnegative().optional(),
          termination_reason: z.string().optional(),
          phone_call: z.object({ call_sid: z.string().optional() }).passthrough().optional(),
        })
        .passthrough()
        .optional(),
      conversation_initiation_client_data: z
        .object({
          dynamic_variables: z.record(z.string(), z.unknown()).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
});

const statusMap: Record<string, string> = {
  queued: 'initiated',
  initiated: 'initiated',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'cancelled',
};

const twilioFormSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

function normalizeTwilioForm(value: unknown): Record<string, string> {
  const body = twilioFormSchema.parse(value);
  return Object.fromEntries(
    Object.entries(body).map(([key, item]) => [key, Array.isArray(item) ? (item[0] ?? '') : item]),
  );
}

function validateTwilioSignature(input: {
  requestUrl: string;
  signature: string | string[] | undefined;
  body: Record<string, string>;
  log?: Pick<FastifyBaseLogger, 'warn'>;
}): void {
  const publicBaseUrl = requireConfig('PUBLIC_BASE_URL').replace(/\/+$/, '');
  const publicUrl = `${publicBaseUrl}${input.requestUrl}`;
  const signature = typeof input.signature === 'string' ? input.signature : '';
  const valid = twilio.validateRequest(
    requireConfig('TWILIO_AUTH_TOKEN'),
    signature,
    publicUrl,
    input.body,
  );
  if (!valid) {
    const parsed = new URL(publicUrl);
    const diagnosticUrls: Record<string, string> = {
      http: publicUrl.replace(/^https:/, 'http:'),
      explicitHttpsPort: `${parsed.protocol}//${parsed.hostname}:443${parsed.pathname}${parsed.search}`,
      withoutQuery: `${publicBaseUrl}${parsed.pathname}`,
    };
    const matchingVariants = signature
      ? Object.entries(diagnosticUrls)
          .filter(([, url]) =>
            twilio.validateRequest(requireConfig('TWILIO_AUTH_TOKEN'), signature, url, input.body),
          )
          .map(([name]) => name)
      : [];
    input.log?.warn(
      { signaturePresent: Boolean(signature), matchingVariants },
      'Twilio signature validation failed',
    );
    throw new AppError('Invalid Twilio signature', 401, 'INVALID_SIGNATURE');
  }
}

function eventTime(value: number | string): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) return new Date(numeric * 1_000).toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new AppError('Invalid event timestamp', 400, 'INVALID_WEBHOOK');
  return parsed.toISOString();
}

export async function providerWebhookRoutes(
  app: FastifyInstance,
  repository: FollowupRepository,
): Promise<void> {
  app.post<{
    Querystring: { tenantId: string; followupId: string; callSessionId: string };
  }>('/twilio/outbound', { config: { rateLimit: false } }, async (request, reply) => {
    const query = z
      .object({
        tenantId: z.string().min(1).max(100),
        followupId: z.string().min(1).max(150),
        callSessionId: z.string().uuid(),
      })
      .parse(request.query);
    const body = normalizeTwilioForm(request.body);
    validateTwilioSignature({
      requestUrl: request.url,
      signature: request.headers['x-twilio-signature'],
      body,
      log: request.log,
    });

    const fromNumber = z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .parse(body.From);
    const toNumber = z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .parse(body.To);
    await repository.assertCallContext(query.tenantId, query.followupId, query.callSessionId);
    await repository.assertApprovedDestination(query.tenantId, query.followupId, toNumber);
    const session = await repository.getCallSession(query.tenantId, query.callSessionId);
    if (
      fromNumber !== requireConfig('TWILIO_PHONE_NUMBER') ||
      (session.callSid && session.callSid !== body.CallSid)
    ) {
      throw new AppError('Provider call does not match this session', 403, 'INVALID_CALL_CONTEXT');
    }
    const context = await repository.getContext(query.tenantId, query.followupId);

    const response = await fetch('https://api.elevenlabs.io/v1/convai/twilio/register-call', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': requireConfig('ELEVENLABS_API_KEY'),
      },
      body: JSON.stringify({
        agent_id: requireConfig('ELEVENLABS_AGENT_ID'),
        from_number: fromNumber,
        to_number: toNumber,
        direction: 'outbound',
        conversation_initiation_client_data: {
          dynamic_variables: {
            tenant_id: query.tenantId,
            followup_id: query.followupId,
            call_session_id: query.callSessionId,
            tenant_name: context.tenantName,
            supplier_name: context.supplierName,
            contact_name: context.contactName,
            requirement_number: context.requirementNumber,
            preferred_language: context.preferredLanguage,
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new AppError(
        `ElevenLabs rejected call registration with HTTP ${response.status}`,
        502,
        'ELEVENLABS_CALL_REJECTED',
      );
    }
    return reply.type('application/xml').send(await response.text());
  });

  app.post(
    '/webhooks/elevenlabs/post-call',
    { config: { rawBody: true, rateLimit: false } },
    async (request, reply) => {
      const rawBody = request.rawBody?.toString('utf8');
      if (!rawBody) throw new AppError('Raw webhook body is unavailable', 400, 'INVALID_WEBHOOK');
      const signature = request.headers['elevenlabs-signature'];
      const valid = verifyElevenLabsSignature({
        rawBody,
        signatureHeader: typeof signature === 'string' ? signature : undefined,
        secret: requireConfig('ELEVENLABS_WEBHOOK_SECRET'),
      });
      if (!valid) throw new AppError('Invalid webhook signature', 401, 'INVALID_SIGNATURE');

      const event = elevenLabsWebhookSchema.parse(request.body);
      if (!['call_initiation_failure', 'post_call_transcription'].includes(event.type)) {
        return reply.code(200).send({ status: 'ignored_event_type' });
      }
      const isFailure = event.type === 'call_initiation_failure' || event.data.status === 'failed';
      const eventStatus = isFailure
        ? (statusMap[event.data.failure_reason ?? 'failed'] ?? 'failed')
        : event.type.startsWith('post_call_')
          ? 'completed'
          : (statusMap[event.data.status ?? ''] ?? 'in_progress');
      const dynamicVariables = event.data.conversation_initiation_client_data?.dynamic_variables;
      const metadataBody = event.data.metadata?.body;
      const callSessionId =
        typeof dynamicVariables?.call_session_id === 'string'
          ? dynamicVariables.call_session_id
          : undefined;
      const metadataCallSid =
        event.data.metadata?.phone_call?.call_sid ??
        metadataBody?.CallSid ??
        metadataBody?.call_sid;
      const recorded = await repository.recordProviderEvent({
        provider: 'elevenlabs',
        providerEventId: `${event.type}:${event.data.conversation_id}:${event.event_timestamp}`,
        eventType: event.type,
        conversationId: event.data.conversation_id,
        callSid: typeof metadataCallSid === 'string' ? metadataCallSid : undefined,
        callSessionId,
        status: eventStatus,
        failureMessage:
          event.data.failure_reason ??
          (isFailure ? event.data.metadata?.termination_reason : undefined),
        durationSeconds: event.data.metadata?.call_duration_secs,
        occurredAt: eventTime(event.event_timestamp),
        payload: {
          type: event.type,
          agentId: event.data.agent_id,
          conversationId: event.data.conversation_id,
          status: event.data.status,
          failureReason: event.data.failure_reason,
        },
      });
      if (!recorded) {
        request.log.warn(
          { eventType: event.type, conversationId: event.data.conversation_id },
          'Stored unmatched ElevenLabs event for reconciliation',
        );
      }
      return reply.code(200).send({ status: 'received' });
    },
  );

  app.post('/webhooks/twilio/status', { config: { rateLimit: false } }, async (request, reply) => {
    const normalizedBody = normalizeTwilioForm(request.body);
    validateTwilioSignature({
      requestUrl: request.url,
      signature: request.headers['x-twilio-signature'],
      body: normalizedBody,
      log: request.log,
    });

    const callSid = normalizedBody.CallSid;
    const callStatus = normalizedBody.CallStatus;
    if (!callSid || !callStatus)
      throw new AppError('Missing Twilio call status', 400, 'INVALID_WEBHOOK');
    await repository.recordProviderEvent({
      provider: 'twilio',
      providerEventId: `${callSid}:${callStatus}:${normalizedBody.SequenceNumber ?? normalizedBody.Timestamp ?? 'status'}`,
      eventType: 'call_status',
      callSid,
      status: statusMap[callStatus] ?? 'in_progress',
      durationSeconds:
        normalizedBody.CallDuration && /^\d+$/.test(normalizedBody.CallDuration)
          ? Number(normalizedBody.CallDuration)
          : undefined,
      occurredAt: new Date().toISOString(),
      payload: { callSid, callStatus },
    });
    return reply.code(200).send({ status: 'received' });
  });
}
