import type { FastifyInstance } from 'fastify';
import { proxyChatCompletion } from '../integrations/groq/gateway.js';
import { requireLlmGatewayAuth } from './auth.js';

export async function llmGatewayRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Record<string, unknown> }>(
    '/v1/chat/completions',
    { preHandler: requireLlmGatewayAuth },
    proxyChatCompletion,
  );
}
