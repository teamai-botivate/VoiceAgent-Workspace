import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrations.js';
import { seedDemoData } from '../src/db/seed.js';
import type { ProviderEvent } from '../src/domains/calls/events.js';
import { FollowupRepository } from '../src/domains/followups/repository.js';
import {
  spokenMoney,
  spokenRequirement,
  spokenSpecification,
} from '../src/domains/followups/speech.js';

describe('call reliability', () => {
  let db: Client;
  let repo: FollowupRepository;
  let databasePath: string;
  const scope = { tenantId: 'tenant_demo_ram', followupId: 'followup_demo_001' };
  beforeEach(async () => {
    databasePath = join(tmpdir(), `voice-reliability-${randomUUID()}.sqlite`);
    db = createClient({ url: `file:${databasePath}` });
    await runMigrations(db);
    await seedDemoData(db);
    repo = new FollowupRepository(db);
  });
  afterEach(() => {
    db.close();
    unlinkSync(databasePath);
  });
  const event = (
    id: string,
    status: string,
    provider: ProviderEvent['provider'] = 'twilio',
  ): ProviderEvent => ({
    provider,
    providerEventId: `${provider}:${status}`,
    eventType: 'test',
    callSessionId: id,
    status,
    occurredAt: '2026-09-05T00:00:00.000Z',
    payload: {},
  });
  async function session() {
    return repo.createCallSession({ ...scope, idempotencyKey: 'reliability-call' });
  }
  async function pricing() {
    const call = await session();
    await repo.markContextLoaded(scope.tenantId, call.id);
    return {
      ...scope,
      callSessionId: call.id,
      requirementId: 'requirement_demo_fasteners',
      requirementVersion: 1,
      items: [1, 2, 3, 4, 5].map((n) => ({
        requirementItemId: `item_demo_${n}`,
        initialRateMinor: 12550,
        finalRateMinor: 12550,
        unit: 'KG' as const,
      })),
    };
  }

  it('keeps failure separate from transport completion and ignores late ringing', async () => {
    const call = await session();
    await repo.recordProviderEvent({
      ...event(call.id, 'failed', 'elevenlabs'),
      failureMessage: 'generation failed',
      durationSeconds: 79,
    });
    await repo.recordProviderEvent(event(call.id, 'completed'));
    await repo.recordProviderEvent(event(call.id, 'ringing'));
    const result = await db.execute({
      sql: 'SELECT status, agent_status, transport_status, duration_seconds, failure_message FROM call_sessions WHERE id = ?',
      args: [call.id],
    });
    expect(result.rows[0]).toMatchObject({
      status: 'failed',
      agent_status: 'failed',
      transport_status: 'completed',
      duration_seconds: 79,
      failure_message: 'generation failed',
    });
  });

  it('deduplicates events and preserves the original ending timestamp', async () => {
    const call = await session();
    const input = event(call.id, 'completed');
    await repo.recordProviderEvent(input);
    await repo.recordProviderEvent(input);
    expect((await db.execute('SELECT COUNT(*) AS count FROM call_events')).rows[0]?.count).toBe(1);
    expect(
      (
        await db.execute({
          sql: 'SELECT ended_at FROM call_sessions WHERE id = ?',
          args: [call.id],
        })
      ).rows[0]?.ended_at,
    ).toBe(input.occurredAt);
  });

  it('persists an unmatched callback and replays it when provider attachment arrives', async () => {
    const call = await session();
    const input: ProviderEvent = {
      provider: 'twilio',
      providerEventId: 'early-callback',
      eventType: 'call_status',
      callSid: 'CAearly',
      status: 'completed',
      payload: {},
      occurredAt: new Date().toISOString(),
    };
    expect(await repo.recordProviderEvent(input)).toBe(false);
    await repo.attachProviderCall({
      tenantId: scope.tenantId,
      callSessionId: call.id,
      callSid: 'CAearly',
      conversationId: null,
    });
    expect((await repo.getCallSession(scope.tenantId, call.id)).status).toBe('completed');
    expect(
      (await db.execute('SELECT processed_at FROM provider_event_inbox')).rows[0]?.processed_at,
    ).toBeTruthy();
  });

  it('recovers an expired lease that never started a call', async () => {
    await db.execute(
      "UPDATE followup_jobs SET status = 'cancelled' WHERE id <> 'followup_demo_001'",
    );
    await db.execute("UPDATE supplier_contacts SET call_consent_status = 'test_approved'");
    await db.execute(
      "UPDATE followup_jobs SET status = 'leased', next_attempt_at = NULL, scheduled_at = '2020-01-01', lease_expires_at = '2020-01-01' WHERE id = 'followup_demo_001'",
    );
    expect(await repo.leaseNextDueFollowup('recovered-worker')).toMatchObject({
      followupId: scope.followupId,
    });
  });

  it('blocks a second dial and preserves an uncertain initiation for review', async () => {
    const call = await session();
    await repo.markCallInitiating(scope.tenantId, call.id);
    await repo.holdUncertainCall(scope.tenantId, call.id, 'timeout');
    await expect(
      repo.createCallSession({ ...scope, idempotencyKey: 'different-attempt' }),
    ).rejects.toMatchObject({ code: 'CALL_ALREADY_ACTIVE' });
    expect(await repo.leaseNextDueFollowup('worker')).toBeNull();
    expect((await repo.getCallSession(scope.tenantId, call.id)).status).toBe('initiating');
  });

  it('marks a call without a committed outcome for review, not business success', async () => {
    const call = await session();
    await repo.recordProviderEvent(event(call.id, 'completed'));
    expect(
      (
        await db.execute(
          "SELECT status, last_outcome FROM followup_jobs WHERE id = 'followup_demo_001'",
        )
      ).rows[0],
    ).toMatchObject({ status: 'failed', last_outcome: 'review_required' });
  });

  it('requires context before preparing rates', async () => {
    const input = await pricing();
    await db.execute('UPDATE call_sessions SET context_loaded_at = NULL');
    await expect(repo.previewPricing(input)).rejects.toMatchObject({ code: 'CONTEXT_REQUIRED' });
  });

  it('rejects pricing without preview and rejects rates changed after preview', async () => {
    const input = await pricing();
    await expect(
      repo.recordPricing({ ...input, explicitConfirmation: true }),
    ).rejects.toMatchObject({ code: 'PRICING_PREVIEW_REQUIRED' });
    const preview = await repo.previewPricing(input);
    expect(preview.readback[0]).toContain('one hundred twenty-five rupees and fifty paise');
    await expect(
      repo.recordPricing({
        ...input,
        explicitConfirmation: true,
        confirmationToken: preview.confirmationToken,
        items: input.items.map((item) => ({ ...item, finalRateMinor: 13000 })),
      }),
    ).rejects.toMatchObject({ code: 'PRICING_PREVIEW_REQUIRED' });
    expect(
      (
        await db.execute(
          "SELECT COUNT(*) AS count FROM supplier_quotations WHERE followup_job_id = 'followup_demo_001'",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it('expires old previews and invalidates tokens when readback is prepared again', async () => {
    const input = await pricing();
    const first = await repo.previewPricing(input);
    const second = await repo.previewPricing(input);
    await expect(
      repo.recordPricing({
        ...input,
        explicitConfirmation: true,
        confirmationToken: first.confirmationToken,
      }),
    ).rejects.toMatchObject({ code: 'PRICING_PREVIEW_REQUIRED' });
    await db.execute("UPDATE call_sessions SET pricing_preview_at = '2020-01-01'");
    await expect(
      repo.recordPricing({
        ...input,
        explicitConfirmation: true,
        confirmationToken: second.confirmationToken,
      }),
    ).rejects.toMatchObject({ code: 'PRICING_PREVIEW_EXPIRED' });
  });

  it('persists explicit opt-out and refuses further approved-destination checks', async () => {
    const call = await session();
    await repo.recordSupplierResponse({
      ...scope,
      callSessionId: call.id,
      disposition: 'opted_out',
      summary: 'Please do not call again.',
    });
    expect(
      (await db.execute('SELECT call_consent_status FROM supplier_contacts')).rows[0]
        ?.call_consent_status,
    ).toBe('opted_out');
    expect(
      (await db.execute("SELECT status FROM followup_jobs WHERE id = 'followup_demo_001'")).rows[0]
        ?.status,
    ).toBe('cancelled');
    await expect(
      repo.assertApprovedDestination(scope.tenantId, scope.followupId, '+910000000000'),
    ).rejects.toMatchObject({ code: 'CONTACT_NOT_APPROVED' });
  });

  it('formats codes, specifications and money without changing canonical values', () => {
    expect(spokenRequirement('PR-DEMO-2026-001')).toBe(
      'P R, Demo, two zero two six, zero zero one',
    );
    expect(spokenSpecification('M12 × 50 mm')).toBe('M twelve by fifty millimetres');
    expect(spokenMoney(12550)).toBe('one hundred twenty-five rupees and fifty paise per kilogram');
  });

  it('does not query providers for synthetic seeded call history', async () => {
    expect(await repo.callsNeedingReconciliation()).toEqual([]);
  });

  it('combines context and scope while still reading current quantities and versions', async () => {
    const call = await session();
    const first = await repo.getContext(scope.tenantId, scope.followupId, call.id);
    expect(first.items).toHaveLength(5);
    await expect(repo.getContext('other-tenant', scope.followupId, call.id)).rejects.toMatchObject({
      code: 'INVALID_CALL_CONTEXT',
    });
    await expect(
      repo.getContext(scope.tenantId, scope.followupId, 'wrong-call'),
    ).rejects.toMatchObject({ code: 'INVALID_CALL_CONTEXT' });
    await db.execute(
      "UPDATE purchase_requirement_items SET quantity_decimal = '99' WHERE id = 'item_demo_1'",
    );
    await db.execute(
      "UPDATE purchase_requirements SET version = 2 WHERE id = 'requirement_demo_fasteners'",
    );
    const latest = await repo.getContext(scope.tenantId, scope.followupId, call.id);
    expect(latest.requirementVersion).toBe(2);
    expect(latest.items[0]?.quantity).toBe('99');
  });

  it('loads header and items with exactly one database execute', async () => {
    const spy = vi.spyOn(db, 'execute');
    await repo.getContext(scope.tenantId, scope.followupId);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('rolls back the entire quotation if a batched line insert fails', async () => {
    const input = await pricing();
    const preview = await repo.previewPricing(input);
    await db.execute(`CREATE TRIGGER fail_second_line BEFORE INSERT ON supplier_quotation_items
      WHEN NEW.requirement_item_id = 'item_demo_2' BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END`);
    await expect(
      repo.recordPricing({
        ...input,
        explicitConfirmation: true,
        confirmationToken: preview.confirmationToken,
      }),
    ).rejects.toThrow();
    expect(
      (
        await db.execute(
          "SELECT COUNT(*) AS n FROM supplier_quotations WHERE followup_job_id = 'followup_demo_001'",
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await db.execute(
          "SELECT COUNT(*) AS n FROM supplier_quotation_items WHERE requirement_item_id = 'item_demo_1'",
        )
      ).rows[0]?.n,
    ).toBe(0);
  });
});
