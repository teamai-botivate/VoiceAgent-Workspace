import { FunctionTool } from '@google/adk';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireConfig } from '../../config/env.js';
import {
  businessAnswerSchema,
  callContextSchema,
  finalizeCallSchema,
  previewPricingSchema,
  recordPricingSchema,
  scheduleCallbackSchema,
  supplierResponseSchema,
} from '../../domains/followups/schemas.js';

const bindings = {
  followup_context: {
    path: 'followup-context',
    schema: callContextSchema,
    description:
      'Load current approved follow-up context from Turso. Must run before business conversation.',
  },
  business_answer: {
    path: 'business-answer',
    schema: businessAnswerSchema,
    description: 'Fetch authoritative delivery, payment, GST, validity or commercial-unit policy.',
  },
  pricing_preview: {
    path: 'pricing-preview',
    schema: previewPricingSchema,
    description:
      'Validate current item-wise KG rates in minor currency units and create a confirmation token.',
  },
  pricing_outcome: {
    path: 'pricing-outcome',
    schema: recordPricingSchema,
    description:
      'Commit unchanged preview only after the caller explicitly confirms the complete read-back.',
  },
  schedule_callback: {
    path: 'schedule-callback',
    schema: scheduleCallbackSchema,
    description:
      'Schedule only a callback date and time explicitly requested by the caller, including timezone.',
  },
  supplier_response: {
    path: 'supplier-response',
    schema: supplierResponseSchema,
    description: 'Record the caller response or opt-out.',
  },
  finalize_call: {
    path: 'finalize-call',
    schema: finalizeCallSchema,
    description: 'Finalize a conversation only when its outcome is established.',
  },
} as const;

export function createAdkTools(
  app: FastifyInstance,
  context: { tenantId: string; followupId: string; callSessionId: string },
  active: () => boolean = () => true,
  onFinalized: () => void = () => {},
) {
  let calls = 0;
  return Object.entries(bindings).map(([name, binding]) => {
    const tool = new FunctionTool({
      name,
      description: binding.description,
      parameters: z
        .object({ ...binding.schema.shape })
        .omit({ tenantId: true, followupId: true, callSessionId: true }),
      execute: async (args) => {
        if (!active()) return { success: false, error: 'CALL_ENDED' };
        if (++calls > 100) return { success: false, error: 'TOOL_LIMIT_EXCEEDED' };
        const started = Date.now();
        const result = await executeTool(app, name, args, context);
        if (
          name === 'finalize_call' &&
          typeof result === 'object' &&
          result !== null &&
          'success' in result &&
          result.success === true
        )
          onFinalized();
        app.log.info(
          { tool: name, durationMs: Date.now() - started, experiment: 'gemini-adk' },
          'ADK tool completed',
        );
        return result;
      },
    });
    // Live's Schema dialect only supports string enums. Runtime Zod checks
    // remain authoritative for literals and all other business constraints.
    const declaration = tool._getDeclaration();
    sanitizeLiveSchema(declaration.parameters);
    tool._getDeclaration = () => declaration;
    return tool;
  });
}

function sanitizeLiveSchema(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const schema = value as Record<string, unknown>;
  if (Array.isArray(schema.enum) && schema.enum.some((entry) => typeof entry !== 'string'))
    delete schema.enum;
  if (schema.exclusiveMinimum === true && typeof schema.minimum === 'number') schema.minimum += 1;
  delete schema.exclusiveMinimum;
  if (schema.format === 'uuid') delete schema.format;
  for (const child of Object.values(schema)) sanitizeLiveSchema(child);
}

export const toolDeclarations = Object.entries(bindings).map(([name, binding]) => {
  const parametersJsonSchema = z.toJSONSchema(binding.schema);
  const identity = new Set(['tenantId', 'followupId', 'callSessionId']);
  for (const key of identity) delete parametersJsonSchema.properties?.[key];
  if (parametersJsonSchema.required) {
    parametersJsonSchema.required = parametersJsonSchema.required.filter(
      (key) => !identity.has(key),
    );
  }
  delete parametersJsonSchema.$schema;
  return { name, description: binding.description, parametersJsonSchema };
});

export async function executeTool(
  app: FastifyInstance,
  name: string,
  args: unknown,
  context: { tenantId: string; followupId: string; callSessionId: string },
): Promise<unknown> {
  const binding = Object.hasOwn(bindings, name)
    ? bindings[name as keyof typeof bindings]
    : undefined;
  if (!binding) return { success: false, error: 'UNKNOWN_TOOL' };
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return { success: false, error: 'INVALID_ARGUMENTS' };
  // Trusted call identity always wins over model-provided identity.
  const parsed = binding.schema.safeParse({ ...args, ...context });
  if (!parsed.success)
    return { success: false, error: 'INVALID_ARGUMENTS', issues: parsed.error.issues };
  const response = await app.inject({
    method: 'POST',
    url: `/agent-tools/${binding.path}`,
    headers: { 'x-agent-tool-secret': requireConfig('AGENT_TOOL_SECRET') },
    payload: parsed.data,
  });
  return response.json();
}
