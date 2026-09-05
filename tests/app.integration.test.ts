import { createHmac, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrations.js';
import { seedDemoData } from '../src/db/seed.js';

describe('HTTP service', () => {
  const databasePath = join(tmpdir(), `voice-agent-app-test-${randomUUID()}.sqlite`);
  const database = createClient({ url: `file:${databasePath}` });
  let app: Awaited<ReturnType<typeof import('../src/app.js')['buildApp']>>;

  beforeAll(async () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'internal-api-test-token');
    vi.stubEnv('AGENT_TOOL_SECRET', 'agent-tool-test-secret');
    vi.stubEnv('LLM_GATEWAY_TOKEN', 'llm-gateway-test-token');
    vi.stubEnv('ELEVENLABS_WEBHOOK_SECRET', 'webhook-test-secret-1234');
    const { buildApp } = await import('../src/app.js');
    await runMigrations(database);
    await seedDemoData(database);
    app = await buildApp({ database, loggerEnabled: false });
    await app.ready();
  });

  afterAll(async () => {
    // Guarded so that a failure inside beforeAll reports its own cause instead of
    // being masked by a TypeError raised here.
    await app?.close();
    database.close();
    vi.unstubAllEnvs();
    try {
      unlinkSync(databasePath);
    } catch {
      // The temporary database may already be absent after a failed setup.
    }
  });

  it('serves liveness without provider access', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('rejects an unauthenticated agent tool request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agent-tools/followup-context',
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('returns tenant-scoped context to an authenticated agent call', async () => {
    const repository = app.voiceAgentRepository;
    const session = await repository.createCallSession({
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      idempotencyKey: 'http-context-test',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/agent-tools/followup-context',
      headers: { 'x-agent-tool-secret': 'agent-tool-test-secret' },
      payload: {
        tenantId: 'tenant_demo_ram',
        followupId: 'followup_demo_001',
        callSessionId: session.id,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: { requirementNumber: 'PR-DEMO-2026-001' },
    });
  });

  it('records a signed failed conversation as failure rather than completion', async () => {
    const session = await app.voiceAgentRepository.createCallSession({
      tenantId: 'tenant_demo_ram',
      followupId: 'followup_demo_001',
      idempotencyKey: 'http-context-test',
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      type: 'post_call_transcription',
      event_timestamp: timestamp,
      data: {
        conversation_id: 'conv_failed_regression',
        status: 'failed',
        metadata: { call_duration_secs: 79, termination_reason: 'custom_llm generation failed' },
        conversation_initiation_client_data: { dynamic_variables: { call_session_id: session.id } },
      },
    });
    const signature = createHmac('sha256', 'webhook-test-secret-1234')
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/elevenlabs/post-call',
      headers: {
        'content-type': 'application/json',
        'elevenlabs-signature': `t=${timestamp},v0=${signature}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(
      (await app.voiceAgentRepository.getCallSession('tenant_demo_ram', session.id)).status,
    ).toBe('failed');
  });

  it('rejects an unsigned provider webhook', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/elevenlabs/post-call',
      payload: { type: 'post_call_transcription' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('durably acknowledges a signed callback before its call can be correlated', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      type: 'post_call_transcription',
      event_timestamp: timestamp,
      data: { conversation_id: 'conv_not_attached_yet', status: 'done' },
    });
    const signature = createHmac('sha256', 'webhook-test-secret-1234')
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/elevenlabs/post-call',
      headers: {
        'content-type': 'application/json',
        'elevenlabs-signature': `t=${timestamp},v0=${signature}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(
      (
        await database.execute(
          'SELECT COUNT(*) AS count FROM provider_event_inbox WHERE processed_at IS NULL',
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
});
