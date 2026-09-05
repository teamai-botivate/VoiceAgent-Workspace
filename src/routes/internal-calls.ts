import type { FastifyInstance } from 'fastify';
import type { FollowupRepository } from '../domains/followups/repository.js';
import { startCallSchema } from '../domains/followups/schemas.js';
import { ElevenLabsCallService } from '../integrations/elevenlabs/client.js';
import { requireInternalAuth } from './auth.js';

export async function internalCallRoutes(
  app: FastifyInstance,
  repository: FollowupRepository,
): Promise<void> {
  const callService = new ElevenLabsCallService(repository);

  app.post('/internal/calls', { preHandler: requireInternalAuth }, async (request, reply) => {
    const input = startCallSchema.parse(request.body);
    const result = await callService.startCall(input);
    return reply.code(result.idempotent ? 200 : 202).send({ success: true, data: result });
  });

  app.get<{
    Params: { callSessionId: string };
    Querystring: { tenantId: string };
  }>('/internal/calls/:callSessionId', { preHandler: requireInternalAuth }, async (request) => {
    const session = await repository.getCallSession(
      request.query.tenantId,
      request.params.callSessionId,
    );
    return { success: true, data: session };
  });
}
