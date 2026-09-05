import type { FastifyInstance } from 'fastify';
import type { FollowupRepository } from '../domains/followups/repository.js';
import {
  businessAnswerSchema,
  callContextSchema,
  finalizeCallSchema,
  previewPricingSchema,
  recordPricingSchema,
  scheduleCallbackSchema,
  supplierResponseSchema,
} from '../domains/followups/schemas.js';
import { spokenRequirement, spokenSpecification } from '../domains/followups/speech.js';
import { requireAgentToolAuth } from './auth.js';

export async function agentToolRoutes(
  app: FastifyInstance,
  repository: FollowupRepository,
): Promise<void> {
  const options = { preHandler: requireAgentToolAuth };
  app.post('/agent-tools/pricing-preview', options, async (request) => {
    const result = await repository.previewPricing(previewPricingSchema.parse(request.body));
    return {
      success: true,
      data: {
        ...result,
        instruction:
          'Read every line back, ask for explicit confirmation, then submit unchanged pricing with this confirmationToken. A correction requires a new preview.',
      },
    };
  });

  app.post('/agent-tools/followup-context', options, async (request) => {
    const input = callContextSchema.parse(request.body);
    await repository.assertCallContext(input.tenantId, input.followupId, input.callSessionId);
    const context = await repository.getContext(input.tenantId, input.followupId);
    await repository.markContextLoaded(input.tenantId, input.callSessionId);
    return {
      success: true,
      data: {
        ...context,
        spokenRequirementNumber: spokenRequirement(context.requirementNumber),
        items: context.items.map((item) => ({
          ...item,
          spokenSpecification: spokenSpecification(item.specification),
        })),
      },
    };
  });

  app.post('/agent-tools/business-answer', options, async (request) => {
    const input = businessAnswerSchema.parse(request.body);
    await repository.assertCallContext(input.tenantId, input.followupId, input.callSessionId);
    const answer = await repository.getBusinessAnswer(input.tenantId, input.questionCategory);
    return { success: true, data: { category: input.questionCategory, answer } };
  });

  app.post('/agent-tools/pricing-outcome', options, async (request) => {
    const input = recordPricingSchema.parse(request.body);
    const result = await repository.recordPricing(input);
    return {
      success: true,
      data: {
        ...result,
        message: 'Confirmed item-wise KG pricing was stored successfully.',
      },
    };
  });

  app.post('/agent-tools/schedule-callback', options, async (request) => {
    const input = scheduleCallbackSchema.parse(request.body);
    await repository.scheduleCallback(input);
    return { success: true, data: { message: 'Callback was scheduled successfully.' } };
  });

  app.post('/agent-tools/supplier-response', options, async (request) => {
    const input = supplierResponseSchema.parse(request.body);
    await repository.recordSupplierResponse(input);
    return { success: true, data: { message: 'Supplier response was recorded successfully.' } };
  });

  app.post('/agent-tools/finalize-call', options, async (request) => {
    const input = finalizeCallSchema.parse(request.body);
    await repository.finalizeCall(input);
    return { success: true, data: { message: 'Call disposition was finalized successfully.' } };
  });
}
