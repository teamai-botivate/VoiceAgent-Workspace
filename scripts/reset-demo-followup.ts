import { closeDatabase, getDatabase } from '../src/db/client.js';

const tenantId = 'tenant_demo_ram';
const followupId = 'followup_demo_001';

// Non-terminal call states. A trial-mode call that Twilio ends without a reachable
// status callback stays stuck in one of these, so a retry cycle must close them out.
const openStatuses = ['created', 'initiating', 'initiated', 'ringing', 'in_progress'];

try {
  const database = getDatabase();
  const now = new Date().toISOString();
  const placeholders = openStatuses.map(() => '?').join(', ');

  const stale = await database.execute({
    sql: `SELECT id, status FROM call_sessions
          WHERE tenant_id = ? AND followup_job_id = ? AND status IN (${placeholders})`,
    args: [tenantId, followupId, ...openStatuses],
  });

  await database.batch(
    [
      {
        sql: `UPDATE call_sessions
              SET status = 'cancelled', failure_code = 'RESET_FOR_RETEST',
                  failure_message = 'Closed by demo reset; provider never reported completion.',
                  ended_at = COALESCE(ended_at, ?), updated_at = ?
              WHERE tenant_id = ? AND followup_job_id = ? AND status IN (${placeholders})`,
        args: [now, now, tenantId, followupId, ...openStatuses],
      },
      {
        sql: `UPDATE followup_jobs
              SET status = 'pending', attempt_count = 0, lease_owner = NULL,
                  lease_expires_at = NULL, next_attempt_at = NULL, last_outcome = NULL,
                  updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
        args: [now, tenantId, followupId],
      },
    ],
    'write',
  );

  const job = await database.execute({
    sql: 'SELECT status, attempt_count, max_attempts FROM followup_jobs WHERE tenant_id = ? AND id = ?',
    args: [tenantId, followupId],
  });
  const row = job.rows[0];
  if (!row) throw new Error('Demo follow-up not found; run migrations and seed first');

  for (const session of stale.rows) {
    process.stdout.write(`Cancelled stale call session ${session.id} (was ${session.status}).\n`);
  }
  process.stdout.write(
    `Demo follow-up reset: status=${row.status} attempts=${row.attempt_count}/${row.max_attempts}\n`,
  );
} finally {
  await closeDatabase();
}
