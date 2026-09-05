import type { FastifyInstance } from 'fastify';
import { checkDatabase } from '../db/client.js';
import { readinessConfiguration } from './auth.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    const configuration = readinessConfiguration();
    let database = false;
    if (configuration.databaseConfiguration) {
      try {
        await checkDatabase();
        database = true;
      } catch {
        database = false;
      }
    }
    const checks = { ...configuration, database };
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
}
