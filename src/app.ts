import formBody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import type { Client } from '@libsql/client';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import rawBody from 'fastify-raw-body';
import { ZodError } from 'zod';
import { loggerOptions } from './config/logger.js';
import { enableForeignKeys, getDatabase } from './db/client.js';
import { FollowupRepository } from './domains/followups/repository.js';
import { agentToolRoutes } from './routes/agent-tools.js';
import { healthRoutes } from './routes/health.js';
import { internalCallRoutes } from './routes/internal-calls.js';
import { llmGatewayRoutes } from './routes/llm-gateway.js';
import { providerWebhookRoutes } from './routes/provider-webhooks.js';
import { AppError } from './shared/errors.js';

export type BuildAppOptions = {
  database?: Client;
  loggerEnabled?: boolean;
};

declare module 'fastify' {
  interface FastifyInstance {
    voiceAgentRepository: FollowupRepository;
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const commonOptions = {
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    bodyLimit: 256 * 1024,
    requestIdHeader: 'x-request-id',
  } as const;
  const app = Fastify({
    ...commonOptions,
    logger: options.loggerEnabled === false ? false : loggerOptions,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', issues: error.issues },
        requestId: request.id,
      });
    }
    if (error instanceof AppError) {
      request.log.warn({ code: error.code, statusCode: error.statusCode }, 'Request failed');
      return reply.code(error.statusCode).send({
        success: false,
        error: { code: error.code, message: error.message, details: error.details },
        requestId: request.id,
      });
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.code(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      requestId: request.id,
    });
  });

  // Provider callbacks are the only evidence that an outbound call progressed, and a
  // callback that never arrives is indistinguishable from one that arrived and failed
  // unless every inbound request is recorded. Fastify's own request logging stays off
  // so this stays a single line per request.
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
      },
      'request completed',
    );
  });

  await app.register(formBody);
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
  });

  const database = options.database ?? getDatabase();
  await enableForeignKeys(database);
  const repository = new FollowupRepository(database);
  app.decorate('voiceAgentRepository', repository);
  await app.register(healthRoutes);
  await app.register(async (instance) => internalCallRoutes(instance, repository));
  await app.register(async (instance) => agentToolRoutes(instance, repository));
  await app.register(llmGatewayRoutes);
  await app.register(async (instance) => providerWebhookRoutes(instance, repository));

  return app;
}
