import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowupRepository } from '../src/domains/followups/repository.js';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('twilio', () => ({ default: vi.fn(() => ({ calls: { create: mocks.create } })) }));

describe('outbound side-effect safety', () => {
  let Service: typeof import('../src/integrations/elevenlabs/client.js').ElevenLabsCallService;
  const repository = {
    assertApprovedDestination: vi.fn(),
    createCallSession: vi.fn(),
    getCallSession: vi.fn(),
    getContext: vi.fn(),
    markCallInitiating: vi.fn(),
    attachProviderCall: vi.fn(),
    holdUncertainCall: vi.fn(),
    markCallFailed: vi.fn(),
  };
  const input = {
    tenantId: 'tenant',
    followupId: 'followup',
    toNumber: '+910000000000',
    idempotencyKey: 'one-test-attempt',
  };
  beforeAll(async () => {
    vi.stubEnv('ALLOWED_TEST_PHONE_NUMBERS', input.toNumber);
    vi.stubEnv('ELEVENLABS_PHONE_NUMBER_ID', '');
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACtest');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'test-token');
    vi.stubEnv('TWILIO_PHONE_NUMBER', '+12025550123');
    vi.stubEnv('TWILIO_TRIAL_MODE', 'true');
    vi.stubEnv('PUBLIC_BASE_URL', 'https://demo.example.test');
    Service = (await import('../src/integrations/elevenlabs/client.js')).ElevenLabsCallService;
  });
  beforeEach(() => {
    vi.resetAllMocks();
    repository.createCallSession.mockResolvedValue({ id: 'session', existing: false });
    repository.getContext.mockResolvedValue({ tenantName: 'Demo' });
    mocks.create.mockResolvedValue({ sid: 'CAcreated' });
  });
  const service = () => new Service(repository as unknown as FollowupRepository);

  it('requests lifecycle callbacks for trial calls too', async () => {
    await service().startCall(input);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      statusCallback: 'https://demo.example.test/webhooks/twilio/status',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });
  });

  it('holds an ambiguous timeout instead of scheduling another call', async () => {
    mocks.create.mockRejectedValue(new Error('Request timed out'));
    await expect(service().startCall(input)).rejects.toThrow('Request timed out');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(repository.holdUncertainCall).toHaveBeenCalledOnce();
    expect(repository.markCallFailed).not.toHaveBeenCalled();
  });

  it('does not redial after provider success followed by database attachment failure', async () => {
    repository.attachProviderCall.mockRejectedValue(new Error('Database unavailable'));
    await expect(service().startCall(input)).rejects.toThrow('Database unavailable');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(repository.holdUncertainCall).toHaveBeenCalledOnce();
    expect(repository.markCallFailed).not.toHaveBeenCalled();
  });

  it('returns the existing session without dialing on idempotent retries', async () => {
    repository.createCallSession.mockResolvedValue({ id: 'session', existing: true });
    repository.getCallSession.mockResolvedValue({
      id: 'session',
      status: 'initiating',
      callSid: null,
      conversationId: null,
    });
    expect(await service().startCall(input)).toMatchObject({
      idempotent: true,
      status: 'initiating',
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
