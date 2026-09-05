import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrations.js';
import { seedDemoData } from '../src/db/seed.js';
import { FollowupRepository } from '../src/domains/followups/repository.js';

describe('standalone repository', () => {
  let database: Client;
  let repository: FollowupRepository;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `voice-agent-test-${randomUUID()}.sqlite`);
    database = createClient({ url: `file:${databasePath}` });
    await runMigrations(database);
    await seedDemoData(database);
    repository = new FollowupRepository(database);
  });

  afterEach(() => {
    database.close();
    try {
      unlinkSync(databasePath);
    } catch {
      // The temporary database may already be absent after a failed setup.
    }
  });

  it('loads the complete tenant-scoped follow-up context', async () => {
    const context = await repository.getContext('tenant_demo_ram', 'followup_demo_001');
    expect(context.tenantName).toBe('Ram Private Limited');
    expect(context.requirementNumber).toBe('PR-DEMO-2026-001');
    expect(context.items).toHaveLength(5);
    expect(context.items.every((item) => item.unit === 'KG')).toBe(true);

    await expect(
      repository.getContext('another_tenant', 'followup_demo_001'),
    ).rejects.toMatchObject({
      code: 'FOLLOWUP_NOT_FOUND',
    });
  });

  it('stores confirmed complete pricing once', async () => {
    const session = await repository.createCallSession({
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      idempotencyKey: 'repository-test-call',
    });
    await repository.markContextLoaded('tenant_demo_ram', session.id);
    const items = [1, 2, 3, 4, 5].map((number) => ({
      requirementItemId: `item_demo_${number}`,
      initialRateMinor: 30_000 + number,
      finalRateMinor: 29_000 + number,
      unit: 'KG' as const,
    }));

    const preview = await repository.previewPricing({
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      callSessionId: session.id,
      requirementId: 'requirement_demo_fasteners',
      requirementVersion: 1,
      discountBasisPoints: 300,
      items,
    });
    const first = await repository.recordPricing({
      confirmationToken: preview.confirmationToken,
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      callSessionId: session.id,
      requirementId: 'requirement_demo_fasteners',
      requirementVersion: 1,
      explicitConfirmation: true,
      discountBasisPoints: 300,
      items,
    });
    const repeated = await repository.recordPricing({
      confirmationToken: preview.confirmationToken,
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      callSessionId: session.id,
      requirementId: 'requirement_demo_fasteners',
      requirementVersion: 1,
      explicitConfirmation: true,
      discountBasisPoints: 300,
      items,
    });

    expect(first.idempotent).toBe(false);
    expect(repeated).toEqual({ quotationId: first.quotationId, idempotent: true });
    const count = await database.execute({
      sql: 'SELECT COUNT(*) AS count FROM supplier_quotations WHERE tenant_id = ? AND followup_job_id = ?',
      args: ['tenant_demo_ram', 'followup_demo_001'],
    });
    expect(Number(count.rows[0]?.count)).toBe(1);
    const confirmation = await database.execute({
      sql: `SELECT payload_redacted_json FROM call_events
            WHERE call_session_id = ? AND event_type = 'pricing_explicitly_confirmed'`,
      args: [session.id],
    });
    expect(JSON.parse(String(confirmation.rows[0]?.payload_redacted_json))).toEqual({
      explicitConfirmation: true,
    });
  });

  it('rejects incomplete pricing and stale requirement data', async () => {
    const session = await repository.createCallSession({
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      idempotencyKey: 'repository-negative-test-call',
    });
    await repository.markContextLoaded('tenant_demo_ram', session.id);
    await expect(
      repository.recordPricing({
        tenantId: 'tenant_demo_ram',
        followupId: 'followup_demo_001',
        callSessionId: session.id,
        requirementId: 'requirement_demo_fasteners',
        requirementVersion: 1,
        explicitConfirmation: true,
        items: [
          {
            requirementItemId: 'item_demo_1',
            initialRateMinor: 30_000,
            finalRateMinor: 29_000,
            unit: 'KG',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_PRICING' });

    await database.execute(
      "UPDATE purchase_requirements SET version = 2 WHERE id = 'requirement_demo_fasteners'",
    );
    await expect(
      repository.recordPricing({
        tenantId: 'tenant_demo_ram',
        followupId: 'followup_demo_001',
        callSessionId: session.id,
        requirementId: 'requirement_demo_fasteners',
        requirementVersion: 1,
        explicitConfirmation: true,
        items: [],
      }),
    ).rejects.toMatchObject({ code: 'STALE_REQUIREMENT' });
  });

  it('rejects an idempotency key reused for a different follow-up', async () => {
    await repository.createCallSession({
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      idempotencyKey: 'scope-safe-idempotency-key',
    });
    await database.execute({
      sql: `INSERT INTO followup_jobs(
              id, tenant_id, supplier_id, supplier_contact_id, purchase_requirement_id,
              status, scheduled_at, attempt_count, max_attempts, created_at, updated_at
            )
            SELECT 'followup_scope_probe', tenant_id, supplier_id, supplier_contact_id,
              purchase_requirement_id, 'pending', scheduled_at, 0, max_attempts, created_at, updated_at
            FROM followup_jobs WHERE id = 'followup_demo_001'`,
      args: [],
    });
    await expect(
      repository.createCallSession({
        tenantId: 'tenant_demo_ram',
        followupId: 'followup_scope_probe',
        idempotencyKey: 'scope-safe-idempotency-key',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('correlates the first ElevenLabs event through the signed call session context', async () => {
    const session = await repository.createCallSession({
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      idempotencyKey: 'fallback-correlation-test',
    });
    await repository.attachProviderCall({
      tenantId: 'tenant_demo_ram',
      callSessionId: session.id,
      conversationId: null,
      callSid: 'CA_test_fallback',
    });
    const recorded = await repository.recordProviderEvent({
      provider: 'elevenlabs',
      providerEventId: 'post-call:test-conversation:1',
      eventType: 'post_call_transcription',
      conversationId: 'test-conversation',
      callSessionId: session.id,
      status: 'completed',
      payload: { type: 'post_call_transcription' },
      occurredAt: new Date().toISOString(),
    });
    expect(recorded).toBe(true);
    const bound = await repository.getCallSession('tenant_demo_ram', session.id);
    expect(bound.conversationId).toBe('test-conversation');
  });

  it('backs off failed calls instead of immediately re-leasing them', async () => {
    const before = Date.now();
    const session = await repository.createCallSession({
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      idempotencyKey: 'retry-backoff-test',
    });
    await repository.markCallFailed(
      'tenant_demo_ram',
      session.id,
      'TEST_FAILURE',
      'Synthetic failure',
    );
    const job = await database.execute(
      "SELECT status, next_attempt_at FROM followup_jobs WHERE id = 'followup_demo_001'",
    );
    expect(job.rows[0]?.status).toBe('pending');
    expect(new Date(String(job.rows[0]?.next_attempt_at)).getTime()).toBeGreaterThanOrEqual(
      before + 119_000,
    );
  });
});
