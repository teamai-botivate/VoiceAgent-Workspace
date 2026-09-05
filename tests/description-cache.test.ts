import { describe, expect, it } from 'vitest';
import { CallDescriptionCache } from '../src/domains/followups/description-cache.js';
import type { FollowupContext } from '../src/domains/followups/repository.js';

const context: FollowupContext = {
  tenantId: 'a',
  tenantName: 'A',
  followupId: 'f',
  supplierId: 's',
  supplierName: 'S',
  contactName: 'C',
  preferredLanguage: 'hi',
  requirementId: 'r',
  requirementNumber: 'PR-001',
  requirementTitle: 'Test',
  requirementVersion: 1,
  currency: 'INR',
  items: [
    {
      id: 'i',
      lineNumber: 1,
      name: 'Bolt',
      specification: 'M12 x 50 mm',
      quantity: '20',
      unit: 'KG',
    },
  ],
};

describe('per-call description cache', () => {
  it('reuses only descriptive data and returns defensive copies', () => {
    const cache = new CallDescriptionCache();
    const first = cache.get(context, 'call');
    expect(first.items[0]?.spokenSpecification).toBe('M twelve by fifty millimetres');
    expect(first.items[0]).not.toHaveProperty('quantity');
    expect(first).not.toHaveProperty('requirementVersion');
    if (first.items[0]) first.items[0].name = 'tampered';
    expect(cache.get(context, 'call').items[0]?.name).toBe('Bolt');
    expect(cache.size).toBe(1);
  });
  it('refreshes changed descriptions even without a version bump', () => {
    const cache = new CallDescriptionCache();
    cache.get(context, 'call');
    expect(
      cache.get(
        { ...context, items: context.items.map((item) => ({ ...item, specification: 'M16' })) },
        'call',
      ).items[0]?.spokenSpecification,
    ).toBe('M sixteen');
  });
  it('isolates tenants and calls and bounds memory', () => {
    const cache = new CallDescriptionCache(2);
    cache.get(context, 'call1');
    cache.get({ ...context, tenantId: 'b' }, 'call1');
    expect(cache.size).toBe(2);
    cache.get(context, 'call2');
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
  it('expires entries using a fixed lifetime rather than sliding forever', () => {
    let now = 0;
    const cache = new CallDescriptionCache(5, 100, () => now);
    cache.get(context, 'call1');
    now = 90;
    cache.get(context, 'call1');
    now = 101;
    cache.get(context, 'call2');
    expect(cache.size).toBe(1);
  });
});
