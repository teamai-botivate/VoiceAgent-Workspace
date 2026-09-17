import { randomUUID } from 'node:crypto';
import { env, requireConfig } from '../src/config/env.js';

const toNumber = process.argv[2];
if (!toNumber || !env.allowedTestPhoneNumbers.has(toNumber))
  throw new Error('Usage: bun run gemini:call -- +<allowlisted-approved-number>');
const response = await fetch(
  `http://127.0.0.1:${process.env.GEMINI_PORT ?? 3200}/internal/gemini/calls`,
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireConfig('INTERNAL_API_TOKEN')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      toNumber,
      idempotencyKey: `gemini-${randomUUID()}`,
    }),
    signal: AbortSignal.timeout(20000),
  },
);
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
