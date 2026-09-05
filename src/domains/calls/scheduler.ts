import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { ElevenLabsCallService } from '../../integrations/elevenlabs/client.js';
import { errorMessage } from '../../shared/errors.js';
import type { FollowupRepository } from '../followups/repository.js';

export class CallScheduler {
  private readonly workerId = `local-${randomUUID()}`;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly repository: FollowupRepository,
    private readonly callService: ElevenLabsCallService,
  ) {}

  start(): void {
    if (!env.SCHEDULER_ENABLED || this.timer) return;
    this.timer = setInterval(() => void this.tick(), env.SCHEDULER_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
    logger.info({ intervalMs: env.SCHEDULER_INTERVAL_MS }, 'Autonomous call scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const job = await this.repository.leaseNextDueFollowup(this.workerId);
      if (!job) return;
      if (!env.allowedTestPhoneNumbers.has(job.phoneNumber)) {
        await this.repository.releaseLease(job.tenantId, job.followupId, 'phone_not_allowlisted');
        logger.warn(
          { followupId: job.followupId },
          'Skipped non-allowlisted scheduled destination',
        );
        return;
      }
      await this.callService.startCall({
        tenantId: job.tenantId,
        followupId: job.followupId,
        toNumber: job.phoneNumber,
        idempotencyKey: `scheduler:${job.followupId}:attempt:${job.attemptNumber}`,
      });
    } catch (error) {
      logger.error({ error: errorMessage(error) }, 'Scheduler tick failed');
    } finally {
      this.running = false;
    }
  }
}
