import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase } from './db/client.js';
import { CallReconciler } from './domains/calls/reconciler.js';
import { CallScheduler } from './domains/calls/scheduler.js';
import { ElevenLabsCallService } from './integrations/elevenlabs/client.js';

const app = await buildApp();
const scheduler = new CallScheduler(
  app.voiceAgentRepository,
  new ElevenLabsCallService(app.voiceAgentRepository),
);
let closing = false;
const reconciler = new CallReconciler(app.voiceAgentRepository);

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'Shutting down');
  scheduler.stop();
  await reconciler.stop();
  await app.close();
  await closeDatabase();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
  scheduler.start();
  reconciler.start();
} catch (error) {
  logger.fatal({ err: error }, 'Server failed to start');
  await shutdown('startup_failure');
  process.exitCode = 1;
}
