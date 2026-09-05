# AutoRocket Voice Calling Agent — Implementation Plan

## 1. Purpose

Build a standalone backend-only voice calling service that models the kind of PC
follow-up workflow used by AutoRocket without connecting to AutoRocket.
The first demo will call a supplier about an existing purchase requirement, answer
questions from controlled business data, collect item-wise pricing, negotiate, obtain
explicit confirmation, and persist the call outcome.

The service will run locally for the demo and own its data, scheduling, call lifecycle,
LLM gateway, and audit records. AutoRocket is reference material only. A future
integration may be designed separately after the standalone demo is accepted.

## 2. Scope

### In scope

- Reuse the existing ElevenLabs agent and selected voice.
- Twilio inbound/outbound telephony through ElevenLabs' native Twilio integration.
- ElevenLabs Scribe realtime speech-to-text.
- ElevenLabs conversational text-to-speech.
- Groq `openai/gpt-oss-120b` as the agent LLM.
- Turso as the structured source of business information and demo persistence layer.
- Outbound call orchestration and lifecycle tracking.
- Authenticated agent tools for retrieving context and recording outcomes.
- Hindi/Hinglish purchase follow-up conversations.
- Seeded, fictional demonstration data.
- Local public tunnel for provider webhooks.
- Automated tests, structured logs, auditability, and failure handling.

### Out of scope for the first demo

- Web dashboard or frontend.
- Bulk production calling.
- Direct modification of the AutoRocket production database.
- Any AutoRocket API call, import, shared package, credential, or runtime dependency.
- WhatsApp/email delivery.
- Production deployment or infrastructure automation.
- Arbitrary natural-language-to-SQL access.
- A custom Twilio audio/WebSocket bridge unless native integration proves inadequate.

## 3. Assumptions

- The initial scenario is a self-contained purchase/vendor follow-up modeled after the
  demonstrated PC workflow.
- The first demo uses only approved test recipients and fictional business data.
- Turso is hosted in the Mumbai region and is reachable with the credentials already
  present locally.
- The existing ElevenLabs agent remains the voice/personality source of truth.
- Tool results, not the model's memory, are the source of truth for mutable business
  information.
- All tenant-owned data is scoped by `tenant_id`, matching AutoRocket's multi-tenant
  security model.

No AutoRocket integration work is authorized by this plan.

## 4. Current-State Findings

Source: `agent_config.json` in this workspace.

- Existing agent ID: `agent_2601m169945ze9rvatme883v0wg4`.
- Agent name: `voiceagent`.
- Language is Hindi with Hinglish enabled.
- ASR is ElevenLabs `scribe_realtime` in high-quality mode.
- The selected ElevenLabs voice and conversational TTS model are configured.
- A Twilio number is assigned and supports inbound and outbound calls.
- The prompt contains a detailed purchase follow-up and negotiation flow.
- The purchase requirement is currently hardcoded in the prompt.
- The custom LLM currently points to OpenAI `gpt-4.1-mini`, not Groq.
- RAG is disabled.
- No live database lookup or outcome-writing tool is attached.
- The prompt asks for a workflow update, but the agent only has language detection
  and end-call tools.
- Call recording is enabled with indefinite retention and no PII deletion.
- Guardrails and practical demo call limits need tightening.
- `.env` contains ElevenLabs and Turso credential variable names, but not the complete
  Twilio/Groq/service configuration.
- The existing ElevenLabs variable is misspelled as `ELLEVENLABS_API_KEY`; migrate to
  `ELEVENLABS_API_KEY` without exposing or losing the current value.

## 5. Recommended Architecture

```text
Standalone Scheduler / Local CLI
          |
          v
Voice Agent Service
  - call orchestration
  - business rules
  - authenticated agent tools
  - audit and lifecycle tracking
  - post-call processing
          |
          +----------------------> Turso (Mumbai)
          |
          v
ElevenLabs Agent
  - Scribe realtime STT
  - conversation runtime
  - Groq custom LLM
  - ElevenLabs TTS
          |
          v
Twilio Programmable Voice
          |
          v
Approved test phone
```

### Architectural decision

Use the native ElevenLabs/Twilio integration for the first version. Do not build a
custom media bridge unless testing proves that native integration cannot meet a
specific latency, audio-control, or observability requirement.

### Runtime call flow

1. An authorized internal request or local CLI selects a due follow-up.
2. The service loads tenant, supplier, contact, and requirement information from Turso.
3. The service creates a `call_session` and an idempotency key.
4. The service initiates the outbound call using the configured ElevenLabs agent and
   Twilio number.
5. The agent receives only identifiers and safe dynamic variables at call start.
6. The agent calls `get_followup_context` to obtain authoritative business context.
7. ElevenLabs transcribes the vendor; Groq decides how to respond or which tool to use;
   ElevenLabs synthesizes and plays the response.
8. The agent collects and confirms the complete pricing outcome.
9. A state-changing tool validates and commits the outcome atomically.
10. Twilio/ElevenLabs callbacks update call status, duration, disposition, and audit data.
11. The post-call processor reconciles missing callbacks and creates a final summary.

## 6. Technology and Engineering Standards

- Runtime: Node.js 20.
- Language: TypeScript with `strict` and `noUncheckedIndexedAccess` enabled.
- HTTP framework: Fastify.
- Validation: Zod for environment variables, tool inputs, webhooks, and API responses.
- Database clients: `@tursodatabase/serverless` for remote `turso:` connections and
  `@libsql/client` for isolated local file databases and tests.
- Provider clients: official ElevenLabs and Twilio SDKs.
- LLM compatibility tests: OpenAI-compatible client pointed at Groq.
- Logging: Pino with structured fields and automatic redaction.
- Testing: Vitest.
- Formatting/linting: Biome.
- Package manager and script runner: Bun with a committed `bun.lock`.
- If a future component requires Python, use `uv` for its environment, dependencies,
  lockfile, and command execution. Do not introduce pip-managed environments.
- API style: JSON REST endpoints plus provider webhooks.
- Time storage: UTC; business-time presentation in `Asia/Kolkata`.

## 7. Proposed Project Structure

```text
VoiceAgent-Workspace/
|-- .agents/
|   `-- plan.md
|-- src/
|   |-- app.ts
|   |-- server.ts
|   |-- config/
|   |   |-- env.ts
|   |   `-- logger.ts
|   |-- db/
|   |   |-- client.ts
|   |   |-- migrations/
|   |   `-- repositories/
|   |-- domains/
|   |   |-- calls/
|   |   |-- followups/
|   |   |-- purchase-requirements/
|   |   `-- quotations/
|   |-- integrations/
|   |   |-- elevenlabs/
|   |   |-- groq/
|   |   `-- twilio/
|   |-- routes/
|   |   |-- health.ts
|   |   |-- internal-calls.ts
|   |   |-- agent-tools.ts
|   |   |-- elevenlabs-webhooks.ts
|   |   `-- twilio-webhooks.ts
|   |-- security/
|   `-- shared/
|-- scripts/
|   |-- migrate.ts
|   |-- seed-demo.ts
|   |-- sync-agent.ts
|   `-- make-test-call.ts
|-- tests/
|   |-- unit/
|   |-- integration/
|   |-- contracts/
|   `-- conversations/
|-- agent_config.json
|-- .env
|-- .env.example
|-- .gitignore
|-- biome.json
|-- package.json
|-- bun.lock
|-- tsconfig.json
`-- README.md
```

## 8. Turso Data Model

Every tenant-owned table must contain `tenant_id`. Repository functions must require
`tenantId` as an explicit argument; there must be no unscoped convenience methods.

### `tenants`

- `id`
- `name`
- `timezone`
- `created_at`

### `suppliers`

- `id`
- `tenant_id`
- `supplier_code`
- `legal_name`
- `status`
- `preferred_language`
- `created_at`, `updated_at`

### `supplier_contacts`

- `id`
- `tenant_id`
- `supplier_id`
- `name`
- `phone_e164`
- `email`
- `is_primary`
- `call_consent_status`
- `created_at`, `updated_at`

### `purchase_requirements`

- `id`
- `tenant_id`
- `requirement_number`
- `title`
- `status`
- `currency`
- `version`
- `required_by_date`
- `created_at`, `updated_at`

### `purchase_requirement_items`

- `id`
- `tenant_id`
- `purchase_requirement_id`
- `line_number`
- `item_name`
- `specification`
- `quantity_decimal`
- `unit`
- `target_rate_minor` (nullable)
- `maximum_rate_minor` (nullable)

For the first scenario, `unit` must be `KG`. Monetary values should be stored as integer
minor units, not floating-point values.

### `followup_jobs`

- `id`
- `tenant_id`
- `supplier_id`
- `supplier_contact_id`
- `purchase_requirement_id`
- `status`
- `scheduled_at`
- `attempt_count`
- `max_attempts`
- `lease_owner`, `lease_expires_at`
- `last_outcome`
- `next_attempt_at`
- `created_at`, `updated_at`

### `supplier_quotations`

- `id`
- `tenant_id`
- `supplier_id`
- `purchase_requirement_id`
- `followup_job_id`
- `status`
- `discount_basis_points` (nullable)
- `confirmed_at` (nullable)
- `version`
- `created_at`, `updated_at`

### `supplier_quotation_items`

- `id`
- `tenant_id`
- `quotation_id`
- `requirement_item_id`
- `initial_rate_minor`
- `revised_rate_minor` (nullable)
- `final_rate_minor`
- `unit`
- `vendor_confirmed`

### `call_sessions`

- `id`
- `tenant_id`
- `followup_job_id`
- `provider`
- `twilio_call_sid` (unique, nullable)
- `elevenlabs_conversation_id` (unique, nullable)
- `idempotency_key` (unique)
- `status`
- `started_at`, `answered_at`, `ended_at`
- `duration_seconds`
- `failure_code`, `failure_message`
- `created_at`, `updated_at`

### `call_events`

- `id`
- `tenant_id`
- `call_session_id`
- `provider`
- `provider_event_id` (unique when available)
- `event_type`
- `payload_redacted_json`
- `occurred_at`
- `received_at`

### `call_outcomes`

- `id`
- `tenant_id`
- `call_session_id` (unique)
- `disposition`
- `summary`
- `callback_at` (nullable)
- `supplier_confirmed`
- `quotation_id` (nullable)
- `recorded_by`
- `created_at`, `updated_at`

### `agent_knowledge`

- `id`
- `tenant_id`
- `category`
- `key`
- `value`
- `effective_from`, `effective_to`
- `is_active`

## 9. Demo Seed Dataset

The seed must be deterministic, repeatable, and safe to run more than once.

- Tenant: Ram Private Limited.
- Agent identity: Pratap, Purchase Department.
- Two or three clearly fictional suppliers.
- Fictional contacts with non-dialable placeholder numbers.
- One open purchase requirement containing:
  - M12 Hex Bolt, M12 x 50 mm, 20 KG.
  - M10 Hex Nut, M10, 30 KG.
  - M8 Flat Washer, M8, 25 KG.
  - M16 Threaded Rod, M16 x 1 meter, 50 KG.
  - M12 Spring Washer, M12, 35 KG.
- Additional closed and pending requirements for query testing.
- Business facts covering delivery location, payment terms, GST policy, quotation
  validity, and approved negotiation boundaries.
- Follow-up examples in `due`, `callback_requested`, `quotation_pending`, `completed`,
  and `cannot_supply` states.
- Historical quotation and call-outcome records.

Actual test phone numbers must not be embedded in migrations or seed files. Supply an
approved user-controlled destination only at test-call time.

## 10. Agent Tool Contracts

The LLM must never receive Turso credentials, raw SQL access, or unrestricted write
capability.

### `get_followup_context`

Input:

- `followup_id`
- `call_session_id`

Output:

- Tenant and supplier display information.
- Contact name and preferred language.
- Requirement number and version.
- Complete item list with specifications, quantities, and units.
- Prior communication summary.
- Allowed negotiation context.

### `get_business_answer`

Input:

- `followup_id`
- `question_category`

Output is selected from an allowlisted set of relevant business facts. The tool must
not accept free-form SQL or table/column identifiers.

### `record_pricing_outcome`

Input:

- `followup_id`
- `call_session_id`
- `requirement_id`
- `requirement_version`
- Complete item pricing array.
- Explicit confirmation flag.

Server validation:

- All expected items appear exactly once.
- Item IDs belong to the selected requirement and tenant.
- Quantities and specifications have not changed.
- Unit is `KG`.
- Rates are positive and within safe numeric bounds.
- Explicit vendor confirmation is true.
- Requirement version is current.
- Duplicate execution returns the original result.

The quotation, line items, follow-up state, outcome, and audit event must commit in one
database transaction.

### `schedule_callback`

Records a vendor-requested callback date/time or a general callback-required state.
Reject dates outside configured business rules.

### `record_supplier_response`

Allowlisted dispositions:

- `quotation_will_be_sent`
- `cannot_supply`
- `not_interested`
- `wrong_contact`
- `requirement_not_received`
- `needs_more_information`

### `finalize_call`

Records a structured final disposition. It must not mark pricing confirmed unless a
successful `record_pricing_outcome` result exists.

## 11. HTTP API

### Health

- `GET /health/live`
- `GET /health/ready`

Readiness checks configuration and provider/database client initialization without
exposing secret details.

### Internal call orchestration

- `POST /internal/calls`
- `GET /internal/calls/:id`
- `POST /internal/calls/:id/retry`

These endpoints require an internal bearer token and an idempotency key.

### ElevenLabs agent tools

- `POST /agent-tools/followup-context`
- `POST /agent-tools/business-answer`
- `POST /agent-tools/pricing-outcome`
- `POST /agent-tools/schedule-callback`
- `POST /agent-tools/supplier-response`
- `POST /agent-tools/finalize-call`

These endpoints require a dedicated ElevenLabs webhook secret and validate all input
with strict Zod schemas.

### Provider callbacks

- `POST /webhooks/twilio/status`
- `POST /webhooks/elevenlabs/post-call`

Twilio signatures must be verified against the exact externally visible URL. Provider
events must be recorded idempotently before applying state transitions.

## 12. ElevenLabs Agent Changes

Preserve:

- Agent identity and voice.
- Hindi/Hinglish behavior.
- Conversational speaking style.
- Existing supplier follow-up, pricing, negotiation, and closing procedures.

Change:

- Set custom LLM base URL to `https://api.groq.com/openai/v1`.
- Set model ID to `openai/gpt-oss-120b`.
- Store the Groq key in the ElevenLabs secret manager.
- Start with low reasoning effort and evaluate medium separately.
- Remove the hardcoded purchase requirement from the permanent prompt.
- Add safe dynamic variables containing only call identifiers and display context.
- Attach the six authenticated service tools.
- Require a successful tool response before claiming any system update.
- Add an explicit automated-agent disclosure suitable for the approved test.
- Add recording disclosure if recording remains enabled.
- Configure practical concurrency and daily limits for the demo.
- Configure finite transcript/audio retention.
- Enable relevant prompt-injection and content safeguards.
- Create and publish a new agent version while retaining the current version for rollback.

If native Twilio integration negotiates the audio format correctly, keep it. If a custom
Twilio Media Streams bridge becomes necessary, change both sides to `ulaw_8000` and add
bidirectional WebSocket handling as a separately approved phase.

## 13. Prompt Design

The permanent prompt should contain behavior, not mutable database content.

### Permanent instructions

- Identity, company role, and disclosure.
- Hindi/Hinglish language style.
- Buyer/supplier role boundaries.
- Ask one question at a time and allow interruptions.
- Fetch authoritative context before discussing requirement details.
- Never invent items, quantities, prices, discounts, availability, timelines, taxes,
  fees, delivery terms, or update status.
- Never silently convert commercial units.
- Repeat ambiguous prices and obtain clarification.
- Require explicit confirmation before any pricing write.
- Treat tool errors as unconfirmed operations.
- Close naturally only after the final spoken response is complete.

### Dynamic variables

- `tenant_name`
- `followup_id`
- `call_session_id`
- `supplier_name`
- `contact_name`
- `requirement_number`
- `preferred_language`

The complete requirement and business answers must come from tools.

## 14. Configuration and Secrets

Required local variables:

```dotenv
NODE_ENV=
PORT=
PUBLIC_BASE_URL=
LOG_LEVEL=

TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
ELEVENLABS_PHONE_NUMBER_ID=
ELEVENLABS_WEBHOOK_SECRET=

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_API_KEY=
TWILIO_API_SECRET=
TWILIO_PHONE_NUMBER=

GROQ_API_KEY=
INTERNAL_API_TOKEN=
```

Rules:

- `.env` must be ignored by Git.
- `.env.example` contains names and documentation only.
- Validate required variables at startup without logging values.
- Use a restricted Twilio API key for call creation where supported.
- Retain the Twilio Auth Token only for operations that require it, including signature
  validation.
- Groq credentials should be stored in ElevenLabs for the runtime agent; the local key
  is only needed for contract tests or a future gateway.
- Use separate demo and future-production secrets.
- Rotate any secret suspected of appearing in logs, commits, screenshots, or exports.

## 15. Security, Privacy, and Safety Controls

- Require `tenant_id` in every repository call and database predicate.
- Use parameterized database queries only.
- Validate all webhooks and tool requests.
- Use timing-safe comparison for shared secrets.
- Redact authorization headers, tokens, phone numbers, email addresses, transcripts,
  and provider payload fields from logs.
- Store redacted provider payloads rather than raw payloads by default.
- Apply body-size, timeout, and rate limits.
- Apply idempotency to call initiation and every state-changing callback/tool.
- Reject unknown object fields in externally supplied JSON.
- Treat every spoken transcript as untrusted input.
- Do not let transcript content alter tool authorization, tenant scope, or identifiers.
- Do not expose target/maximum price unless the business rules explicitly permit it.
- Set a short demo retention period and avoid recording unless it is required for the
  evaluation.
- Use only consented, user-controlled test numbers.
- Provide an automated-agent and recording disclosure.
- Respect callback requests, opt-outs, business hours, and maximum retry counts.
- Obtain legal/compliance review before calling real suppliers or enabling production.

## 16. Observability and Reliability

### Structured identifiers

Every log and event should carry, where available:

- `requestId`
- `tenantId`
- `followupId`
- `callSessionId`
- `twilioCallSid`
- `elevenlabsConversationId`
- `toolName`

### Metrics

- Calls initiated, answered, failed, and completed.
- Provider status distribution.
- LLM/tool/database latency.
- Tool success/failure counts.
- Conversation time to first response.
- Confirmation and quotation completion rate.
- Retry count and duplicate-event count.
- Pricing validation failures.

### Failure behavior

- Database unavailable: apologize without inventing data; do not write an outcome.
- Tool timeout: state that the update could not be confirmed.
- Groq unavailable: use configured fallback only if its behavior is explicitly tested.
- Duplicate callback: return success without reapplying the transition.
- Partial provider callback sequence: reconcile during post-call processing.
- Call initiation timeout: look up by idempotency key before retrying.

## 17. Testing Strategy

### Unit tests

- Environment validation and log redaction.
- Tenant-scoped repositories.
- Money and KG-rate validation.
- State-transition rules.
- Idempotency behavior.
- Callback scheduling rules.
- Prompt/dynamic-variable construction.

### Contract tests

- ElevenLabs tool request and response formats.
- ElevenLabs custom-LLM streaming expectations.
- Groq streaming and function-call compatibility.
- Twilio status callback parsing and signature validation.
- Turso transaction behavior.

### Integration tests

- Migration from an empty database.
- Idempotent demo seed.
- Complete context lookup.
- Atomic quotation confirmation.
- Duplicate webhook delivery.
- Wrong tenant and stale requirement version rejection.
- Provider timeout and recovery behavior.

### Conversation simulations

- Vendor gives one rate at a time.
- Vendor gives rates in a different order.
- Multiple rates appear in one sentence.
- Ambiguous Hindi number or noisy transcription.
- Vendor changes a previously quoted rate.
- Discount percentage versus revised KG rate.
- Vendor quotes per piece rather than per KG.
- Vendor is busy and requests a callback.
- Vendor will send the quotation later.
- Vendor cannot supply or is not interested.
- Wrong contact answers.
- No answer, rejected call, and voicemail.
- User attempts spoken prompt injection.
- Database/tool fails after verbal confirmation.
- Confirmation is withdrawn before the write.
- Agent receives a question not covered by the approved data.

### Manual end-to-end test

1. Start the service and public tunnel.
2. Verify live and ready health endpoints.
3. Run migrations and deterministic seed.
4. Configure the public callback/tool URLs.
5. Call one approved test number.
6. Complete a controlled Hindi/Hinglish pricing conversation.
7. Inspect Turso records and provider call status.
8. Confirm no secrets or raw sensitive data appear in logs.
9. Repeat the callback payload to verify idempotency.

## 18. Delivery Phases and Exit Criteria

### Phase 0 — Safety and readiness

Tasks:

- Create Git ignore rules and `.env.example`.
- Validate existing Turso connectivity with a read-only query.
- Confirm the ElevenLabs agent and phone-number identifiers.
- Confirm Twilio test-account/number capability and an approved destination.
- Decide recording and retention settings.

Exit criteria:

- No secret is committed or printed.
- All required credentials are available through validated configuration.
- Test-number consent and demo boundaries are documented.

### Phase 1 — Service foundation

Tasks:

- Initialize Node/TypeScript/Fastify project.
- Add Zod configuration, Pino redaction, error handling, and health endpoints.
- Add Biome, Vitest, and CI-style local verification scripts.

Exit criteria:

- Typecheck, lint, unit tests, and health checks pass.
- Startup fails safely on missing configuration.

### Phase 2 — Database and seed

Tasks:

- Add versioned migrations for all demo tables.
- Implement tenant-scoped repositories.
- Implement idempotent seed and reset-safe verification commands.
- Populate fictional purchase follow-up data.

Exit criteria:

- A clean database migrates and seeds deterministically.
- Cross-tenant repository tests pass.
- No real phone number exists in seed data.

### Phase 3 — Agent tool service

Tasks:

- Implement read-only context/business-answer tools.
- Implement transactional outcome, callback, and disposition tools.
- Add authentication, validation, audit events, and idempotency.

Exit criteria:

- All tool contract and integration tests pass.
- The model cannot issue arbitrary queries or unauthorized writes.
- A pricing write is impossible without explicit confirmation.

### Phase 4 — Provider adapters

Tasks:

- Implement ElevenLabs call creation and post-call callback handling.
- Implement Twilio status callback validation and normalization.
- Add call state reconciliation and safe retry behavior.

Exit criteria:

- Mocked provider lifecycle completes without duplicate state transitions.
- Invalid webhook signatures are rejected.

### Phase 5 — Agent synchronization

Tasks:

- Back up the current agent export.
- Add the Groq secret and custom LLM configuration.
- Refactor the prompt to use dynamic variables and tools.
- Attach authenticated tools and post-call webhook.
- Set demo call, guardrail, recording, and retention controls.
- Publish a reversible agent version.

Exit criteria:

- Agent test mode retrieves seeded context.
- Groq streams responses and emits valid tool calls.
- The agent never claims an update after a failed tool call.

### Phase 6 — End-to-end calling

Tasks:

- Expose the local service through a secure tunnel.
- Initiate one approved outbound call.
- Verify audio, interruption handling, latency, database reads, and outcome write.
- Exercise failure and callback scenarios.

Exit criteria:

- A complete test call is traceable across all providers and Turso.
- Confirmed pricing is stored exactly once.
- Sensitive data is absent from application logs.

### Phase 7 — Evaluation and hardening

Tasks:

- Run the full conversation scenario matrix.
- Measure latency, accuracy, tool reliability, and provider failures.
- Tune prompt, ASR keywords, turn-taking, and reasoning effort.
- Produce a short readiness report and unresolved-risk list.

Exit criteria:

- All go/no-go criteria below are met or explicitly waived.
- AutoRocket integration contract is documented.

### Phase 8 — Optional future integration (not part of this build)

This phase is intentionally excluded. It requires a new request and a separate design
review before any AutoRocket system is accessed.

Possible future tasks:

- Map demo entities to real PC system identifiers and events.
- Replace or synchronize Turso demo data with an approved AutoRocket adapter.
- Define authentication between AutoRocket and the voice service.
- Add production queueing, concurrency control, monitoring, and deployment.
- Perform security, legal, privacy, and operational reviews.

Exit criteria:

- Integration does not bypass AutoRocket tenant/permission rules.
- Rollout and rollback procedures are documented and tested.

## 19. Demo Go/No-Go Criteria

- Correct tenant, supplier, and requirement selected: 100%.
- Correct requirement item/quoted-rate mapping: at least 98%.
- Cross-tenant access: 0 occurrences.
- Invented or unauthorized database writes: 0 occurrences.
- Acknowledged update without successful commit: 0 occurrences.
- Duplicate callback causing duplicate business action: 0 occurrences.
- Tool and webhook idempotency tests: 100% passing.
- Call lifecycle/disposition captured: at least 95% of completed tests.
- P95 conversational response latency: target below 2 seconds.
- Safe provider/database failure handling: 100% of defined failure tests.
- Secrets or full sensitive payloads in logs: 0 occurrences.
- Human reviewer approval of Hindi/Hinglish quality and call flow.

## 20. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Hallucinated requirement or price | Load data through tools; validate every write server-side. |
| Cross-tenant data leakage | Mandatory tenant-scoped repositories and negative tests. |
| Duplicate provider callbacks | Unique provider IDs and idempotent transitions. |
| Wrong number transcription | Confirmation loop and strict numeric validation. |
| High response latency | Native voice integration, streaming Groq, low reasoning effort, Mumbai database. |
| Local tunnel instability | Stable reserved tunnel for tests; health and reconnect checks. |
| Tool endpoint abuse | Dedicated secret, rate limits, strict schemas, no raw SQL. |
| Provider outage mid-call | Safe verbal fallback; never claim persistence; reconciliation. |
| Cost or accidental bulk calls | Low daily/concurrency caps and approved-number allowlist. |
| Privacy/compliance issue | Disclosure, consent, minimal retention, controlled test recipients. |
| Agent profile regression | Versioned export, reversible publish, contract/conversation tests. |
| Future AutoRocket mismatch | Keep adapters and domain boundaries explicit; document mapping before integration. |

## 21. Definition of Done for the Local Demo

The demo is complete when:

1. The service starts locally with validated configuration and clean logs.
2. Turso migrations and seed data can be recreated deterministically.
3. The existing ElevenLabs voice agent uses Groq `openai/gpt-oss-120b`.
4. The agent fetches the correct purchase requirement from Turso at call time.
5. An approved test phone receives a Twilio call through ElevenLabs.
6. The agent conducts the Hindi/Hinglish follow-up without hardcoded requirement data.
7. The agent answers supported business questions using Turso-backed tools.
8. Item-wise pricing and explicit confirmation are recorded atomically and exactly once.
9. Call status and structured outcome can be traced end to end.
10. Automated tests and the conversation scenario suite pass.
11. No secret is committed, logged, or sent to the LLM as conversation content.
12. A readiness report states whether the architecture is suitable for AutoRocket
    integration and identifies any remaining production blockers.

## 22. Recommended Execution Order

Execute phases in order. Do not configure live provider callbacks or place a call until
the database tools, authentication, validation, idempotency, and automated tests are in
place. Do not connect the service to real AutoRocket data during the demo phase.
