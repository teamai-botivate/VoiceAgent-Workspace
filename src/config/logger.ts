import type { LoggerOptions } from 'pino';
import pino from 'pino';
import { env } from './env.js';

export const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.x-api-key',
      'req.headers.x-agent-tool-secret',
      'req.headers.elevenlabs-signature',
      '*.authToken',
      '*.apiKey',
      '*.token',
      '*.phone',
      '*.phoneNumber',
      '*.toNumber',
      '*.transcript',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'voice-agent-demo',
    environment: env.NODE_ENV,
  },
};

export const logger = pino(loggerOptions);
