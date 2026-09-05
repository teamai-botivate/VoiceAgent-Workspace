import 'dotenv/config';
import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(16).optional(),
);
const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  PUBLIC_BASE_URL: optionalUrl,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  INTERNAL_API_TOKEN: optionalSecret,
  AGENT_TOOL_SECRET: optionalSecret,
  LLM_GATEWAY_TOKEN: optionalSecret,
  ALLOWED_TEST_PHONE_NUMBERS: z.string().default(''),
  SCHEDULER_ENABLED: booleanFromString,
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(15_000),

  TURSO_DATABASE_URL: optionalString,
  TURSO_AUTH_TOKEN: optionalString,
  TURSO_DATABASE_TOKEN: optionalString,

  ELEVENLABS_API_KEY: optionalString,
  ELLEVENLABS_API_KEY: optionalString,
  ELEVENLABS_AGENT_ID: optionalString,
  ELEVENLABS_PHONE_NUMBER_ID: optionalString,
  ELEVENLABS_WEBHOOK_SECRET: optionalSecret,
  ELEVENLABS_RECORD_CALLS: booleanFromString,

  GROQ_API_KEY: optionalString,
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),

  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_PHONE_NUMBER: optionalString,
  TWILIO_TRIAL_MODE: booleanFromString,
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment configuration:\n${details.join('\n')}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  TURSO_AUTH_TOKEN: raw.TURSO_AUTH_TOKEN ?? raw.TURSO_DATABASE_TOKEN,
  ELEVENLABS_API_KEY: raw.ELEVENLABS_API_KEY ?? raw.ELLEVENLABS_API_KEY,
  allowedTestPhoneNumbers: new Set(
    raw.ALLOWED_TEST_PHONE_NUMBERS.split(',')
      .map((phone) => phone.trim())
      .filter(Boolean),
  ),
} as const;

export type Environment = typeof env;

export function requireConfig<K extends keyof Environment>(key: K): NonNullable<Environment[K]> {
  const value = env[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required configuration: ${String(key)}`);
  }
  return value as NonNullable<Environment[K]>;
}
