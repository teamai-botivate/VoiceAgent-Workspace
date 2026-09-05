import { describe, expect, it } from 'vitest';
import { recordPricingSchema, startCallSchema } from '../src/domains/followups/schemas.js';

describe('external input schemas', () => {
  it('requires an E.164 test destination', () => {
    expect(
      startCallSchema.safeParse({
        tenantId: 'tenant_demo_ram',
        followupId: 'followup_demo_001',
        toNumber: '9876543210',
        idempotencyKey: 'test-key-001',
      }).success,
    ).toBe(false);
  });

  it('requires explicit true confirmation and KG pricing', () => {
    const base = {
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      callSessionId: 'call_demo_001',
      confirmationToken: '3c5ac5e1-2f5f-4df4-990b-c5342cd33ff1',
      requirementId: 'requirement_demo_fasteners',
      requirementVersion: 1,
      items: [
        {
          requirementItemId: 'item_demo_1',
          initialRateMinor: 30_000,
          finalRateMinor: 29_000,
          unit: 'KG',
        },
      ],
    };
    expect(recordPricingSchema.safeParse({ ...base, explicitConfirmation: false }).success).toBe(
      false,
    );
    expect(
      recordPricingSchema.safeParse({
        ...base,
        explicitConfirmation: true,
        items: [{ ...base.items[0], unit: 'PCS' }],
      }).success,
    ).toBe(false);
    expect(recordPricingSchema.safeParse({ ...base, explicitConfirmation: true }).success).toBe(
      true,
    );
  });
});
