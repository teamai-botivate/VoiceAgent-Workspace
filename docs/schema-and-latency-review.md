# AutoRocket schema comparison and voice latency review

Reviewed 5 September 2026. AutoRocket source files were inspected read-only; its database was not connected. Only the standalone demo Turso database was queried. No business data was imported, reset or changed, and no calls were placed.

## PC is a view of work, not a replacement business database

AutoRocket's Process Control service aggregates per-module pending work through `src/services/processControl/pendingItemsRegistry.ts`. Purchase pending stages use `PRStageItem`, `PRIndent` and downstream purchase entities. `PcExpense`, `PcPettyCash` and related models are **Petty Cash**, not Process Control.

Process Control includes purchase, stores, maintenance, HR, lead-to-order and other systems. Supplier quotation follow-up is one use case, not the complete PC model. Employee/assignee reminders would also need a different recipient role and conversation policy from the current supplier agent.

## Mapping

| Concept | AutoRocket model/source | Standalone demo | Gap |
| --- | --- | --- | --- |
| Tenant | `Tenant`, authenticated request tenant | `tenants`, tenant-scoped tools | Preserve tenant scope in any future adapter |
| Vendor/contact | `Vendor`, `VendorContactPersonDetail` | `suppliers`, `supplier_contacts` | Demo adds test consent/opt-out; never infer consent from an imported phone number |
| Product/unit | `Product`, `Uom`; product unit is a string | Embedded item name/specification; KG-only constraint | Do not treat PCS, tonnes or metres as KG; explicit unit support is required first |
| Purchase request | `PRIndent`, optional `PRIndentGroup`; indent has product and quantity | Requirement header plus multiple requirement items | Not a one-to-one mapping; define grouping explicitly |
| Competitive quotations | `PRThreePartyComparison` → `PRVendorQuotation` vendor slots | One supplier quotation per follow-up, with multiple lines | Demo lacks comparison slots, selection and technical/commercial quotation fields |
| Commercial terms | Vendor quote rate type, GST %, payment term, advance %, packaging, transport, expected delivery, chemistry/quality fields | Integer-paise rates, optional discount and generic knowledge answers | Capture typed terms with provenance; free-text summaries are not structured quotation terms |
| Approval and order | `PRManagementApproval`, `PRPurchaseOrder`, `PRPurchaseOrderItem` | No approval or PO model | Supplier confirmation is not management approval or authorization to place an order |
| PC stage/due work | `PRStageItem.stageKey`, planned/completed times, assignees and module-specific pending queries | `followup_jobs` plus attempts/callback dates | No PC stage/assignee/source-entity mapping today |
| Other modules | `SFMSQuotation` + items, `L2O*`, `O2D*`, maintenance/work orders | Purchase-only tools | Add module-specific adapters and schemas, not arbitrary LLM SQL |

Purchase section names also need translation: PC maps `management_approvals` to `mgmt_approval` and `purchase_order` to `po_entry`. Directly copying UI section labels into stage queries would silently miss work.

Source references:

- `/home/gojosatoru/TeamAI/AutoRocket-WorkSpace/backend_botivate_os/prisma/schema.prisma`: Vendor 2564, PRIndent 2909, PRPurchaseOrder 2984, SFMSQuotation 3844, PRThreePartyComparison 6080, PRVendorQuotation 6105, PRManagementApproval 6146, PRStageItem 6509.
- `/home/gojosatoru/TeamAI/AutoRocket-WorkSpace/backend_botivate_os/src/services/processControl/pendingItemsRegistry.ts`: purchase mapping starts at 183.

## What is already in Turso

Live aggregate counts: 3 suppliers, 4 contacts, 4 requirements, 12 requirement items, 6 follow-up jobs, 1 quotation, 13 call sessions and 6 knowledge entries. The event inbox and conversation-state migration are present. These are fictional business fixtures and test-call history, not a copy of AutoRocket production data.

The current test requirement `PR-DEMO-2026-001` contains M12 hex bolts (20 KG), M10 hex nuts (30 KG), M8 flat washers (25 KG), M16 threaded rods (50 KG), and M12 spring washers (35 KG). Approved knowledge includes Mumbai delivery, payment 30 days after accepted delivery, quotation validity 30 days, GST inclusion clarification and the KG-only rule. The negotiation-boundaries record exists but is not an exposed business-answer category.

Existing tools already support real database interactions: read these items and policies, prepare an exact pricing readback, commit supplier-confirmed rates, record quotation-later outcomes, schedule callbacks and persist opt-outs. They cannot answer real stock, PO, approval, logistics or full PC-status questions because those facts/tools are not represented in this service.

Recommended next schema increment, without connecting AutoRocket: source system/entity references; stage key and due date; recipient role; structured quotation deadline and commercial terms; explicit supported UOM/currency; per-field source/version timestamps. Populate new fictional scenarios aligned with those structures only after choosing which workflow to demonstrate. Keep PC supplier calls separate from internal assignee reminder calls.

## Latency evidence

Five sequential `getContext` reads from the local runtime to configured Turso took **124, 203, 126, 128, 151 ms**: median **128 ms**, range **124–203 ms**. This is a small diagnostic sample, not a p95 benchmark, cold-start measurement, or end-to-end audio latency result.

`getContext` makes two sequential database queries. The HTTP context tool additionally checks call scope and marks context loaded, so its complete latency is greater than this sample. Pricing confirmation involves more validation and transactional statements. None of these measurements establishes that the database is the largest part of audible response delay.

## Recommended order, preserving accuracy

1. Measure per-turn endpointing, LLM first response, tool/API/DB timing, and first audible speech separately. HTTP `durationMs` is already logged. The [ElevenLabs latency guide](https://elevenlabs.io/docs/eleven-api/concepts/latency) describes the multi-stage audio path; changing only the database cannot remove all that latency.
2. Reduce redundant SQL round trips first. Fetch call scope, requirement header and items using a scoped join or database batch with clear snapshot semantics. Batch quotation item writes inside the existing transaction. Keep version, item completeness, confirmation-token and consent checks authoritative.
3. Use a small per-call, tenant-scoped snapshot for already-read descriptions and speech formatting. Fetch fresh data at call start and revalidate authoritative requirement/quotation state before saving. Do not cache opt-out checks or price-confirmation decisions.
4. Keep concise spoken responses and narrowly scoped tools. Do not remove the readback/confirmation round trip merely to improve a latency number. Tune endpointing with noisy Hindi/Hinglish examples and retain correction handling. Model choice should balance latency and tool-call accuracy, as described in [ElevenLabs' prompting guide](https://elevenlabs.io/docs/eleven-agents/best-practices/prompting-guide).
5. Evaluate regional placement of the API, database and provider connections. A same-machine Redis instance cannot fix a long provider-to-tunnel path. A persistent local process/tunnel avoids startup failures; the free quick tunnel is still ephemeral.

## Redis: possible, not necessary yet

AutoRocket already has Redis cache utilities and BullMQ infrastructure. This standalone service has no Redis dependency or Redis configuration. Do not reuse AutoRocket's Redis instance without a separately authorized integration.

For a single-process local demo, bounded in-process caching of immutable/derived data is simpler. Add dedicated Redis when multiple service instances need a shared read cache, rate limits or work queue—not merely because voice latency exists.

Candidate cache key: `voice:v1:tenant:{tenantId}:requirement:{requirementId}:version:{version}`. Cache only approved minimal fields; validate call/tenant authorization first. Use explicit invalidation on writes, short bounded TTLs for mutable reference data, request coalescing, short Redis timeouts and fallback to the database. TTL alone does not guarantee freshness, especially when another writer changes the source. [Redis cache-aside documentation](https://redis.io/docs/latest/develop/use-cases/cache-aside/), [Redis consistency guidance](https://redis.io/blog/cache-consistency-strategies/).

Keep consent, authorization, current requirement versions, confirmation tokens, final rates, quotation commits, and durable call/event state in Turso as the authority. Never report a business write as successful merely because Redis accepted it. A versioned cache still needs a trustworthy way to know the current version.

Local database replication is another option, but introduces synchronization/freshness work. Turso's current docs say embedded replicas remain supported in production and recommend Turso Sync for new sync projects. Either approach requires a compatible client and a deliberate sync design; do not just add replica settings to the current serverless client. [Turso replica documentation](https://docs.turso.tech/features/embedded-replicas/introduction).

No Redis, replica, model change, latency optimization or AutoRocket connection was implemented during this review.

### Subsequent implementation: round trips and description cache

The later latency change combines requirement header/items into one scoped SQL query. The context HTTP tool now uses two database requests rather than four (scope and data together, then context-loaded marker). Pricing preview and commit reuse the scoped query, and quotation-line inserts use a batch inside the existing transaction. Current version and pricing validation are not removed.

A per-call description cache holds up to 128 entries for ten minutes, keyed by tenant/follow-up/call and invalidated by a fingerprint of fresh descriptive fields plus requirement version. It only caches descriptions and spoken rendering, not quantities, consent, policies, current-version decisions, rates or successful-write results. Every context request still reads current database data.

Follow-up sample: 1,355 ms for the first context read, followed by 29, 25, 26 and 26 ms. These samples were taken at a different time from the baseline; they do not establish an isolated cache speedup or audio-latency improvement. A non-mutating `vector_extract(vector32('[1,0]'))` probe succeeded on the configured database. This tests basic vector functions only, not approximate indexing, filtered retrieval quality or performance.

RAG and Redis remain unimplemented. Tests cover tenant/call scope, fresh quantity/version reads, cache expiry/isolation/refresh, and full quotation rollback on an injected batch failure.

## Cleanup performed

Removed five obsolete root files into private recovery directory `/tmp/voiceagent-cleanup-20260905-ROw5rh`: `.env.bak.1788519907`, `.env.bak.1788523578`, `.env.twilio`, `agent_config.original.json`, `agent_config.before-provision.json`. Recovery is possible while this temporary directory exists; the operating system may eventually clear it. Credentials were not printed or copied into this document.

Kept active `.env`, `.env.example`, `agent_config.json`, package/lockfile, TypeScript, Biome and Vitest configs. Future generated rollback snapshots go to ignored `data/private/backups/`. Updated the README to describe the current Scribe/GPT-4o/seven-tool configuration rather than the old Groq-only setup. No active agent settings or database records were changed.
