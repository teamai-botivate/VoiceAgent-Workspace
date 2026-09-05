import type { FastifyRequest } from 'fastify';
import { env, requireConfig } from '../config/env.js';
import { bearerToken, safeSecretEqual } from '../security/secrets.js';
import { AppError } from '../shared/errors.js';

export async function requireInternalAuth(request: FastifyRequest): Promise<void> {
  const expected = requireConfig('INTERNAL_API_TOKEN');
  if (!safeSecretEqual(bearerToken(request.headers.authorization), expected)) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
}

export async function requireAgentToolAuth(request: FastifyRequest): Promise<void> {
  const expected = requireConfig('AGENT_TOOL_SECRET');
  const actual = request.headers['x-agent-tool-secret'];
  if (!safeSecretEqual(typeof actual === 'string' ? actual : undefined, expected)) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
}

export async function requireLlmGatewayAuth(request: FastifyRequest): Promise<void> {
  const expected = requireConfig('LLM_GATEWAY_TOKEN');
  if (!safeSecretEqual(bearerToken(request.headers.authorization), expected)) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
}

export function readinessConfiguration(): Record<string, boolean> {
  return {
    databaseConfiguration: Boolean(
      env.TURSO_DATABASE_URL &&
        (env.TURSO_DATABASE_URL.startsWith('file:') || env.TURSO_AUTH_TOKEN),
    ),
    elevenlabs: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID),
    telephony: Boolean(
      env.ELEVENLABS_PHONE_NUMBER_ID ||
        (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER),
    ),
    internalAuth: Boolean(env.INTERNAL_API_TOKEN),
    agentToolAuth: Boolean(env.AGENT_TOOL_SECRET),
    publicUrl: Boolean(env.PUBLIC_BASE_URL),
    testPhoneAllowlist: env.allowedTestPhoneNumbers.size > 0,
  };
}
