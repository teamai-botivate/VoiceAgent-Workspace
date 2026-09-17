// Run inside the deployed gateway container; credentials come from its env.
const destination = process.argv[2];
if (!destination || !/^\+[1-9]\d{7,14}$/.test(destination))
  throw new Error('Usage: bun deploy/call-gemini.ts +<approved-number>');
const token = process.env.INTERNAL_API_TOKEN;
if (!token) throw new Error('INTERNAL_API_TOKEN is required');
const response = await fetch(
  `http://127.0.0.1:${process.env.GEMINI_PORT ?? 3200}/internal/gemini/calls`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      toNumber: destination,
      idempotencyKey: `gemini-${crypto.randomUUID()}`,
    }),
    signal: AbortSignal.timeout(20000),
  },
);
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;

export {};
