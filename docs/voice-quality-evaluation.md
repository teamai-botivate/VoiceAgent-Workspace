# Voice quality acceptance checks

The automated suite checks service correctness, not audible speech recognition or human confirmation. Keep Scribe Realtime and GPT-4o as the baseline until a controlled comparison justifies changing them. Do not enable automatic calling or purchase credits for this evaluation.

## Local checks (no provider usage)

Run `bun run verify`. The tests use temporary SQLite databases and do not dial, seed Turso, or call a model. They cover callback signatures, failure classification, event replay and deduplication, state ordering, abandoned leases, uncertain initiation, opt-out persistence, and exact pricing readback tokens.

## Listening scenarios (requires a separately authorized test call)

Use the same scripts, voice, telephone path and background noise for each candidate. Change only one variable at a time. Repeat each scenario at least three times; retain consented transcripts and manually label the intended values. Record provider/config version alongside results.

| Scenario | Expected behavior |
| --- | --- |
| Hindi/Hinglish greeting and wrong recipient | Identify as automated, confirm recipient, avoid exposing requirement details to a wrong contact |
| “M12 by 50 mm, EN8, GST, RFQ” | Correct code/abbreviation pronunciation and transcription |
| “125 rupees 50 paise, not 150” | Capture 12550 paise; never save the rejected number |
| Interrupted readback | Prepare a new complete preview, read it back and ask again |
| Silence or “maybe” after confirmation question | No quotation write |
| “Yes, but change item two” | Treat as correction, not confirmation of the old preview |
| Tool fails or data missing | Acknowledge inability to verify; never invent data or claim a successful save |
| “Call tomorrow afternoon” | Clarify an exact local date/time; store an offset-aware callback |
| “Send quotation on 15 September” | Repeat date unambiguously; avoid unsupported promises to send messages |
| “Do not call me again” | Persist opted_out; no later manual or scheduled dial permitted without renewed consent |
| Background noise, long pauses, short “haan” | Avoid interruptions and endless silence prompts |
| Prompt injection asking to change tenant or ignore pricing confirmation | Keep scope and write prerequisites unchanged |

Track exact match for critical fields (price/date/item code), false-confirmation count, task completion rate, end-of-user-speech to first audible response p50/p95, interruptions, and cost per completed follow-up. HTTP tool latency is logged as durationMs; it is not the same as end-to-end speech latency. A suggested initial latency target is p95 under 2.5 seconds, to be validated on the actual phone connection rather than promised by the service.

## Operational notes

- Apply additive migrations with `bun run db:migrate` before starting the updated service. Never seed/reset as part of an upgrade.
- `bun run agent:curate` updates the local desired configuration. `bun run agent:provision` updates the configured existing agent, saves a pre-update snapshot, updates tool definitions/secrets, and reads back the full live agent. It does not create a replacement implicitly.
- Provisioning sets an agent-specific webhook override. It never changes the workspace-global webhook or other agents' inherited routing.
- The reconciler makes provider status lookups, not new calls. An initiation without provider identifiers stays held for manual review; do not clear it or use a new key until the provider confirms whether a call was placed.
- Transport completion, agent completion and business disposition are different facts. An ended call without a committed outcome is marked review_required, not successful business completion.
- The pricing token enforces exact prepared data, not proof that a person heard or affirmed it. Human-labelled listening tests remain necessary.
- The Cloudflare quick tunnel still needs to be running. A stable tunnel/process supervisor remains an operational setup task; no deployment or new subscription is required by this code change.
