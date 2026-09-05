import { randomUUID } from 'node:crypto';
import { env, requireConfig } from '../src/config/env.js';

const toNumber = process.argv[2];
if (!toNumber) {
  throw new Error('Usage: bun run call:test -- +<approved-test-number>');
}
if (!env.allowedTestPhoneNumbers.has(toNumber)) {
  throw new Error('Destination is not present in ALLOWED_TEST_PHONE_NUMBERS');
}

const response = await fetch(`http://127.0.0.1:${env.PORT}/internal/calls`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${requireConfig('INTERNAL_API_TOKEN')}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    tenantId: 'tenant_demo_ram',
    followupId: 'followup_demo_001',
    toNumber,
    idempotencyKey: `manual-${randomUUID()}`,
  }),
});

const payload = (await response.json()) as unknown;
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
if (!response.ok) process.exitCode = 1;
