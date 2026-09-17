import { env } from '../src/config/env.js';
import { closeDatabase, getDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';

const phoneNumbers = [...new Set(process.argv.slice(2))];
if (phoneNumbers.length === 0 || phoneNumbers.some((phone) => !/^\+[1-9]\d{7,14}$/.test(phone))) {
  throw new Error(
    'Usage: bun scripts/approve-test-number.ts +<approved-test-number> [+<another-number>]',
  );
}
const notAllowlisted = phoneNumbers.filter((phone) => !env.allowedTestPhoneNumbers.has(phone));
if (notAllowlisted.length > 0) {
  throw new Error(
    `Add these numbers to ALLOWED_TEST_PHONE_NUMBERS before approving them: ${notAllowlisted.join(', ')}`,
  );
}

try {
  const database = getDatabase();
  await runMigrations(database);
  const followup = await database.execute({
    sql: `SELECT 1 AS found FROM followup_jobs
          WHERE id = 'followup_demo_001' AND tenant_id = 'tenant_demo_ram'`,
    args: [],
  });
  if (!followup.rows[0]) throw new Error('Demo follow-up not found; run migrations and seed first');

  const now = new Date().toISOString();
  await database.batch(
    phoneNumbers.map((phone) => ({
      sql: `INSERT INTO approved_test_destinations(
              tenant_id, followup_job_id, phone_e164, consent_status, created_at, updated_at
            ) VALUES ('tenant_demo_ram', 'followup_demo_001', ?, 'test_approved', ?, ?)
            ON CONFLICT(tenant_id, followup_job_id, phone_e164) DO UPDATE SET
              consent_status = 'test_approved', updated_at = excluded.updated_at`,
      args: [phone, now, now],
    })),
    'write',
  );
  process.stdout.write(
    `Approved ${phoneNumbers.length} test destination(s): ${phoneNumbers.join(', ')}\n`,
  );
} finally {
  await closeDatabase();
}
