import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

type AgentExport = {
  agent_id?: string;
  phone_numbers?: Array<{
    phone_number?: string;
    phone_number_id?: string;
  }>;
};

const envPath = new URL('../.env', import.meta.url);
const agentPath = new URL('../agent_config.json', import.meta.url);
const existing = await readFile(envPath, 'utf8');
const agent = JSON.parse(await readFile(agentPath, 'utf8')) as AgentExport;
const phone = agent.phone_numbers?.[0];

const lines = existing.split(/\r?\n/);
const indexByName = new Map<string, number>();
for (const [index, line] of lines.entries()) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
  if (match?.[1]) indexByName.set(match[1], index);
}

const changedNames: string[] = [];

function upsert(name: string, value: string): void {
  const index = indexByName.get(name);
  if (index === undefined) {
    if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
    indexByName.set(name, lines.length);
    lines.push(`${name}=${value}`);
    changedNames.push(name);
    return;
  }
  const current = lines[index]?.slice(name.length + 1) ?? '';
  if (current.length === 0 && value.length > 0) {
    lines[index] = `${name}=${value}`;
    changedNames.push(name);
  }
}

function secret(): string {
  return randomBytes(32).toString('base64url');
}

upsert('NODE_ENV', 'development');
upsert('HOST', '0.0.0.0');
upsert('PORT', '3100');
upsert('LOG_LEVEL', 'info');
upsert('PUBLIC_BASE_URL', '');
upsert('INTERNAL_API_TOKEN', secret());
upsert('AGENT_TOOL_SECRET', secret());
upsert('LLM_GATEWAY_TOKEN', secret());
upsert('ALLOWED_TEST_PHONE_NUMBERS', '');
upsert('SCHEDULER_ENABLED', 'false');
upsert('SCHEDULER_INTERVAL_MS', '15000');

upsert('ELEVENLABS_API_KEY', '');
upsert('ELEVENLABS_AGENT_ID', agent.agent_id ?? '');
upsert('ELEVENLABS_PHONE_NUMBER_ID', phone?.phone_number_id ?? '');
upsert('ELEVENLABS_WEBHOOK_SECRET', secret());
upsert('ELEVENLABS_RECORD_CALLS', 'false');

upsert('GROQ_BASE_URL', 'https://api.groq.com/openai/v1');
upsert('GROQ_MODEL', 'openai/gpt-oss-120b');
upsert('GROQ_REASONING_EFFORT', 'low');

upsert('TWILIO_ACCOUNT_SID', '');
upsert('TWILIO_AUTH_TOKEN', '');
upsert('TWILIO_PHONE_NUMBER', phone?.phone_number ?? '');
upsert('TWILIO_TRIAL_MODE', 'true');

await writeFile(envPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
process.stdout.write(`Initialized local configuration fields: ${changedNames.sort().join(', ')}\n`);
