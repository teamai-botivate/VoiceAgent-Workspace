import { z } from 'zod';

export const tenantIdSchema = z.string().min(1).max(100);
export const entityIdSchema = z.string().min(1).max(150);

export const callContextSchema = z.object({
  tenantId: tenantIdSchema,
  followupId: entityIdSchema,
  callSessionId: entityIdSchema,
});

export const businessAnswerSchema = callContextSchema.extend({
  questionCategory: z.enum([
    'delivery_location',
    'payment_terms',
    'gst_policy',
    'quotation_validity',
    'commercial_unit',
  ]),
});

export const pricingItemSchema = z.object({
  requirementItemId: entityIdSchema,
  initialRateMinor: z.number().int().positive().max(100_000_000),
  revisedRateMinor: z.number().int().positive().max(100_000_000).nullable().optional(),
  finalRateMinor: z.number().int().positive().max(100_000_000),
  unit: z.literal('KG'),
});

export const recordPricingSchema = callContextSchema.extend({
  requirementId: entityIdSchema,
  requirementVersion: z.number().int().positive(),
  explicitConfirmation: z.literal(true),
  confirmationToken: z.string().uuid(),
  discountBasisPoints: z.number().int().min(0).max(10_000).nullable().optional(),
  items: z.array(pricingItemSchema).min(1).max(100),
});

export const previewPricingSchema = recordPricingSchema.omit({
  explicitConfirmation: true,
  confirmationToken: true,
});

export const scheduleCallbackSchema = callContextSchema.extend({
  callbackAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
});

export const supplierResponseSchema = callContextSchema.extend({
  disposition: z.enum([
    'quotation_will_be_sent',
    'cannot_supply',
    'not_interested',
    'opted_out',
    'wrong_contact',
    'requirement_not_received',
    'needs_more_information',
  ]),
  summary: z.string().trim().min(1).max(1_000),
});

export const finalizeCallSchema = callContextSchema.extend({
  disposition: z.enum([
    'pricing_confirmed',
    'callback_requested',
    'quotation_pending',
    'cannot_supply',
    'not_interested',
    'opted_out',
    'wrong_contact',
    'no_answer',
    'failed',
  ]),
  summary: z.string().trim().min(1).max(2_000),
});

export const startCallSchema = z.object({
  tenantId: tenantIdSchema,
  followupId: entityIdSchema,
  toNumber: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Must be an E.164 phone number'),
  idempotencyKey: z.string().min(8).max(200),
});
