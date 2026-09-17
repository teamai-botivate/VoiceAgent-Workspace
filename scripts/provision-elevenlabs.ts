import { mkdir, readFile, writeFile } from 'node:fs/promises';
import 'dotenv/config';

const apiBase = 'https://api.elevenlabs.io';
const apiKey = required('ELEVENLABS_API_KEY');
const publicBaseUrl = required('PUBLIC_BASE_URL').replace(/\/+$/, '');
const createNewAgent = process.argv.includes('--create-new');
const managedToolIds = new Set<string>();
const agentName = 'Pratap - AutoRocket Purchase Follow-up Demo';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'xi-api-key': apiKey,
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs ${path} failed with HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

type StoredSecret = { secret_id: string; name: string };
type StoredTool = { id: string; tool_config: { name: string; api_schema?: { url?: string } } };
type PronunciationDictionary = {
  id: string;
  name: string;
  latest_version_id?: string;
  version_id?: string;
};

const pronunciationRules = [
  { type: 'alias', string_to_replace: 'AutoRocket', alias: 'Auto Rocket' },
  { type: 'alias', string_to_replace: 'GST', alias: 'G S T' },
  { type: 'alias', string_to_replace: 'KG', alias: 'kilograms' },
  { type: 'alias', string_to_replace: 'PR', alias: 'P R' },
  { type: 'alias', string_to_replace: 'RFQ', alias: 'R F Q' },
  { type: 'alias', string_to_replace: 'LLP', alias: 'L L P' },
  { type: 'alias', string_to_replace: 'MS', alias: 'M S' },
  { type: 'alias', string_to_replace: 'GI', alias: 'G I' },
  { type: 'alias', string_to_replace: 'IS', alias: 'I S' },
  { type: 'alias', string_to_replace: 'EN8', alias: 'E N eight' },
  { type: 'alias', string_to_replace: 'EN19', alias: 'E N nineteen' },
  { type: 'alias', string_to_replace: 'M8', alias: 'M eight' },
  { type: 'alias', string_to_replace: 'M10', alias: 'M ten' },
  { type: 'alias', string_to_replace: 'M12', alias: 'M twelve' },
  { type: 'alias', string_to_replace: 'M16', alias: 'M sixteen' },
  { type: 'alias', string_to_replace: 'mm', alias: 'millimetres' },
];

async function ensureSecret(name: string, value: string): Promise<StoredSecret> {
  const listed = await api<{ secrets: StoredSecret[] }>(
    `/v1/convai/secrets?search=${encodeURIComponent(name)}&page_size=100`,
  );
  const existing = listed.secrets.find((secret) => secret.name === name);
  if (existing) {
    await api(`/v1/convai/secrets/${existing.secret_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ type: 'update', name, value }),
    });
    return existing;
  }
  return api<StoredSecret>('/v1/convai/secrets', {
    method: 'POST',
    body: JSON.stringify({ type: 'new', name, value }),
  });
}

async function ensurePronunciationDictionary(): Promise<{
  pronunciation_dictionary_id: string;
  version_id: string;
} | null> {
  const configuredId = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID;
  const configuredVersion = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID;
  if (configuredId && configuredVersion) {
    return {
      pronunciation_dictionary_id: configuredId,
      version_id: configuredVersion,
    };
  }
  const name = 'AutoRocket Procurement Terms';
  let listed: { pronunciation_dictionaries: PronunciationDictionary[] };
  try {
    listed = await api<{ pronunciation_dictionaries: PronunciationDictionary[] }>(
      '/v1/pronunciation-dictionaries?page_size=100&include_archived=false',
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('pronunciation_dictionaries_read')) {
      process.stderr.write(
        'Skipping pronunciation dictionary: ElevenLabs API key lacks dictionary permissions.\n',
      );
      return null;
    }
    throw error;
  }
  const existing = listed.pronunciation_dictionaries.find((dictionary) => dictionary.name === name);
  const dictionary = existing
    ? await api<{ id: string; version_id: string }>(
        `/v1/pronunciation-dictionaries/${existing.id}/set-rules`,
        { method: 'POST', body: JSON.stringify({ rules: pronunciationRules }) },
      )
    : await api<{ id: string; version_id: string }>(
        '/v1/pronunciation-dictionaries/add-from-rules',
        {
          method: 'POST',
          body: JSON.stringify({
            name,
            description: 'Spoken forms for AutoRocket purchase follow-up terminology.',
            rules: pronunciationRules,
          }),
        },
      );
  return {
    pronunciation_dictionary_id: dictionary.id,
    version_id: dictionary.version_id,
  };
}

const dynamicContext = {
  tenantId: { type: 'string', dynamic_variable: 'tenant_id' },
  followupId: { type: 'string', dynamic_variable: 'followup_id' },
  callSessionId: { type: 'string', dynamic_variable: 'call_session_id' },
};

function literal(
  type: 'string' | 'integer' | 'number' | 'boolean',
  description: string,
  enumValues?: string[],
): Record<string, unknown> {
  return { type, description, ...(enumValues ? { enum: enumValues } : {}) };
}

function objectSchema(
  properties: Record<string, unknown>,
  requiredProperties: string[],
  description = '',
): Record<string, unknown> {
  return {
    type: 'object',
    property_kind: 'object',
    description,
    properties,
    required: requiredProperties,
  };
}

function toolDefinitions(toolSecretId: string): Array<{
  name: string;
  description: string;
  path: string;
  schema: Record<string, unknown>;
}> {
  const contextRequired = ['tenantId', 'followupId', 'callSessionId'];
  const definitions = [
    {
      name: 'get_followup_context',
      description:
        'Load the authoritative supplier, requirement, and complete item data at the start of this purchase follow-up call. Call before stating mutable business data.',
      path: '/agent-tools/followup-context',
      schema: objectSchema(dynamicContext, contextRequired),
    },
    {
      name: 'get_business_answer',
      description:
        'Retrieve one approved business-policy answer when the supplier asks about delivery, payment, GST, quotation validity, or commercial unit.',
      path: '/agent-tools/business-answer',
      schema: objectSchema(
        {
          ...dynamicContext,
          questionCategory: literal(
            'string',
            'The approved policy category requested by the supplier.',
            [
              'delivery_location',
              'payment_terms',
              'gst_policy',
              'quotation_validity',
              'commercial_unit',
            ],
          ),
        },
        [...contextRequired, 'questionCategory'],
      ),
    },
    {
      name: 'record_pricing_outcome',
      description:
        'Store complete item-wise KG pricing only after the supplier clearly confirms the repeated final rates. Include every requirement item exactly once and use integer paise.',
      path: '/agent-tools/pricing-outcome',
      schema: objectSchema(
        {
          ...dynamicContext,
          requirementId: literal('string', 'Requirement ID returned by get_followup_context.'),
          requirementVersion: literal(
            'integer',
            'Requirement version returned by get_followup_context.',
          ),
          explicitConfirmation: literal(
            'boolean',
            'True only after a clear affirmative response to the exact preview readback; never infer confirmation from silence.',
          ),
          confirmationToken: literal(
            'string',
            'Exact token returned by preview_pricing for these unchanged rates.',
          ),
          discountBasisPoints: literal(
            'integer',
            'Optional confirmed overall discount in basis points; omit when none was stated.',
          ),
          items: {
            type: 'array',
            property_kind: 'array',
            description: 'The supplier-confirmed pricing for every requirement item exactly once.',
            items: objectSchema(
              {
                requirementItemId: literal(
                  'string',
                  'Exact requirement item ID returned by get_followup_context.',
                ),
                initialRateMinor: literal(
                  'integer',
                  'Initial supplier rate in integer paise per KG.',
                ),
                revisedRateMinor: literal(
                  'integer',
                  'Optional revised rate in integer paise per KG; omit if unchanged.',
                ),
                finalRateMinor: literal(
                  'integer',
                  'Explicitly confirmed final rate in integer paise per KG.',
                ),
                unit: { type: 'string', constant_value: 'KG' },
              },
              ['requirementItemId', 'initialRateMinor', 'finalRateMinor', 'unit'],
            ),
          },
        },
        [
          ...contextRequired,
          'requirementId',
          'requirementVersion',
          'explicitConfirmation',
          'confirmationToken',
          'items',
        ],
      ),
    },
    {
      name: 'schedule_callback',
      description:
        'Schedule a callback only when the supplier asks to be called later and provides or agrees to a specific time.',
      path: '/agent-tools/schedule-callback',
      schema: objectSchema(
        {
          ...dynamicContext,
          callbackAt: literal(
            'string',
            'Supplier-agreed callback time as an ISO-8601 timestamp including timezone offset.',
          ),
          reason: literal('string', 'Brief factual reason supplied for the callback.'),
        },
        [...contextRequired, 'callbackAt', 'reason'],
      ),
    },
    {
      name: 'record_supplier_response',
      description:
        'Record a non-pricing supplier response such as quotation later, cannot supply, not interested, wrong contact, requirement missing, or needing more information.',
      path: '/agent-tools/supplier-response',
      schema: objectSchema(
        {
          ...dynamicContext,
          disposition: literal('string', 'The factual supplier response category.', [
            'quotation_will_be_sent',
            'cannot_supply',
            'not_interested',
            'opted_out',
            'wrong_contact',
            'requirement_not_received',
            'needs_more_information',
          ]),
          summary: literal(
            'string',
            'Concise factual summary using only information the supplier stated.',
          ),
        },
        [...contextRequired, 'disposition', 'summary'],
      ),
    },
    {
      name: 'finalize_call',
      description:
        'Save the final call disposition before ending. pricing_confirmed is accepted only after record_pricing_outcome succeeds.',
      path: '/agent-tools/finalize-call',
      schema: objectSchema(
        {
          ...dynamicContext,
          disposition: literal('string', 'The final call disposition.', [
            'pricing_confirmed',
            'callback_requested',
            'quotation_pending',
            'cannot_supply',
            'not_interested',
            'opted_out',
            'wrong_contact',
            'no_answer',
            'failed',
          ]),
          summary: literal('string', 'Concise factual summary of the completed call.'),
        },
        [...contextRequired, 'disposition', 'summary'],
      ),
    },
  ].map((definition) => ({
    ...definition,
    secretId: toolSecretId,
  }));
  const pricing = definitions.find((definition) => definition.name === 'record_pricing_outcome');
  if (!pricing) throw new Error('Missing pricing tool definition');
  const properties = { ...(pricing.schema.properties as Record<string, unknown>) };
  delete properties.explicitConfirmation;
  delete properties.confirmationToken;
  definitions.push({
    ...pricing,
    name: 'preview_pricing',
    path: '/agent-tools/pricing-preview',
    description:
      'Prepare complete pricing before confirmation. Read every returned line aloud, ask for confirmation, and only then call record_pricing_outcome. A correction requires a new preview.',
    schema: objectSchema(
      properties,
      (pricing.schema.required as string[]).filter(
        (name) => name !== 'explicitConfirmation' && name !== 'confirmationToken',
      ),
    ),
  });
  return definitions;
}

async function ensureTools(toolSecretId: string): Promise<StoredTool[]> {
  const listed = await api<{ tools: StoredTool[] }>('/v1/convai/tools');
  const results: StoredTool[] = [];
  for (const definition of toolDefinitions(toolSecretId)) {
    const existing = listed.tools.find(
      (tool) =>
        tool.tool_config.name === definition.name &&
        (managedToolIds.has(tool.id) ||
          tool.tool_config.api_schema?.url === `${publicBaseUrl}${definition.path}`),
    );
    results.push(
      await api<StoredTool>(existing ? `/v1/convai/tools/${existing.id}` : '/v1/convai/tools', {
        method: existing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          tool_config: {
            type: 'webhook',
            name: definition.name,
            description: definition.description,
            response_timeout_secs: 15,
            interruption_mode: 'disable_during_tool',
            pre_tool_speech: 'auto',
            execution_mode: 'immediate',
            api_schema: {
              url: `${publicBaseUrl}${definition.path}`,
              method: 'POST',
              content_type: 'application/json',
              request_headers: {
                'X-Agent-Tool-Secret': { secret_id: toolSecretId },
              },
              request_body_schema: definition.schema,
            },
          },
        }),
      }),
    );
  }
  return results;
}

async function ensureAgent(
  tools: StoredTool[],
  pronunciationDictionary: {
    pronunciation_dictionary_id: string;
    version_id: string;
  } | null,
): Promise<string> {
  const exported = JSON.parse(
    await readFile(new URL('../agent_config.json', import.meta.url), 'utf8'),
  );
  const agentPayload = {
    name: agentName,
    tags: ['autorocket', 'purchase-followup', 'local-demo'],
    conversation_config: {
      turn: exported.conversation_config.turn,
      asr: {
        ...exported.conversation_config.asr,
        user_input_audio_format: 'ulaw_8000',
      },
      tts: {
        ...exported.conversation_config.tts,
        agent_output_audio_format: 'ulaw_8000',
        pronunciation_dictionary_locators: pronunciationDictionary ? [pronunciationDictionary] : [],
      },
      conversation: {
        text_only: false,
        max_duration_seconds: 600,
        monitoring_enabled: false,
      },
      agent: {
        first_message: exported.conversation_config.agent.first_message,
        language: exported.conversation_config.agent.language,
        hinglish_mode: exported.conversation_config.agent.hinglish_mode,
        dynamic_variables: exported.conversation_config.agent.dynamic_variables,
        prompt: {
          prompt: exported.conversation_config.agent.prompt.prompt,
          llm: exported.conversation_config.agent.prompt.llm,
          temperature: 0.25,
          max_tokens: -1,
          tool_ids: tools.map((tool) => tool.id),
          custom_llm: null,
          ignore_default_personality: true,
          timezone: 'Asia/Kolkata',
          backup_llm_config: exported.conversation_config.agent.prompt.backup_llm_config,
        },
      },
    },
    platform_settings: {
      call_limits: {
        agent_concurrency_limit: 1,
        daily_limit: 5,
        bursting_enabled: false,
      },
      privacy: {
        record_voice: false,
        retention_days: 7,
        delete_transcript_and_pii: false,
        delete_audio: true,
        apply_to_existing_conversations: false,
        zero_retention_mode: false,
      },
      trust_context: 'low',
    },
  };
  const configuredId = createNewAgent ? undefined : process.env.ELEVENLABS_AGENT_ID;
  if (configuredId) {
    const response = await fetch(`${apiBase}/v1/convai/agents/${configuredId}`, {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      await api(`/v1/convai/agents/${configuredId}`, {
        method: 'PATCH',
        body: JSON.stringify(agentPayload),
      });
      return configuredId;
    }
    throw new Error(
      `Configured agent could not be read (HTTP ${response.status}); refusing to create a replacement implicitly`,
    );
  }
  const created = await api<{ agent_id: string }>('/v1/convai/agents/create', {
    method: 'POST',
    body: JSON.stringify(agentPayload),
  });
  return created.agent_id;
}

async function ensurePostCallWebhook(): Promise<{ id: string; secret?: string }> {
  const targetUrl = `${publicBaseUrl}/webhooks/elevenlabs/post-call`;
  const listed = await api<{
    webhooks: Array<{ webhook_id: string; name: string; webhook_url: string }>;
  }>('/v1/workspace/webhooks');
  const existing = listed.webhooks.find((webhook) => webhook.webhook_url === targetUrl);
  if (existing && process.env.ELEVENLABS_WEBHOOK_SECRET) return { id: existing.webhook_id };
  const created = await api<{ webhook_id: string; webhook_secret?: string }>(
    '/v1/workspace/webhooks',
    {
      method: 'POST',
      body: JSON.stringify({
        settings: {
          auth_type: 'hmac',
          name: 'AutoRocket Voice Agent Local',
          webhook_url: targetUrl,
        },
      }),
    },
  );
  return {
    id: created.webhook_id,
    ...(created.webhook_secret ? { secret: created.webhook_secret } : {}),
  };
}

async function setAgentWebhook(agentId: string, webhookId: string): Promise<void> {
  // Agent-level override: never change another agent's inherited workspace routing.
  await api(`/v1/convai/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      platform_settings: {
        workspace_overrides: {
          webhooks: {
            post_call_webhook_id: webhookId,
            events: ['transcript', 'call_initiation_failure'],
            transcript_format: 'json',
            send_audio: false,
          },
        },
      },
    }),
  });
}

async function updateEnv(updates: Record<string, string>): Promise<void> {
  const path = new URL('../.env', import.meta.url);
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  for (const [name, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (index >= 0) lines[index] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  }
  await writeFile(path, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

async function updateExportedAgentConfig(agentId: string): Promise<void> {
  const path = new URL('../agent_config.json', import.meta.url);
  const exported = await api<Record<string, unknown>>(`/v1/convai/agents/${agentId}`);
  await writeFile(path, `${JSON.stringify(exported, null, 2)}\n`);
}

if (!createNewAgent) {
  const agentId = required('ELEVENLABS_AGENT_ID');
  const current = await api<Record<string, unknown>>(`/v1/convai/agents/${agentId}`);
  const config = current.conversation_config as { agent?: { prompt?: { tool_ids?: string[] } } };
  for (const id of config.agent?.prompt?.tool_ids ?? []) managedToolIds.add(id);
  const backupDirectory = new URL('../data/private/backups/', import.meta.url);
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    new URL('agent_config.before-provision.json', backupDirectory),
    `${JSON.stringify(current, null, 2)}\n`,
    { mode: 0o600 },
  );
}

const toolSecret = await ensureSecret(
  'autorocket_local_agent_tools',
  required('AGENT_TOOL_SECRET'),
);
const tools = await ensureTools(toolSecret.secret_id);
const pronunciationDictionary = await ensurePronunciationDictionary();
const agentId = await ensureAgent(tools, pronunciationDictionary);
const webhook = await ensurePostCallWebhook();
await setAgentWebhook(agentId, webhook.id);
await updateEnv({
  ELEVENLABS_AGENT_ID: agentId,
  ...(webhook.secret ? { ELEVENLABS_WEBHOOK_SECRET: webhook.secret } : {}),
});
await updateExportedAgentConfig(agentId);

process.stdout.write(
  `Provisioned current ElevenLabs workspace: ${createNewAgent ? 'new' : 'configured'} agent ${agentId}, ${tools.length} tools ready, post-call webhook ready.\n`,
);
