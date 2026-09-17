import type { Client } from '@libsql/client';

type Migration = {
  version: number;
  name: string;
  statements: string[];
};

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_standalone_voice_agent_schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS suppliers (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        supplier_code TEXT NOT NULL,
        legal_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        preferred_language TEXT NOT NULL DEFAULT 'hi',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, supplier_code)
      )`,
      `CREATE TABLE IF NOT EXISTS supplier_contacts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        supplier_id TEXT NOT NULL REFERENCES suppliers(id),
        name TEXT NOT NULL,
        phone_e164 TEXT NOT NULL,
        email TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        call_consent_status TEXT NOT NULL CHECK (
          call_consent_status IN ('test_approved', 'unknown', 'opted_out')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, supplier_id, phone_e164)
      )`,
      `CREATE TABLE IF NOT EXISTS purchase_requirements (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        requirement_number TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'quoted', 'closed', 'cancelled')),
        currency TEXT NOT NULL DEFAULT 'INR',
        version INTEGER NOT NULL DEFAULT 1,
        required_by_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, requirement_number)
      )`,
      `CREATE TABLE IF NOT EXISTS purchase_requirement_items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        purchase_requirement_id TEXT NOT NULL REFERENCES purchase_requirements(id),
        line_number INTEGER NOT NULL,
        item_name TEXT NOT NULL,
        specification TEXT NOT NULL,
        quantity_decimal TEXT NOT NULL,
        unit TEXT NOT NULL CHECK (unit = 'KG'),
        target_rate_minor INTEGER,
        maximum_rate_minor INTEGER,
        UNIQUE (tenant_id, purchase_requirement_id, line_number)
      )`,
      `CREATE TABLE IF NOT EXISTS followup_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        supplier_id TEXT NOT NULL REFERENCES suppliers(id),
        supplier_contact_id TEXT NOT NULL REFERENCES supplier_contacts(id),
        purchase_requirement_id TEXT NOT NULL REFERENCES purchase_requirements(id),
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'leased', 'calling', 'callback_requested', 'quotation_pending',
          'completed', 'cannot_supply', 'not_interested', 'failed', 'cancelled')
        ),
        scheduled_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_outcome TEXT,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS supplier_quotations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        supplier_id TEXT NOT NULL REFERENCES suppliers(id),
        purchase_requirement_id TEXT NOT NULL REFERENCES purchase_requirements(id),
        followup_job_id TEXT NOT NULL REFERENCES followup_jobs(id),
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'rejected')),
        discount_basis_points INTEGER,
        confirmed_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, followup_job_id)
      )`,
      `CREATE TABLE IF NOT EXISTS supplier_quotation_items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        quotation_id TEXT NOT NULL REFERENCES supplier_quotations(id),
        requirement_item_id TEXT NOT NULL REFERENCES purchase_requirement_items(id),
        initial_rate_minor INTEGER NOT NULL CHECK (initial_rate_minor > 0),
        revised_rate_minor INTEGER,
        final_rate_minor INTEGER NOT NULL CHECK (final_rate_minor > 0),
        unit TEXT NOT NULL CHECK (unit = 'KG'),
        vendor_confirmed INTEGER NOT NULL CHECK (vendor_confirmed IN (0, 1)),
        UNIQUE (tenant_id, quotation_id, requirement_item_id)
      )`,
      `CREATE TABLE IF NOT EXISTS call_sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        followup_job_id TEXT NOT NULL REFERENCES followup_jobs(id),
        provider TEXT NOT NULL DEFAULT 'elevenlabs_twilio',
        twilio_call_sid TEXT UNIQUE,
        elevenlabs_conversation_id TEXT UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (
          status IN ('created', 'initiating', 'initiated', 'ringing', 'in_progress',
          'completed', 'busy', 'no_answer', 'failed', 'cancelled')
        ),
        started_at TEXT,
        answered_at TEXT,
        ended_at TEXT,
        duration_seconds INTEGER,
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS call_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        call_session_id TEXT NOT NULL REFERENCES call_sessions(id),
        provider TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_redacted_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE (provider, provider_event_id)
      )`,
      `CREATE TABLE IF NOT EXISTS call_outcomes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        call_session_id TEXT NOT NULL UNIQUE REFERENCES call_sessions(id),
        disposition TEXT NOT NULL,
        summary TEXT NOT NULL,
        callback_at TEXT,
        supplier_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (supplier_confirmed IN (0, 1)),
        quotation_id TEXT REFERENCES supplier_quotations(id),
        recorded_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS agent_knowledge (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        effective_from TEXT,
        effective_to TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        UNIQUE (tenant_id, category, key)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_followup_due ON followup_jobs(status, next_attempt_at, scheduled_at)',
      'CREATE INDEX IF NOT EXISTS idx_items_requirement ON purchase_requirement_items(tenant_id, purchase_requirement_id)',
      'CREATE INDEX IF NOT EXISTS idx_calls_followup ON call_sessions(tenant_id, followup_job_id)',
    ],
  },
  {
    version: 2,
    name: 'durable_call_events_and_conversation_state',
    statements: [
      'ALTER TABLE call_sessions ADD COLUMN transport_status TEXT',
      'ALTER TABLE call_sessions ADD COLUMN agent_status TEXT',
      'ALTER TABLE call_sessions ADD COLUMN context_loaded_at TEXT',
      'ALTER TABLE call_sessions ADD COLUMN pricing_preview_hash TEXT',
      'ALTER TABLE call_sessions ADD COLUMN pricing_confirmation_token TEXT',
      'ALTER TABLE call_sessions ADD COLUMN pricing_preview_at TEXT',
      `CREATE TABLE provider_event_inbox (
        provider TEXT NOT NULL, event_id TEXT NOT NULL, event_json TEXT NOT NULL,
        received_at TEXT NOT NULL, processed_at TEXT,
        PRIMARY KEY (provider, event_id)
      )`,
      'CREATE INDEX idx_inbox_pending ON provider_event_inbox(processed_at, received_at)',
    ],
  },
  {
    version: 3,
    name: 'multiple_approved_test_destinations',
    statements: [
      `CREATE TABLE approved_test_destinations (
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        followup_job_id TEXT NOT NULL REFERENCES followup_jobs(id),
        phone_e164 TEXT NOT NULL,
        consent_status TEXT NOT NULL CHECK (consent_status IN ('test_approved', 'opted_out')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, followup_job_id, phone_e164)
      )`,
      `INSERT INTO approved_test_destinations(
        tenant_id, followup_job_id, phone_e164, consent_status, created_at, updated_at
      )
      SELECT f.tenant_id, f.id, c.phone_e164, 'test_approved', f.created_at, f.updated_at
      FROM followup_jobs f
      JOIN supplier_contacts c ON c.id = f.supplier_contact_id AND c.tenant_id = f.tenant_id
      WHERE c.call_consent_status = 'test_approved'`,
      'ALTER TABLE call_sessions ADD COLUMN destination_phone_e164 TEXT',
      'CREATE INDEX idx_test_destinations_phone ON approved_test_destinations(phone_e164, consent_status)',
    ],
  },
];

export async function runMigrations(db: Client): Promise<void> {
  await db.execute('PRAGMA foreign_keys = ON');
  await db.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = await db.execute('SELECT version FROM schema_migrations');
  const appliedVersions = new Set(applied.rows.map((row) => Number(row.version)));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    await db.batch(
      [
        ...migration.statements,
        {
          sql: 'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
          args: [migration.version, migration.name, new Date().toISOString()],
        },
      ],
      'write',
    );
  }
}
