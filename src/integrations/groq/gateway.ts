import type { FastifyReply, FastifyRequest } from 'fastify';
import { env, requireConfig } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';

const forbiddenRequestFields = new Set(['api_key', 'base_url']);

export async function proxyChatCompletion(
  request: FastifyRequest<{ Body: Record<string, unknown> }>,
  reply: FastifyReply,
): Promise<void> {
  const source = request.body;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new AppError('Expected a JSON object', 400, 'INVALID_LLM_REQUEST');
  }
  for (const field of forbiddenRequestFields) {
    if (field in source)
      throw new AppError(`Forbidden field: ${field}`, 400, 'INVALID_LLM_REQUEST');
  }
  if (!Array.isArray(source.messages)) {
    throw new AppError('messages must be an array', 400, 'INVALID_LLM_REQUEST');
  }

  const upstreamBody = {
    ...source,
    model: env.GROQ_MODEL,
    stream: true,
    reasoning_effort: env.GROQ_REASONING_EFFORT,
  };
  const upstream = await fetch(`${env.GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireConfig('GROQ_API_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(60_000),
  });

  if (!upstream.ok || !upstream.body) {
    throw new AppError(
      `Groq request failed with HTTP ${upstream.status}`,
      502,
      'GROQ_UPSTREAM_ERROR',
    );
  }

  reply.hijack();
  reply.raw.statusCode = 200;
  reply.raw.setHeader('content-type', 'text/event-stream');
  reply.raw.setHeader('cache-control', 'no-cache, no-transform');
  reply.raw.setHeader('connection', 'keep-alive');

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!reply.raw.write(value)) {
        await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
      }
    }
  } finally {
    reader.releaseLock();
    reply.raw.end();
  }
}
