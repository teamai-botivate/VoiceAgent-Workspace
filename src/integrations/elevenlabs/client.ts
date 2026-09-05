import twilio from 'twilio';
import { z } from 'zod';
import { env, requireConfig } from '../../config/env.js';
import type { FollowupRepository } from '../../domains/followups/repository.js';
import { AppError, errorMessage } from '../../shared/errors.js';

const outboundResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  conversation_id: z.string().nullable(),
  callSid: z.string().nullable(),
});

export class ElevenLabsCallService {
  constructor(private readonly repository: FollowupRepository) {}

  async startCall(input: {
    tenantId: string;
    followupId: string;
    toNumber: string;
    idempotencyKey: string;
  }): Promise<{
    callSessionId: string;
    status: string;
    conversationId: string | null;
    callSid: string | null;
    idempotent: boolean;
  }> {
    if (!env.allowedTestPhoneNumbers.has(input.toNumber)) {
      throw new AppError(
        'Destination is not in ALLOWED_TEST_PHONE_NUMBERS',
        403,
        'PHONE_NOT_ALLOWLISTED',
      );
    }

    await this.repository.assertApprovedDestination(
      input.tenantId,
      input.followupId,
      input.toNumber,
    );
    const session = await this.repository.createCallSession(input);
    if (session.existing) {
      const existing = await this.repository.getCallSession(input.tenantId, session.id);
      return {
        callSessionId: existing.id,
        status: existing.status,
        conversationId: existing.conversationId,
        callSid: existing.callSid,
        idempotent: true,
      };
    }

    try {
      const context = await this.repository.getContext(input.tenantId, input.followupId);
      await this.repository.markCallInitiating(input.tenantId, session.id);
      if (!env.ELEVENLABS_PHONE_NUMBER_ID) {
        const publicBaseUrl = requireConfig('PUBLIC_BASE_URL').replace(/\/+$/, '');
        const query = new URLSearchParams({
          tenantId: input.tenantId,
          followupId: input.followupId,
          callSessionId: session.id,
        });
        const callParameters: Parameters<ReturnType<typeof twilio>['calls']['create']>[0] = {
          from: requireConfig('TWILIO_PHONE_NUMBER'),
          to: input.toNumber,
          url: `${publicBaseUrl}/twilio/outbound?${query.toString()}`,
        };
        Object.assign(callParameters, {
          method: 'POST',
          statusCallback: `${publicBaseUrl}/webhooks/twilio/status`,
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        });
        const call = await twilio(
          requireConfig('TWILIO_ACCOUNT_SID'),
          requireConfig('TWILIO_AUTH_TOKEN'),
          { timeout: 15_000, autoRetry: false },
        ).calls.create(callParameters);
        await this.repository.attachProviderCall({
          tenantId: input.tenantId,
          callSessionId: session.id,
          conversationId: null,
          callSid: call.sid,
        });
        return {
          callSessionId: session.id,
          status: 'initiated',
          conversationId: null,
          callSid: call.sid,
          idempotent: false,
        };
      }

      const response = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'xi-api-key': requireConfig('ELEVENLABS_API_KEY'),
        },
        body: JSON.stringify({
          agent_id: requireConfig('ELEVENLABS_AGENT_ID'),
          agent_phone_number_id: requireConfig('ELEVENLABS_PHONE_NUMBER_ID'),
          to_number: input.toNumber,
          call_recording_enabled: env.ELEVENLABS_RECORD_CALLS,
          conversation_initiation_client_data: {
            dynamic_variables: {
              tenant_id: input.tenantId,
              followup_id: input.followupId,
              call_session_id: session.id,
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
          `ElevenLabs rejected call initiation with HTTP ${response.status}`,
          502,
          'ELEVENLABS_CALL_REJECTED',
        );
      }
      const parsed = outboundResponseSchema.parse(await response.json());
      if (!parsed.success) {
        throw new AppError(parsed.message, 502, 'ELEVENLABS_CALL_REJECTED');
      }
      await this.repository.attachProviderCall({
        tenantId: input.tenantId,
        callSessionId: session.id,
        conversationId: parsed.conversation_id,
        callSid: parsed.callSid,
      });
      return {
        callSessionId: session.id,
        status: 'initiated',
        conversationId: parsed.conversation_id,
        callSid: parsed.callSid,
        idempotent: false,
      };
    } catch (error) {
      // A timeout, server error, or DB attachment failure does not prove that
      // the provider did not dial. Hold the job for reconciliation, not retry.
      await this.repository.holdUncertainCall(input.tenantId, session.id, errorMessage(error));
      throw error;
    }
  }
}
