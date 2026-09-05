import { env } from '../src/config/env.js';
import { closeDatabase, getDatabase } from '../src/db/client.js';

const phoneNumber = process.argv[2];
if (!phoneNumber || !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
  throw new Error('Usage: tsx scripts/approve-test-number.ts +<approved-test-number>');
}
if (!env.allowedTestPhoneNumbers.has(phoneNumber)) {
  throw new Error('Add the number to ALLOWED_TEST_PHONE_NUMBERS before approving it in demo data');
}

try {
  const result = await getDatabase().execute({
    sql: `UPDATE supplier_contacts
          SET phone_e164 = ?, call_consent_status = 'test_approved', updated_at = ?
          WHERE id = 'contact_demo_steel_primary' AND tenant_id = 'tenant_demo_ram'`,
    args: [phoneNumber, new Date().toISOString()],
  });
  if (result.rowsAffected !== 1)
    throw new Error('Demo contact not found; run migrations and seed first');
  process.stdout.write('Approved test destination saved to the standalone demo database.\n');
} finally {
  await closeDatabase();
}
