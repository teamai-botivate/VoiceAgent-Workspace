import { createHash, randomUUID } from 'node:crypto';
import type { Client, Row } from '@libsql/client';
import { AppError } from '../../shared/errors.js';
import { isTerminal, nextCallStatus, type ProviderEvent } from '../calls/events.js';
import { spokenMoney, spokenSpecification } from './speech.js';

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be text`);
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`Expected ${key} to be an integer`);
}

export type FollowupItem = {
  id: string;
  lineNumber: number;
  name: string;
  specification: string;
  quantity: string;
  unit: 'KG';
};

export type FollowupContext = {
  tenantId: string;
  tenantName: string;
  followupId: string;
  supplierId: string;
  supplierName: string;
  contactName: string;
  preferredLanguage: string;
  requirementId: string;
  requirementNumber: string;
  requirementTitle: string;
  requirementVersion: number;
  currency: string;
  items: FollowupItem[];
};

export type PricingLine = {
  requirementItemId: string;
  initialRateMinor: number;
  revisedRateMinor?: number | null | undefined;
  finalRateMinor: number;
  unit: 'KG';
};

type PricingPreview = {
  tenantId: string;
  followupId: string;
  callSessionId: string;
  requirementId: string;
  requirementVersion: number;
  discountBasisPoints?: number | null | undefined;
  items: PricingLine[];
};

function pricingHash(input: PricingPreview): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        requirementId: input.requirementId,
        requirementVersion: input.requirementVersion,
        discountBasisPoints: input.discountBasisPoints ?? null,
        items: [...input.items]
          .sort((a, b) => a.requirementItemId.localeCompare(b.requirementItemId))
          .map((item) => [
            item.requirementItemId,
            item.initialRateMinor,
            item.revisedRateMinor ?? null,
            item.finalRateMinor,
            item.unit,
          ]),
      }),
    )
    .digest('hex');
}

export class FollowupRepository {
  constructor(private readonly db: Client) {}

  async getContext(tenantId: string, followupId: string): Promise<FollowupContext> {
    const header = await this.db.execute({
      sql: `SELECT
              f.id AS followup_id, f.tenant_id, t.name AS tenant_name,
              s.id AS supplier_id, s.legal_name AS supplier_name,
              s.preferred_language, c.name AS contact_name,
              p.id AS requirement_id, p.requirement_number, p.title AS requirement_title,
              p.version AS requirement_version, p.currency
            FROM followup_jobs f
            JOIN tenants t ON t.id = f.tenant_id
            JOIN suppliers s ON s.id = f.supplier_id AND s.tenant_id = f.tenant_id
            JOIN supplier_contacts c ON c.id = f.supplier_contact_id AND c.tenant_id = f.tenant_id
            JOIN purchase_requirements p
              ON p.id = f.purchase_requirement_id AND p.tenant_id = f.tenant_id
            WHERE f.id = ? AND f.tenant_id = ?`,
      args: [followupId, tenantId],
    });

    const row = header.rows[0];
    if (!row) throw new AppError('Follow-up not found', 404, 'FOLLOWUP_NOT_FOUND');

    const itemResult = await this.db.execute({
      sql: `SELECT id, line_number, item_name, specification, quantity_decimal, unit
            FROM purchase_requirement_items
            WHERE tenant_id = ? AND purchase_requirement_id = ?
            ORDER BY line_number`,
      args: [tenantId, text(row, 'requirement_id')],
    });

    return {
      tenantId: text(row, 'tenant_id'),
      tenantName: text(row, 'tenant_name'),
      followupId: text(row, 'followup_id'),
      supplierId: text(row, 'supplier_id'),
      supplierName: text(row, 'supplier_name'),
      contactName: text(row, 'contact_name'),
      preferredLanguage: text(row, 'preferred_language'),
      requirementId: text(row, 'requirement_id'),
      requirementNumber: text(row, 'requirement_number'),
      requirementTitle: text(row, 'requirement_title'),
      requirementVersion: integer(row, 'requirement_version'),
      currency: text(row, 'currency'),
      items: itemResult.rows.map((item) => ({
        id: text(item, 'id'),
        lineNumber: integer(item, 'line_number'),
        name: text(item, 'item_name'),
        specification: text(item, 'specification'),
        quantity: text(item, 'quantity_decimal'),
        unit: 'KG' as const,
      })),
    };
  }

  async getBusinessAnswer(tenantId: string, category: string): Promise<string> {
    const result = await this.db.execute({
      sql: `SELECT value FROM agent_knowledge
            WHERE tenant_id = ? AND key = ? AND is_active = 1
              AND (effective_from IS NULL OR effective_from <= ?)
              AND (effective_to IS NULL OR effective_to >= ?)
            LIMIT 1`,
      args: [tenantId, category, new Date().toISOString(), new Date().toISOString()],
    });
    const row = result.rows[0];
    if (!row)
      throw new AppError('Approved business answer is unavailable', 404, 'ANSWER_NOT_FOUND');
    return text(row, 'value');
  }

  async assertCallContext(
    tenantId: string,
    followupId: string,
    callSessionId: string,
  ): Promise<void> {
    const result = await this.db.execute({
      sql: `SELECT 1 AS found FROM call_sessions
            WHERE id = ? AND tenant_id = ? AND followup_job_id = ?`,
      args: [callSessionId, tenantId, followupId],
    });
    if (!result.rows[0]) throw new AppError('Call context is invalid', 403, 'INVALID_CALL_CONTEXT');
  }

  async createCallSession(input: {
    tenantId: string;
    followupId: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string; existing: boolean }> {
    const existing = await this.db.execute({
      sql: `SELECT id, tenant_id, followup_job_id, status FROM call_sessions
            WHERE idempotency_key = ?`,
      args: [input.idempotencyKey],
    });
    const existingRow = existing.rows[0];
    if (existingRow) {
      if (
        text(existingRow, 'tenant_id') !== input.tenantId ||
        text(existingRow, 'followup_job_id') !== input.followupId
      ) {
        throw new AppError(
          'Idempotency key was already used for a different call',
          409,
          'IDEMPOTENCY_KEY_REUSED',
        );
      }
      return { id: text(existingRow, 'id'), status: text(existingRow, 'status'), existing: true };
    }

    await this.getContext(input.tenantId, input.followupId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const created = await this.db.batch(
      [
        {
          sql: `INSERT INTO call_sessions(
                  id, tenant_id, followup_job_id, idempotency_key, status, created_at, updated_at
                ) SELECT ?, ?, ?, ?, 'created', ?, ?
                  WHERE NOT EXISTS (SELECT 1 FROM call_sessions WHERE tenant_id = ? AND followup_job_id = ?
                    AND status IN ('created', 'initiating', 'initiated', 'ringing', 'in_progress'))`,
          args: [
            id,
            input.tenantId,
            input.followupId,
            input.idempotencyKey,
            now,
            now,
            input.tenantId,
            input.followupId,
          ],
        },
        {
          sql: `UPDATE followup_jobs SET status = 'calling', attempt_count = attempt_count + 1,
                  updated_at = ? WHERE id = ? AND tenant_id = ? AND EXISTS (SELECT 1 FROM call_sessions WHERE id = ?)`,
          args: [now, input.followupId, input.tenantId, id],
        },
      ],
      'write',
    );
    if (created[0]?.rowsAffected !== 1) {
      const concurrent = await this.db.execute({
        sql: 'SELECT id, status FROM call_sessions WHERE idempotency_key = ? AND tenant_id = ? AND followup_job_id = ?',
        args: [input.idempotencyKey, input.tenantId, input.followupId],
      });
      const row = concurrent.rows[0];
      if (row) return { id: text(row, 'id'), status: text(row, 'status'), existing: true };
      throw new AppError(
        'A call for this follow-up is already active or awaiting reconciliation',
        409,
        'CALL_ALREADY_ACTIVE',
      );
    }
    return { id, status: 'created', existing: false };
  }

  async assertApprovedDestination(
    tenantId: string,
    followupId: string,
    phone: string,
  ): Promise<void> {
    const result = await this.db.execute({
      sql: `SELECT 1 AS found FROM followup_jobs f JOIN supplier_contacts c ON c.id = f.supplier_contact_id AND c.tenant_id = f.tenant_id
            WHERE f.tenant_id = ? AND f.id = ? AND c.phone_e164 = ? AND c.call_consent_status = 'test_approved'`,
      args: [tenantId, followupId, phone],
    });
    if (!result.rows[0])
      throw new AppError(
        'Destination is not the approved follow-up contact',
        403,
        'CONTACT_NOT_APPROVED',
      );
  }

  async getCallSession(
    tenantId: string,
    callSessionId: string,
  ): Promise<{
    id: string;
    status: string;
    conversationId: string | null;
    callSid: string | null;
  }> {
    const result = await this.db.execute({
      sql: `SELECT id, status, elevenlabs_conversation_id, twilio_call_sid
            FROM call_sessions WHERE id = ? AND tenant_id = ?`,
      args: [callSessionId, tenantId],
    });
    const row = result.rows[0];
    if (!row) throw new AppError('Call session not found', 404, 'CALL_NOT_FOUND');
    return {
      id: text(row, 'id'),
      status: text(row, 'status'),
      conversationId:
        typeof row.elevenlabs_conversation_id === 'string' ? row.elevenlabs_conversation_id : null,
      callSid: typeof row.twilio_call_sid === 'string' ? row.twilio_call_sid : null,
    };
  }

  async markCallInitiating(tenantId: string, callSessionId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute({
      sql: `UPDATE call_sessions SET status = 'initiating', started_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND status = 'created'`,
      args: [now, now, callSessionId, tenantId],
    });
  }

  async attachProviderCall(input: {
    tenantId: string;
    callSessionId: string;
    conversationId: string | null;
    callSid: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute({
      sql: `UPDATE call_sessions
            SET status = CASE WHEN status IN ('created', 'initiating') THEN 'initiated' ELSE status END,
                elevenlabs_conversation_id = COALESCE(elevenlabs_conversation_id, ?),
                twilio_call_sid = COALESCE(twilio_call_sid, ?), updated_at = ?
            WHERE id = ? AND tenant_id = ?`,
      args: [input.conversationId, input.callSid, now, input.callSessionId, input.tenantId],
    });
    await this.replayProviderEvents();
  }

  async holdUncertainCall(tenantId: string, callSessionId: string, message: string): Promise<void> {
    await this.db.execute({
      sql: `UPDATE call_sessions SET failure_code = 'INITIATION_UNCERTAIN', failure_message = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND status IN ('created', 'initiating', 'initiated')`,
      args: [message.slice(0, 500), new Date().toISOString(), callSessionId, tenantId],
    });
  }

  async markCallFailed(
    tenantId: string,
    callSessionId: string,
    code: string,
    message: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const attemptResult = await this.db.execute({
      sql: `SELECT f.attempt_count
            FROM followup_jobs f
            JOIN call_sessions c ON c.followup_job_id = f.id AND c.tenant_id = f.tenant_id
            WHERE c.id = ? AND c.tenant_id = ?`,
      args: [callSessionId, tenantId],
    });
    const attemptCount = attemptResult.rows[0]
      ? integer(attemptResult.rows[0], 'attempt_count')
      : 1;
    const retryDelayMinutes = [2, 5, 15][Math.min(Math.max(attemptCount - 1, 0), 2)] ?? 15;
    const nextAttemptAt = new Date(Date.now() + retryDelayMinutes * 60_000).toISOString();
    await this.db.batch(
      [
        {
          sql: `UPDATE call_sessions
                SET status = 'failed', failure_code = ?, failure_message = ?, ended_at = ?, updated_at = ?
                WHERE id = ? AND tenant_id = ?`,
          args: [code, message.slice(0, 500), now, now, callSessionId, tenantId],
        },
        {
          sql: `UPDATE followup_jobs SET status = CASE
                  WHEN attempt_count < max_attempts THEN 'pending' ELSE 'failed' END,
                  next_attempt_at = CASE WHEN attempt_count < max_attempts THEN ? ELSE NULL END,
                  lease_owner = NULL, lease_expires_at = NULL,
                  last_outcome = ?, updated_at = ?
                WHERE tenant_id = ? AND id = (
                  SELECT followup_job_id FROM call_sessions WHERE id = ? AND tenant_id = ?
                )`,
          args: [nextAttemptAt, code, now, tenantId, callSessionId, tenantId],
        },
      ],
      'write',
    );
  }

  async leaseNextDueFollowup(workerId: string): Promise<{
    tenantId: string;
    followupId: string;
    phoneNumber: string;
    attemptNumber: number;
  } | null> {
    const tx = await this.db.transaction('write');
    try {
      const now = new Date();
      // Only recover leases that never started a call. Uncertain provider side effects
      // must be reconciled, never treated as permission to dial again.
      await tx.execute({
        sql: `UPDATE followup_jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
              WHERE status = 'leased' AND lease_expires_at < ?
                AND NOT EXISTS (SELECT 1 FROM call_sessions c WHERE c.followup_job_id = followup_jobs.id
                  AND c.status IN ('created', 'initiating', 'initiated', 'ringing', 'in_progress'))`,
        args: [now.toISOString()],
      });
      const rowResult = await tx.execute({
        sql: `SELECT f.id, f.tenant_id, f.attempt_count, c.phone_e164
              FROM followup_jobs f
              JOIN supplier_contacts c
                ON c.id = f.supplier_contact_id AND c.tenant_id = f.tenant_id
              WHERE f.status IN ('pending', 'callback_requested')
                AND f.attempt_count < f.max_attempts
                AND c.call_consent_status = 'test_approved'
                AND COALESCE(f.next_attempt_at, f.scheduled_at) <= ?
                AND (f.lease_expires_at IS NULL OR f.lease_expires_at < ?)
              ORDER BY COALESCE(f.next_attempt_at, f.scheduled_at), f.id
              LIMIT 1`,
        args: [now.toISOString(), now.toISOString()],
      });
      const row = rowResult.rows[0];
      if (!row) {
        await tx.commit();
        return null;
      }
      const followupId = text(row, 'id');
      const tenantId = text(row, 'tenant_id');
      const leaseExpiresAt = new Date(now.getTime() + 60_000).toISOString();
      const updated = await tx.execute({
        sql: `UPDATE followup_jobs
              SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ?
                AND status IN ('pending', 'callback_requested')
                AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
        args: [
          workerId,
          leaseExpiresAt,
          now.toISOString(),
          followupId,
          tenantId,
          now.toISOString(),
        ],
      });
      if (updated.rowsAffected !== 1) {
        await tx.rollback();
        return null;
      }
      await tx.commit();
      return {
        tenantId,
        followupId,
        phoneNumber: text(row, 'phone_e164'),
        attemptNumber: integer(row, 'attempt_count') + 1,
      };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  async releaseLease(tenantId: string, followupId: string, reason: string): Promise<void> {
    await this.db.execute({
      sql: `UPDATE followup_jobs SET status = 'cancelled', lease_owner = NULL,
              lease_expires_at = NULL, last_outcome = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND status = 'leased'`,
      args: [reason, new Date().toISOString(), followupId, tenantId],
    });
  }

  async recordProviderEvent(input: ProviderEvent): Promise<boolean> {
    await this.db.execute({
      sql: `INSERT INTO provider_event_inbox(provider, event_id, event_json, received_at)
            VALUES (?, ?, ?, ?) ON CONFLICT(provider, event_id) DO NOTHING`,
      args: [
        input.provider,
        input.providerEventId,
        JSON.stringify(input),
        new Date().toISOString(),
      ],
    });
    const inbox = await this.db.execute({
      sql: 'SELECT processed_at FROM provider_event_inbox WHERE provider = ? AND event_id = ?',
      args: [input.provider, input.providerEventId],
    });
    if (inbox.rows[0]?.processed_at) return true;
    let call = input.conversationId
      ? (
          await this.db.execute({
            sql: 'SELECT id, tenant_id FROM call_sessions WHERE elevenlabs_conversation_id = ?',
            args: [input.conversationId],
          })
        ).rows[0]
      : undefined;
    if (!call && input.callSid) {
      call = (
        await this.db.execute({
          sql: 'SELECT id, tenant_id FROM call_sessions WHERE twilio_call_sid = ?',
          args: [input.callSid],
        })
      ).rows[0];
    }
    if (!call && input.callSessionId) {
      call = (
        await this.db.execute({
          sql: 'SELECT id, tenant_id FROM call_sessions WHERE id = ?',
          args: [input.callSessionId],
        })
      ).rows[0];
    }
    if (!call) return false;

    const callSessionId = text(call, 'id');
    const tenantId = text(call, 'tenant_id');
    const now = new Date().toISOString();
    const tx = await this.db.transaction('write');
    try {
      const processed = await tx.execute({
        sql: 'SELECT processed_at FROM provider_event_inbox WHERE provider = ? AND event_id = ?',
        args: [input.provider, input.providerEventId],
      });
      if (processed.rows[0]?.processed_at) {
        await tx.commit();
        return true;
      }
      const current = await tx.execute({
        sql: 'SELECT status, transport_status, agent_status FROM call_sessions WHERE id = ?',
        args: [callSessionId],
      });
      const row = current.rows[0];
      if (!row) {
        await tx.rollback();
        return false;
      }
      const status = nextCallStatus(text(row, 'status'), input.status);
      const providerColumn = input.provider === 'twilio' ? 'transport_status' : 'agent_status';
      const providerStatus = nextCallStatus(
        typeof row[providerColumn] === 'string' ? String(row[providerColumn]) : 'created',
        input.status,
      );
      await tx.batch([
        {
          sql: `INSERT INTO call_events(
                    id, tenant_id, call_session_id, provider, provider_event_id,
                    event_type, payload_redacted_json, occurred_at, received_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            randomUUID(),
            tenantId,
            callSessionId,
            input.provider,
            input.providerEventId,
            input.eventType,
            JSON.stringify(input.payload),
            input.occurredAt,
            now,
          ],
        },
        {
          sql: `UPDATE call_sessions SET status = ?, ${providerColumn} = ?,
                    elevenlabs_conversation_id = COALESCE(elevenlabs_conversation_id, ?),
                    twilio_call_sid = COALESCE(twilio_call_sid, ?),
                    ended_at = CASE WHEN ? IN ('completed', 'busy', 'no_answer', 'failed', 'cancelled')
                      THEN COALESCE(ended_at, ?) ELSE ended_at END,
                    duration_seconds = CASE WHEN ? IS NULL THEN duration_seconds ELSE MAX(COALESCE(duration_seconds, 0), ?) END,
                    failure_code = CASE WHEN ? = 'failed' THEN COALESCE(failure_code, 'PROVIDER_FAILURE') ELSE failure_code END,
                    failure_message = COALESCE(?, failure_message), updated_at = ?
                  WHERE id = ? AND tenant_id = ?`,
          args: [
            status,
            providerStatus,
            input.conversationId ?? null,
            input.callSid ?? null,
            status,
            input.occurredAt,
            input.durationSeconds ?? null,
            input.durationSeconds ?? null,
            status,
            input.failureMessage ?? null,
            now,
            callSessionId,
            tenantId,
          ],
        },
      ]);
      if (isTerminal(status)) {
        // A connected call is not a successful business outcome. Leave a clear
        // review state when no tool committed an outcome; do not auto-redial.
        await tx.execute({
          sql: `UPDATE followup_jobs SET status = 'failed', last_outcome = 'review_required',
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                WHERE id = (SELECT followup_job_id FROM call_sessions WHERE id = ?)
                  AND status = 'calling'
                  AND NOT EXISTS (SELECT 1 FROM call_outcomes WHERE call_session_id = ?)`,
          args: [now, callSessionId, callSessionId],
        });
      }
      await tx.execute({
        sql: 'UPDATE provider_event_inbox SET processed_at = ? WHERE provider = ? AND event_id = ?',
        args: [now, input.provider, input.providerEventId],
      });
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  async replayProviderEvents(): Promise<void> {
    const pending = await this.db.execute(
      'SELECT event_json FROM provider_event_inbox WHERE processed_at IS NULL ORDER BY received_at LIMIT 100',
    );
    for (const row of pending.rows)
      await this.recordProviderEvent(JSON.parse(text(row, 'event_json')) as ProviderEvent);
  }

  async markContextLoaded(tenantId: string, callSessionId: string): Promise<void> {
    await this.db.execute({
      sql: 'UPDATE call_sessions SET context_loaded_at = ? WHERE id = ? AND tenant_id = ?',
      args: [new Date().toISOString(), callSessionId, tenantId],
    });
  }

  async callsNeedingReconciliation(): Promise<
    Array<{ id: string; callSid: string | null; conversationId: string | null }>
  > {
    const result = await this.db.execute({
      sql: `SELECT id, twilio_call_sid, elevenlabs_conversation_id FROM call_sessions
            WHERE (status IN ('created', 'initiating', 'initiated', 'ringing', 'in_progress')
              OR (status = 'completed' AND elevenlabs_conversation_id IS NOT NULL AND agent_status IS NULL))
              AND idempotency_key NOT LIKE 'seed-history-%'
              AND updated_at < ? ORDER BY updated_at LIMIT 20`,
      args: [new Date(Date.now() - 120_000).toISOString()],
    });
    return result.rows.map((row) => ({
      id: text(row, 'id'),
      callSid: typeof row.twilio_call_sid === 'string' ? row.twilio_call_sid : null,
      conversationId:
        typeof row.elevenlabs_conversation_id === 'string' ? row.elevenlabs_conversation_id : null,
    }));
  }

  async previewPricing(
    input: PricingPreview,
  ): Promise<{ confirmationToken: string; readback: string[] }> {
    await this.assertCallContext(input.tenantId, input.followupId, input.callSessionId);
    const context = await this.getContext(input.tenantId, input.followupId);
    if (
      input.requirementId !== context.requirementId ||
      input.requirementVersion !== context.requirementVersion
    ) {
      throw new AppError('Requirement changed or does not match', 409, 'STALE_REQUIREMENT');
    }
    const expected = context.items.map((item) => item.id).sort();
    const supplied = input.items.map((item) => item.requirementItemId).sort();
    if (
      expected.length !== supplied.length ||
      expected.some((id, index) => id !== supplied[index])
    ) {
      throw new AppError('Preview must include every item exactly once', 422, 'INCOMPLETE_PRICING');
    }
    const confirmationToken = randomUUID();
    const result = await this.db.execute({
      sql: `UPDATE call_sessions SET pricing_preview_hash = ?, pricing_confirmation_token = ?, pricing_preview_at = ?
            WHERE id = ? AND tenant_id = ? AND context_loaded_at IS NOT NULL
              AND status NOT IN ('completed', 'failed', 'cancelled', 'busy', 'no_answer')`,
      args: [
        pricingHash(input),
        confirmationToken,
        new Date().toISOString(),
        input.callSessionId,
        input.tenantId,
      ],
    });
    if (result.rowsAffected !== 1)
      throw new AppError('Load context in an active call before pricing', 409, 'CONTEXT_REQUIRED');
    return {
      confirmationToken,
      readback: context.items.map((item) => {
        const rate = input.items.find((line) => line.requirementItemId === item.id);
        if (!rate) throw new Error('Missing validated item');
        return `${item.name}, ${spokenSpecification(item.specification)}: ${spokenMoney(rate.finalRateMinor)}.`;
      }),
    };
  }

  async recordPricing(input: {
    tenantId: string;
    followupId: string;
    callSessionId: string;
    requirementId: string;
    requirementVersion: number;
    explicitConfirmation: true;
    confirmationToken?: string | undefined;
    discountBasisPoints?: number | null | undefined;
    items: PricingLine[];
  }): Promise<{ quotationId: string; idempotent: boolean }> {
    await this.assertCallContext(input.tenantId, input.followupId, input.callSessionId);
    const context = await this.getContext(input.tenantId, input.followupId);
    if (input.requirementId !== context.requirementId) {
      throw new AppError(
        'Requirement does not belong to this follow-up',
        403,
        'INVALID_REQUIREMENT',
      );
    }
    const tx = await this.db.transaction('write');
    try {
      const session = await tx.execute({
        sql: 'SELECT context_loaded_at FROM call_sessions WHERE id = ? AND tenant_id = ?',
        args: [input.callSessionId, input.tenantId],
      });
      if (!session.rows[0]?.context_loaded_at)
        throw new AppError(
          'Load follow-up context before collecting pricing',
          409,
          'CONTEXT_REQUIRED',
        );
      const requirementResult = await tx.execute({
        sql: `SELECT version FROM purchase_requirements
              WHERE id = ? AND tenant_id = ? AND status = 'open'`,
        args: [input.requirementId, input.tenantId],
      });
      const requirement = requirementResult.rows[0];
      if (!requirement)
        throw new AppError('Open requirement not found', 409, 'REQUIREMENT_NOT_OPEN');
      if (integer(requirement, 'version') !== input.requirementVersion) {
        throw new AppError('Requirement changed during the call', 409, 'STALE_REQUIREMENT');
      }

      const expectedResult = await tx.execute({
        sql: `SELECT id FROM purchase_requirement_items
              WHERE tenant_id = ? AND purchase_requirement_id = ? ORDER BY id`,
        args: [input.tenantId, input.requirementId],
      });
      const expectedIds = expectedResult.rows.map((row) => text(row, 'id')).sort();
      const suppliedIds = input.items.map((item) => item.requirementItemId).sort();
      if (
        expectedIds.length !== suppliedIds.length ||
        expectedIds.some((id, index) => id !== suppliedIds[index])
      ) {
        throw new AppError(
          'Pricing must include every requirement item exactly once',
          422,
          'INCOMPLETE_PRICING',
        );
      }
      if (new Set(suppliedIds).size !== suppliedIds.length) {
        throw new AppError('Duplicate requirement item', 422, 'DUPLICATE_PRICING_ITEM');
      }

      const preview = await tx.execute({
        sql: 'SELECT pricing_preview_hash, pricing_confirmation_token, pricing_preview_at FROM call_sessions WHERE id = ?',
        args: [input.callSessionId],
      });
      const draft = preview.rows[0];
      if (
        !input.confirmationToken ||
        draft?.pricing_confirmation_token !== input.confirmationToken ||
        draft?.pricing_preview_hash !== pricingHash(input)
      ) {
        throw new AppError(
          'Preview and read back these exact rates before confirmation',
          409,
          'PRICING_PREVIEW_REQUIRED',
        );
      }

      const previous = await tx.execute({
        sql: `SELECT id, discount_basis_points FROM supplier_quotations WHERE tenant_id = ? AND followup_job_id = ?`,
        args: [input.tenantId, input.followupId],
      });
      if (previous.rows[0]) {
        const saved = await tx.execute({
          sql: 'SELECT requirement_item_id, initial_rate_minor, revised_rate_minor, final_rate_minor FROM supplier_quotation_items WHERE quotation_id = ? ORDER BY requirement_item_id',
          args: [text(previous.rows[0], 'id')],
        });
        const same =
          pricingHash({
            ...input,
            discountBasisPoints:
              previous.rows[0].discount_basis_points === null
                ? null
                : Number(previous.rows[0].discount_basis_points),
            items: saved.rows.map((row) => ({
              requirementItemId: text(row, 'requirement_item_id'),
              initialRateMinor: integer(row, 'initial_rate_minor'),
              revisedRateMinor:
                row.revised_rate_minor === null ? null : integer(row, 'revised_rate_minor'),
              finalRateMinor: integer(row, 'final_rate_minor'),
              unit: 'KG',
            })),
          }) === pricingHash(input);
        if (!same)
          throw new AppError(
            'Different pricing has already been committed; do not claim an update',
            409,
            'PRICING_ALREADY_COMMITTED',
          );
        await tx.commit();
        return { quotationId: text(previous.rows[0], 'id'), idempotent: true };
      }
      if (
        typeof draft.pricing_preview_at !== 'string' ||
        Date.now() - Date.parse(draft.pricing_preview_at) > 10 * 60_000
      ) {
        throw new AppError(
          'Pricing preview expired; read back again',
          409,
          'PRICING_PREVIEW_EXPIRED',
        );
      }

      const quotationId = randomUUID();
      const now = new Date().toISOString();
      await tx.execute({
        sql: `INSERT INTO supplier_quotations(
                id, tenant_id, supplier_id, purchase_requirement_id, followup_job_id,
                status, discount_basis_points, confirmed_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`,
        args: [
          quotationId,
          input.tenantId,
          context.supplierId,
          input.requirementId,
          input.followupId,
          input.discountBasisPoints ?? null,
          now,
          now,
          now,
        ],
      });
      await tx.execute({
        sql: `INSERT INTO call_events(
                id, tenant_id, call_session_id, provider, provider_event_id,
                event_type, payload_redacted_json, occurred_at, received_at
              ) VALUES (?, ?, ?, 'agent_tool', ?, 'pricing_explicitly_confirmed', ?, ?, ?)`,
        args: [
          randomUUID(),
          input.tenantId,
          input.callSessionId,
          `pricing_confirmation:${input.callSessionId}`,
          JSON.stringify({ explicitConfirmation: input.explicitConfirmation }),
          now,
          now,
        ],
      });
      for (const item of input.items) {
        await tx.execute({
          sql: `INSERT INTO supplier_quotation_items(
                  id, tenant_id, quotation_id, requirement_item_id, initial_rate_minor,
                  revised_rate_minor, final_rate_minor, unit, vendor_confirmed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'KG', 1)`,
          args: [
            randomUUID(),
            input.tenantId,
            quotationId,
            item.requirementItemId,
            item.initialRateMinor,
            item.revisedRateMinor ?? null,
            item.finalRateMinor,
          ],
        });
      }
      await tx.execute({
        sql: `UPDATE followup_jobs SET status = 'completed', last_outcome = 'pricing_confirmed',
                updated_at = ? WHERE id = ? AND tenant_id = ?`,
        args: [now, input.followupId, input.tenantId],
      });
      await tx.execute({
        sql: `INSERT INTO call_outcomes(
                id, tenant_id, call_session_id, disposition, summary, supplier_confirmed,
                quotation_id, recorded_by, created_at, updated_at
              ) VALUES (?, ?, ?, 'pricing_confirmed', ?, 1, ?, 'agent_tool', ?, ?)
              ON CONFLICT(call_session_id) DO UPDATE SET
                disposition = excluded.disposition, summary = excluded.summary,
                supplier_confirmed = 1, quotation_id = excluded.quotation_id, updated_at = excluded.updated_at`,
        args: [
          randomUUID(),
          input.tenantId,
          input.callSessionId,
          'Vendor explicitly confirmed complete item-wise KG pricing.',
          quotationId,
          now,
          now,
        ],
      });
      await tx.commit();
      return { quotationId, idempotent: false };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  async scheduleCallback(input: {
    tenantId: string;
    followupId: string;
    callSessionId: string;
    callbackAt: string;
    reason: string;
  }): Promise<void> {
    await this.assertCallContext(input.tenantId, input.followupId, input.callSessionId);
    const now = new Date().toISOString();
    await this.db.batch(
      [
        {
          sql: `UPDATE followup_jobs
                SET status = 'callback_requested', next_attempt_at = ?, last_outcome = ?, updated_at = ?
                WHERE id = ? AND tenant_id = ?`,
          args: [input.callbackAt, input.reason, now, input.followupId, input.tenantId],
        },
        {
          sql: `INSERT INTO call_outcomes(
                  id, tenant_id, call_session_id, disposition, summary, callback_at,
                  supplier_confirmed, recorded_by, created_at, updated_at
                ) VALUES (?, ?, ?, 'callback_requested', ?, ?, 0, 'agent_tool', ?, ?)
                ON CONFLICT(call_session_id) DO UPDATE SET
                  disposition = excluded.disposition, summary = excluded.summary,
                  callback_at = excluded.callback_at, updated_at = excluded.updated_at`,
          args: [
            randomUUID(),
            input.tenantId,
            input.callSessionId,
            input.reason,
            input.callbackAt,
            now,
            now,
          ],
        },
      ],
      'write',
    );
  }

  async recordSupplierResponse(input: {
    tenantId: string;
    followupId: string;
    callSessionId: string;
    disposition: string;
    summary: string;
  }): Promise<void> {
    await this.assertCallContext(input.tenantId, input.followupId, input.callSessionId);
    const statusByDisposition: Record<string, string> = {
      quotation_will_be_sent: 'quotation_pending',
      cannot_supply: 'cannot_supply',
      not_interested: 'not_interested',
      opted_out: 'cancelled',
      wrong_contact: 'failed',
      requirement_not_received: 'pending',
      needs_more_information: 'pending',
    };
    const status = statusByDisposition[input.disposition];
    if (!status) throw new AppError('Unsupported disposition', 422, 'INVALID_DISPOSITION');
    const now = new Date().toISOString();
    await this.db.batch(
      [
        {
          sql: `UPDATE supplier_contacts SET call_consent_status = 'opted_out', updated_at = ?
                WHERE tenant_id = ? AND id = (SELECT supplier_contact_id FROM followup_jobs WHERE id = ? AND tenant_id = ?) AND ? = 'opted_out'`,
          args: [now, input.tenantId, input.followupId, input.tenantId, input.disposition],
        },
        {
          sql: `UPDATE followup_jobs SET status = 'cancelled', last_outcome = 'opted_out', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
                WHERE tenant_id = ? AND supplier_contact_id = (SELECT supplier_contact_id FROM followup_jobs WHERE id = ? AND tenant_id = ?)
                  AND status IN ('pending', 'leased', 'callback_requested') AND ? = 'opted_out'`,
          args: [now, input.tenantId, input.followupId, input.tenantId, input.disposition],
        },
        {
          sql: `UPDATE followup_jobs SET status = ?, last_outcome = ?, updated_at = ?
                WHERE id = ? AND tenant_id = ?`,
          args: [status, input.disposition, now, input.followupId, input.tenantId],
        },
        {
          sql: `INSERT INTO call_outcomes(
                  id, tenant_id, call_session_id, disposition, summary, supplier_confirmed,
                  recorded_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, 'agent_tool', ?, ?)
                ON CONFLICT(call_session_id) DO UPDATE SET
                  disposition = excluded.disposition, summary = excluded.summary, updated_at = excluded.updated_at`,
          args: [
            randomUUID(),
            input.tenantId,
            input.callSessionId,
            input.disposition,
            input.summary,
            now,
            now,
          ],
        },
      ],
      'write',
    );
  }

  async finalizeCall(input: {
    tenantId: string;
    followupId: string;
    callSessionId: string;
    disposition: string;
    summary: string;
  }): Promise<void> {
    await this.assertCallContext(input.tenantId, input.followupId, input.callSessionId);
    if (input.disposition === 'pricing_confirmed') {
      const quotation = await this.db.execute({
        sql: `SELECT 1 AS found FROM call_outcomes
              WHERE tenant_id = ? AND call_session_id = ? AND quotation_id IS NOT NULL AND supplier_confirmed = 1`,
        args: [input.tenantId, input.callSessionId],
      });
      if (!quotation.rows[0]) {
        throw new AppError('Pricing has not been committed', 409, 'PRICING_NOT_COMMITTED');
      }
    }
    const now = new Date().toISOString();
    await this.db.execute({
      sql: `INSERT INTO call_outcomes(
              id, tenant_id, call_session_id, disposition, summary, supplier_confirmed,
              recorded_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'agent_tool', ?, ?)
            ON CONFLICT(call_session_id) DO UPDATE SET
              disposition = excluded.disposition, summary = excluded.summary, updated_at = excluded.updated_at`,
      args: [
        randomUUID(),
        input.tenantId,
        input.callSessionId,
        input.disposition,
        input.summary,
        input.disposition === 'pricing_confirmed' ? 1 : 0,
        now,
        now,
      ],
    });
  }
}
