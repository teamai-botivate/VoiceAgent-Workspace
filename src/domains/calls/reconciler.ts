import twilio from 'twilio';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { FollowupRepository } from '../followups/repository.js';

/** Read-only provider lookups: never retry a dial with an uncertain outcome. */
export class CallReconciler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopping = false;
  private completion: Promise<void> = Promise.resolve();
  constructor(private readonly repository: FollowupRepository) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.completion;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let complete = () => {};
    this.completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    try {
      await this.repository.replayProviderEvents();
      for (const call of await this.repository.callsNeedingReconciliation()) {
        if (this.stopping) break;
        try {
          if (call.conversationId && env.ELEVENLABS_API_KEY) {
            const response = await fetch(
              `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(call.conversationId)}`,
              {
                headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
                signal: AbortSignal.timeout(10_000),
              },
            );
            if (!response.ok) throw new Error(`Conversation lookup HTTP ${response.status}`);
            const data = (await response.json()) as {
              status?: string;
              metadata?: { call_duration_secs?: number; termination_reason?: string };
            };
            if (data.status === 'done' || data.status === 'failed') {
              await this.repository.recordProviderEvent({
                provider: 'elevenlabs',
                providerEventId: `reconcile:${call.conversationId}:${data.status}`,
                eventType: 'reconciliation',
                callSessionId: call.id,
                conversationId: call.conversationId,
                status: data.status === 'done' ? 'completed' : 'failed',
                durationSeconds: data.metadata?.call_duration_secs,
                failureMessage:
                  data.status === 'failed' ? data.metadata?.termination_reason : undefined,
                payload: { status: data.status },
                occurredAt: new Date().toISOString(),
              });
            }
          }
          if (call.callSid && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
            const remote = await twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, {
              timeout: 10_000,
              autoRetry: false,
            })
              .calls(call.callSid)
              .fetch();
            const status = remote.status.replaceAll('-', '_').replace('canceled', 'cancelled');
            await this.repository.recordProviderEvent({
              provider: 'twilio',
              providerEventId: `reconcile:${call.callSid}:${status}`,
              eventType: 'reconciliation',
              callSessionId: call.id,
              callSid: call.callSid,
              status: status === 'queued' ? 'initiated' : status,
              durationSeconds: remote.duration ? Number(remote.duration) : undefined,
              payload: { status },
              occurredAt: remote.endTime?.toISOString() ?? new Date().toISOString(),
            });
          }
          if (!call.callSid && !call.conversationId)
            logger.warn(
              { callSessionId: call.id },
              'Call initiation needs manual review; automatic redial suppressed',
            );
        } catch {
          logger.warn(
            { callSessionId: call.id },
            'Provider reconciliation failed; will retry lookup, not dial',
          );
        }
      }
    } catch {
      logger.error('Call reconciliation failed');
    } finally {
      this.running = false;
      complete();
    }
  }
}
