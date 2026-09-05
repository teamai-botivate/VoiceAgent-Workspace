# Standalone Voice Calling Agent

Backend-only demonstration service for an autonomous purchase follow-up voice agent.
It owns its Turso data, outbound-call scheduling, Groq gateway, ElevenLabs agent tools,
call lifecycle, and audit records.

It does **not** connect to AutoRocket. AutoRocket was used only to understand the kind
of follow-up workflow this standalone demo should model.

## Runtime architecture

```text
Local CLI / opt-in scheduler -> this service -> ElevenLabs -> Twilio -> test phone
                                  |     |
                                  |     `-> Groq gateway hosted by this service
                                  `-> Turso business data and outcomes
```

ElevenLabs handles realtime transcription and speech synthesis. The service exposes an
authenticated OpenAI-compatible endpoint that streams responses from Groq's
`openai/gpt-oss-120b`. Agent webhook tools provide controlled access to business data;
the model never receives database credentials or arbitrary SQL access.

## Tooling

- Bun 1.4+ for installs and all TypeScript commands.
- Node.js 20+ compatibility target.
- No Python component is currently used.
- If Python is introduced later, use `uv` exclusively; do not create a pip-managed
  environment.

## Install and verify

```bash
bun install
cp .env.example .env
bun run verify
```

Do not overwrite an existing `.env`. Fill in its missing variable names manually and
keep it outside source control.

`TURSO_DATABASE_TOKEN` is accepted as a compatibility alias for `TURSO_AUTH_TOKEN`.

## Database setup

For the configured Mumbai Turso database:

```bash
bun run db:migrate
bun run db:seed
```

For an entirely local standalone database while Turso credentials are unavailable:

```bash
mkdir -p data
TURSO_DATABASE_URL=file:./data/voice-agent.sqlite TURSO_AUTH_TOKEN= bun run db:migrate
TURSO_DATABASE_URL=file:./data/voice-agent.sqlite TURSO_AUTH_TOKEN= bun run db:seed
```

Process-level values override `.env`, so these commands cannot accidentally target the
remote database.

The seed is idempotent and contains only fictional data. Every seeded contact number is
non-dialable and no seeded contact has call consent.

The seed covers the plan's demonstration dataset:

- Three fictional suppliers, one of them inactive.
- Four contacts, including a secondary contact and an opted-out contact.
- Four purchase requirements across `open`, `closed`, and `quoted` states.
- Twelve requirement items, all priced per KG.
- Six follow-up jobs spanning `pending` (due), `callback_requested`,
  `quotation_pending`, `completed`, and `cannot_supply`.
- Historical call sessions, call outcomes, and one confirmed quotation with line items.
- Six approved business answers, including negotiation boundaries.

Only `PR-DEMO-2026-001` and `followup_demo_001` are used by the manual test call; the
remaining rows exist for query, lifecycle, and reporting testing. The negotiation
boundaries fact is not reachable from a call until its category is added to
`businessAnswerSchema` and the ElevenLabs provisioner is re-run.

## Safety gate for calls

A destination must pass both checks:

1. It appears in `ALLOWED_TEST_PHONE_NUMBERS`.
2. The stored demo contact has `test_approved` consent.

Approve a user-controlled test number only after migrations and seeding:

```bash
bun run test-number:approve -- +<approved-e164-number>
```

The scheduler is disabled by default. Keep `SCHEDULER_ENABLED=false` until a controlled
manual call has succeeded.

## Run locally

```bash
bun run dev
```

Endpoints:

- `GET /health/live`
- `GET /health/ready`
- `POST /internal/calls`
- `GET /internal/calls/:callSessionId?tenantId=...`
- `POST /v1/chat/completions`
- `POST /agent-tools/followup-context`
- `POST /agent-tools/business-answer`
- `POST /agent-tools/pricing-outcome`
- `POST /agent-tools/schedule-callback`
- `POST /agent-tools/supplier-response`
- `POST /agent-tools/finalize-call`
- `POST /twilio/outbound` (Twilio-signed fallback bridge)
- `POST /webhooks/elevenlabs/post-call`
- `POST /webhooks/twilio/status`
- `POST /twilio/outbound` (Twilio-trial fallback bridge; returns TwiML that joins the
  ElevenLabs agent to the call)

## Public tunnel and ElevenLabs configuration

ElevenLabs must be able to reach the local service through an HTTPS public tunnel.
Use a stable reserved tunnel URL and set it as `PUBLIC_BASE_URL`.

Configure the existing ElevenLabs agent as follows:

- Custom LLM URL: `<PUBLIC_BASE_URL>/v1`
- API type: Chat Completions
- Model ID: `openai/gpt-oss-120b`
- Authorization: `Bearer <LLM_GATEWAY_TOKEN>` stored as an ElevenLabs secret
- Post-call webhook: `<PUBLIC_BASE_URL>/webhooks/elevenlabs/post-call`
- Post-call HMAC secret: copy to `ELEVENLABS_WEBHOOK_SECRET`
- Agent tool header: `X-Agent-Tool-Secret: <AGENT_TOOL_SECRET>`

Create the six webhook tools described in `.agents/plan.md`. Map ElevenLabs parameter
names to the camelCase JSON contracts exposed by the service. Dynamic variables passed
at call initiation provide `tenant_id`, `followup_id`, and `call_session_id`; tool inputs
must map them to `tenantId`, `followupId`, and `callSessionId`.

Do not put the Turso or Groq credential in an agent prompt, dynamic variable, tool
parameter, URL, or exported agent configuration.

## Make a controlled call

With the service running:

```bash
bun run call:test -- +<approved-e164-number>
```

The request is rejected unless the destination is allowlisted. Reusing an idempotency
key returns the existing call instead of dialing twice.

## Autonomous scheduler

The scheduler polls due standalone follow-up jobs, obtains a transactional lease, and
starts at most one eligible test call per tick. It requires:

- `SCHEDULER_ENABLED=true`
- An allowlisted destination
- Stored `test_approved` consent
- A due `pending` or `callback_requested` job
- Remaining attempts

Leave it disabled while configuring providers or changing the database.

## Verification

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

The repository tests use an in-memory libSQL database; they do not touch Turso or make
provider calls.

## Security properties

- Mandatory tenant scope in business repository operations.
- Parameterized SQL only.
- No natural-language-to-SQL endpoint.
- Separate credentials for internal API, agent tools, and LLM gateway.
- Twilio signature validation and ElevenLabs HMAC validation.
- Timestamp validation for ElevenLabs callbacks.
- Destination allowlist and explicit demo consent gate.
- Idempotent outbound-call creation and provider events.
- Atomic complete-item quotation confirmation.
- Structured log redaction.
- Recording disabled by default.

See [.agents/plan.md](.agents/plan.md) for the complete architecture, phases, testing
matrix, risks, and definition of done.
