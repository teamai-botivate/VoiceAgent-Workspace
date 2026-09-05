import type { Client, InStatement } from '@libsql/client';

const now = '2026-09-04T00:00:00.000Z';
const tenantId = 'tenant_demo_ram';

// Timestamps for the historical query-testing fixtures. They sit in the past so that
// due-date, reporting, and lifecycle queries have a realistic spread. `callbackAt` is
// deliberately in the future so the seeded callback job never reads as due.
const lastMonth = '2026-08-05T11:30:00.000Z';
const lastWeek = '2026-08-28T09:15:00.000Z';
const callbackAt = '2026-09-11T05:30:00.000Z';

type SupplierRow = {
  id: string;
  code: string;
  legalName: string;
  status: 'active' | 'inactive';
};

type ContactRow = {
  id: string;
  supplierId: string;
  name: string;
  phone: string;
  email: string;
  isPrimary: 0 | 1;
  consent: 'test_approved' | 'unknown' | 'opted_out';
};

type RequirementRow = {
  id: string;
  number: string;
  title: string;
  status: 'draft' | 'open' | 'quoted' | 'closed' | 'cancelled';
  version: number;
  requiredBy: string;
};

type ItemRow = {
  id: string;
  requirementId: string;
  lineNumber: number;
  name: string;
  specification: string;
  quantity: string;
  targetRateMinor: number | null;
  maximumRateMinor: number | null;
};

type FollowupRow = {
  id: string;
  supplierId: string;
  contactId: string;
  requirementId: string;
  status: string;
  scheduledAt: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastOutcome: string | null;
};

type SessionRow = {
  id: string;
  followupId: string;
  idempotencyKey: string;
  callSid: string;
  conversationId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
};

type OutcomeRow = {
  id: string;
  sessionId: string;
  disposition: string;
  summary: string;
  callbackAt: string | null;
  supplierConfirmed: 0 | 1;
  quotationId: string | null;
};

// Every seeded contact other than the live demo contact uses a non-dialable placeholder
// number and withholds call consent, so the scheduler's consent gate can never select
// them. The live demo contact is inserted with a placeholder too; an approved test
// number is applied separately by scripts/approve-test-number.ts and is preserved here
// because every statement is INSERT OR IGNORE.
const suppliers: SupplierRow[] = [
  {
    id: 'supplier_demo_steel',
    code: 'SUP-DEMO-001',
    legalName: 'Demo Steel Components Private Limited',
    status: 'active',
  },
  {
    id: 'supplier_demo_precision',
    code: 'SUP-DEMO-002',
    legalName: 'Demo Precision Fasteners LLP',
    status: 'active',
  },
  {
    id: 'supplier_demo_metals',
    code: 'SUP-DEMO-003',
    legalName: 'Demo Metal Traders Private Limited',
    status: 'inactive',
  },
];

const contacts: ContactRow[] = [
  {
    id: 'contact_demo_steel_primary',
    supplierId: 'supplier_demo_steel',
    name: 'Demo Vendor Contact',
    phone: '+910000000000',
    email: 'vendor@example.invalid',
    isPrimary: 1,
    consent: 'unknown',
  },
  {
    id: 'contact_demo_precision_primary',
    supplierId: 'supplier_demo_precision',
    name: 'Demo Precision Contact',
    phone: '+910000000001',
    email: 'precision@example.invalid',
    isPrimary: 1,
    consent: 'unknown',
  },
  {
    id: 'contact_demo_precision_backup',
    supplierId: 'supplier_demo_precision',
    name: 'Demo Precision Backup Contact',
    phone: '+910000000002',
    email: 'precision.backup@example.invalid',
    isPrimary: 0,
    consent: 'unknown',
  },
  {
    id: 'contact_demo_metals_primary',
    supplierId: 'supplier_demo_metals',
    name: 'Demo Metals Contact',
    phone: '+910000000003',
    email: 'metals@example.invalid',
    isPrimary: 1,
    consent: 'opted_out',
  },
];

const requirements: RequirementRow[] = [
  {
    id: 'requirement_demo_fasteners',
    number: 'PR-DEMO-2026-001',
    title: 'Industrial fasteners requirement',
    status: 'open',
    version: 1,
    requiredBy: '2026-09-30',
  },
  {
    id: 'requirement_demo_sheets',
    number: 'PR-DEMO-2026-002',
    title: 'Mild steel sheet and angle requirement',
    status: 'open',
    version: 1,
    requiredBy: '2026-10-15',
  },
  {
    id: 'requirement_demo_bars',
    number: 'PR-DEMO-2026-003',
    title: 'Alloy round bar requirement',
    status: 'closed',
    version: 2,
    requiredBy: '2026-08-20',
  },
  {
    id: 'requirement_demo_pipes',
    number: 'PR-DEMO-2026-004',
    title: 'Galvanized pipe requirement',
    status: 'quoted',
    version: 1,
    requiredBy: '2026-09-20',
  },
];

// Rates are integer paise per KG. The live demo requirement keeps null negotiation
// bounds so the first controlled call cannot leak a target or ceiling price.
const items: ItemRow[] = [
  {
    id: 'item_demo_1',
    requirementId: 'requirement_demo_fasteners',
    lineNumber: 1,
    name: 'M12 Hex Bolt',
    specification: 'M12 x 50 mm',
    quantity: '20',
    targetRateMinor: null,
    maximumRateMinor: null,
  },
  {
    id: 'item_demo_2',
    requirementId: 'requirement_demo_fasteners',
    lineNumber: 2,
    name: 'M10 Hex Nut',
    specification: 'M10',
    quantity: '30',
    targetRateMinor: null,
    maximumRateMinor: null,
  },
  {
    id: 'item_demo_3',
    requirementId: 'requirement_demo_fasteners',
    lineNumber: 3,
    name: 'M8 Flat Washer',
    specification: 'M8',
    quantity: '25',
    targetRateMinor: null,
    maximumRateMinor: null,
  },
  {
    id: 'item_demo_4',
    requirementId: 'requirement_demo_fasteners',
    lineNumber: 4,
    name: 'M16 Threaded Rod',
    specification: 'M16 x 1 meter',
    quantity: '50',
    targetRateMinor: null,
    maximumRateMinor: null,
  },
  {
    id: 'item_demo_5',
    requirementId: 'requirement_demo_fasteners',
    lineNumber: 5,
    name: 'M12 Spring Washer',
    specification: 'M12',
    quantity: '35',
    targetRateMinor: null,
    maximumRateMinor: null,
  },
  {
    id: 'item_sheets_1',
    requirementId: 'requirement_demo_sheets',
    lineNumber: 1,
    name: 'MS Sheet 2 mm',
    specification: 'IS 2062 Grade A, 2 mm thickness',
    quantity: '100',
    targetRateMinor: 5_200,
    maximumRateMinor: 5_800,
  },
  {
    id: 'item_sheets_2',
    requirementId: 'requirement_demo_sheets',
    lineNumber: 2,
    name: 'MS Sheet 3 mm',
    specification: 'IS 2062 Grade A, 3 mm thickness',
    quantity: '150',
    targetRateMinor: 5_100,
    maximumRateMinor: 5_700,
  },
  {
    id: 'item_sheets_3',
    requirementId: 'requirement_demo_sheets',
    lineNumber: 3,
    name: 'MS Angle 40 x 40',
    specification: '40 x 40 x 5 mm',
    quantity: '200',
    targetRateMinor: 4_900,
    maximumRateMinor: 5_400,
  },
  {
    id: 'item_bars_1',
    requirementId: 'requirement_demo_bars',
    lineNumber: 1,
    name: 'EN8 Round Bar',
    specification: 'EN8, 50 mm diameter',
    quantity: '300',
    targetRateMinor: 6_600,
    maximumRateMinor: 7_200,
  },
  {
    id: 'item_bars_2',
    requirementId: 'requirement_demo_bars',
    lineNumber: 2,
    name: 'EN19 Round Bar',
    specification: 'EN19, 40 mm diameter',
    quantity: '150',
    targetRateMinor: 9_100,
    maximumRateMinor: 9_800,
  },
  {
    id: 'item_pipes_1',
    requirementId: 'requirement_demo_pipes',
    lineNumber: 1,
    name: 'GI Pipe 25 mm',
    specification: 'IS 1239 medium class, 25 mm nominal bore',
    quantity: '120',
    targetRateMinor: 7_400,
    maximumRateMinor: 8_000,
  },
  {
    id: 'item_pipes_2',
    requirementId: 'requirement_demo_pipes',
    lineNumber: 2,
    name: 'GI Pipe 40 mm',
    specification: 'IS 1239 medium class, 40 mm nominal bore',
    quantity: '80',
    targetRateMinor: 7_300,
    maximumRateMinor: 7_900,
  },
];

// One job per lifecycle state named in the plan's seed dataset: due, callback
// requested, quotation pending, completed, and cannot supply.
const followups: FollowupRow[] = [
  {
    id: 'followup_demo_001',
    supplierId: 'supplier_demo_steel',
    contactId: 'contact_demo_steel_primary',
    requirementId: 'requirement_demo_fasteners',
    status: 'pending',
    scheduledAt: now,
    attemptCount: 0,
    nextAttemptAt: now,
    lastOutcome: null,
  },
  {
    id: 'followup_demo_002',
    supplierId: 'supplier_demo_precision',
    contactId: 'contact_demo_precision_primary',
    requirementId: 'requirement_demo_sheets',
    status: 'callback_requested',
    scheduledAt: lastWeek,
    attemptCount: 1,
    nextAttemptAt: callbackAt,
    lastOutcome: 'Vendor asked to be called back next week',
  },
  {
    id: 'followup_demo_003',
    supplierId: 'supplier_demo_precision',
    contactId: 'contact_demo_precision_backup',
    requirementId: 'requirement_demo_sheets',
    status: 'quotation_pending',
    scheduledAt: lastWeek,
    attemptCount: 1,
    nextAttemptAt: null,
    lastOutcome: 'quotation_will_be_sent',
  },
  {
    id: 'followup_demo_004',
    supplierId: 'supplier_demo_metals',
    contactId: 'contact_demo_metals_primary',
    requirementId: 'requirement_demo_pipes',
    status: 'completed',
    scheduledAt: lastMonth,
    attemptCount: 1,
    nextAttemptAt: null,
    lastOutcome: 'pricing_confirmed',
  },
  {
    id: 'followup_demo_005',
    supplierId: 'supplier_demo_metals',
    contactId: 'contact_demo_metals_primary',
    requirementId: 'requirement_demo_bars',
    status: 'cannot_supply',
    scheduledAt: lastMonth,
    attemptCount: 2,
    nextAttemptAt: null,
    lastOutcome: 'cannot_supply',
  },
  {
    id: 'followup_demo_006',
    supplierId: 'supplier_demo_precision',
    contactId: 'contact_demo_precision_backup',
    requirementId: 'requirement_demo_bars',
    status: 'pending',
    scheduledAt: lastMonth,
    attemptCount: 0,
    nextAttemptAt: lastMonth,
    lastOutcome: null,
  },
];

// Historical provider identifiers are obviously synthetic so they can never collide
// with a real Twilio call SID or ElevenLabs conversation.
const sessions: SessionRow[] = [
  {
    id: '11111111-1111-4111-8111-000000000002',
    followupId: 'followup_demo_002',
    idempotencyKey: 'seed-history-followup-002',
    callSid: 'CAdemo00000000000000000000000002',
    conversationId: 'conv_demo_history_002',
    startedAt: lastWeek,
    endedAt: '2026-08-28T09:17:20.000Z',
    durationSeconds: 140,
  },
  {
    id: '11111111-1111-4111-8111-000000000003',
    followupId: 'followup_demo_003',
    idempotencyKey: 'seed-history-followup-003',
    callSid: 'CAdemo00000000000000000000000003',
    conversationId: 'conv_demo_history_003',
    startedAt: lastWeek,
    endedAt: '2026-08-28T09:21:05.000Z',
    durationSeconds: 185,
  },
  {
    id: '11111111-1111-4111-8111-000000000004',
    followupId: 'followup_demo_004',
    idempotencyKey: 'seed-history-followup-004',
    callSid: 'CAdemo00000000000000000000000004',
    conversationId: 'conv_demo_history_004',
    startedAt: lastMonth,
    endedAt: '2026-08-05T11:35:40.000Z',
    durationSeconds: 340,
  },
  {
    id: '11111111-1111-4111-8111-000000000005',
    followupId: 'followup_demo_005',
    idempotencyKey: 'seed-history-followup-005',
    callSid: 'CAdemo00000000000000000000000005',
    conversationId: 'conv_demo_history_005',
    startedAt: lastMonth,
    endedAt: '2026-08-05T11:32:10.000Z',
    durationSeconds: 95,
  },
];

const outcomes: OutcomeRow[] = [
  {
    id: 'outcome_demo_002',
    sessionId: '11111111-1111-4111-8111-000000000002',
    disposition: 'callback_requested',
    summary: 'Vendor was travelling and asked for a callback next week.',
    callbackAt,
    supplierConfirmed: 0,
    quotationId: null,
  },
  {
    id: 'outcome_demo_003',
    sessionId: '11111111-1111-4111-8111-000000000003',
    disposition: 'quotation_pending',
    summary: 'Vendor confirmed a written quotation will be emailed within two working days.',
    callbackAt: null,
    supplierConfirmed: 0,
    quotationId: null,
  },
  {
    id: 'outcome_demo_004',
    sessionId: '11111111-1111-4111-8111-000000000004',
    disposition: 'pricing_confirmed',
    summary: 'Vendor explicitly confirmed complete item-wise KG pricing for both pipe sizes.',
    callbackAt: null,
    supplierConfirmed: 1,
    quotationId: 'quotation_demo_pipes',
  },
  {
    id: 'outcome_demo_005',
    sessionId: '11111111-1111-4111-8111-000000000005',
    disposition: 'cannot_supply',
    summary: 'Vendor stated alloy round bar is out of their supply range this quarter.',
    callbackAt: null,
    supplierConfirmed: 0,
    quotationId: null,
  },
];

const quotationItems = [
  {
    id: 'quotation_item_pipes_1',
    requirementItemId: 'item_pipes_1',
    initialRateMinor: 8_100,
    revisedRateMinor: 7_850,
    finalRateMinor: 7_850,
  },
  {
    id: 'quotation_item_pipes_2',
    requirementItemId: 'item_pipes_2',
    initialRateMinor: 7_950,
    revisedRateMinor: 7_700,
    finalRateMinor: 7_700,
  },
];

const knowledge = [
  {
    id: 'knowledge_delivery',
    category: 'commercial',
    key: 'delivery_location',
    value: 'Mumbai, Maharashtra',
  },
  {
    id: 'knowledge_payment',
    category: 'commercial',
    key: 'payment_terms',
    value: '30 days after accepted delivery',
  },
  {
    id: 'knowledge_gst',
    category: 'commercial',
    key: 'gst_policy',
    value: 'Rates must state whether GST is included or additional',
  },
  {
    id: 'knowledge_validity',
    category: 'commercial',
    key: 'quotation_validity',
    value: 'Quotation should remain valid for 30 days',
  },
  {
    id: 'knowledge_unit',
    category: 'purchase',
    key: 'commercial_unit',
    value: 'All items in PR-DEMO-2026-001 are priced per KG',
  },
  // Reaching this row from a call additionally requires adding the category to
  // businessAnswerSchema and re-running the ElevenLabs provisioner.
  {
    id: 'knowledge_negotiation',
    category: 'purchase',
    key: 'negotiation_boundaries',
    value:
      'Counter politely at most once, accept the vendor final rate, and never commit to an order on the call',
  },
];

export async function seedDemoData(db: Client): Promise<void> {
  const statements: InStatement[] = [
    {
      sql: `INSERT OR IGNORE INTO tenants(id, name, timezone, created_at)
            VALUES (?, ?, ?, ?)`,
      args: [tenantId, 'Ram Private Limited', 'Asia/Kolkata', now],
    },
    ...suppliers.map<InStatement>((supplier) => ({
      sql: `INSERT OR IGNORE INTO suppliers(
              id, tenant_id, supplier_code, legal_name, status, preferred_language, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        supplier.id,
        tenantId,
        supplier.code,
        supplier.legalName,
        supplier.status,
        'hi',
        now,
        now,
      ],
    })),
    ...contacts.map<InStatement>((contact) => ({
      sql: `INSERT OR IGNORE INTO supplier_contacts(
              id, tenant_id, supplier_id, name, phone_e164, email, is_primary,
              call_consent_status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        contact.id,
        tenantId,
        contact.supplierId,
        contact.name,
        contact.phone,
        contact.email,
        contact.isPrimary,
        contact.consent,
        now,
        now,
      ],
    })),
    ...requirements.map<InStatement>((requirement) => ({
      sql: `INSERT OR IGNORE INTO purchase_requirements(
              id, tenant_id, requirement_number, title, status, currency, version,
              required_by_date, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        requirement.id,
        tenantId,
        requirement.number,
        requirement.title,
        requirement.status,
        'INR',
        requirement.version,
        requirement.requiredBy,
        now,
        now,
      ],
    })),
    ...items.map<InStatement>((item) => ({
      sql: `INSERT OR IGNORE INTO purchase_requirement_items(
              id, tenant_id, purchase_requirement_id, line_number, item_name,
              specification, quantity_decimal, unit, target_rate_minor, maximum_rate_minor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'KG', ?, ?)`,
      args: [
        item.id,
        tenantId,
        item.requirementId,
        item.lineNumber,
        item.name,
        item.specification,
        item.quantity,
        item.targetRateMinor,
        item.maximumRateMinor,
      ],
    })),
    ...followups.map<InStatement>((followup) => ({
      sql: `INSERT OR IGNORE INTO followup_jobs(
              id, tenant_id, supplier_id, supplier_contact_id, purchase_requirement_id,
              status, scheduled_at, attempt_count, max_attempts, next_attempt_at,
              last_outcome, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        followup.id,
        tenantId,
        followup.supplierId,
        followup.contactId,
        followup.requirementId,
        followup.status,
        followup.scheduledAt,
        followup.attemptCount,
        3,
        followup.nextAttemptAt,
        followup.lastOutcome,
        now,
        now,
      ],
    })),
    {
      sql: `INSERT OR IGNORE INTO supplier_quotations(
              id, tenant_id, supplier_id, purchase_requirement_id, followup_job_id,
              status, discount_basis_points, confirmed_at, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, 1, ?, ?)`,
      args: [
        'quotation_demo_pipes',
        tenantId,
        'supplier_demo_metals',
        'requirement_demo_pipes',
        'followup_demo_004',
        250,
        lastMonth,
        lastMonth,
        lastMonth,
      ],
    },
    ...quotationItems.map<InStatement>((item) => ({
      sql: `INSERT OR IGNORE INTO supplier_quotation_items(
              id, tenant_id, quotation_id, requirement_item_id, initial_rate_minor,
              revised_rate_minor, final_rate_minor, unit, vendor_confirmed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'KG', 1)`,
      args: [
        item.id,
        tenantId,
        'quotation_demo_pipes',
        item.requirementItemId,
        item.initialRateMinor,
        item.revisedRateMinor,
        item.finalRateMinor,
      ],
    })),
    ...sessions.map<InStatement>((session) => ({
      sql: `INSERT OR IGNORE INTO call_sessions(
              id, tenant_id, followup_job_id, twilio_call_sid, elevenlabs_conversation_id,
              idempotency_key, status, started_at, answered_at, ended_at, duration_seconds,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`,
      args: [
        session.id,
        tenantId,
        session.followupId,
        session.callSid,
        session.conversationId,
        session.idempotencyKey,
        session.startedAt,
        session.startedAt,
        session.endedAt,
        session.durationSeconds,
        session.startedAt,
        session.endedAt,
      ],
    })),
    ...outcomes.map<InStatement>((outcome) => ({
      sql: `INSERT OR IGNORE INTO call_outcomes(
              id, tenant_id, call_session_id, disposition, summary, callback_at,
              supplier_confirmed, quotation_id, recorded_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?, ?)`,
      args: [
        outcome.id,
        tenantId,
        outcome.sessionId,
        outcome.disposition,
        outcome.summary,
        outcome.callbackAt,
        outcome.supplierConfirmed,
        outcome.quotationId,
        now,
        now,
      ],
    })),
    ...knowledge.map<InStatement>((fact) => ({
      sql: `INSERT OR IGNORE INTO agent_knowledge(
              id, tenant_id, category, key, value, is_active
            ) VALUES (?, ?, ?, ?, ?, 1)`,
      args: [fact.id, tenantId, fact.category, fact.key, fact.value],
    })),
  ];

  await db.batch(statements, 'write');
}
