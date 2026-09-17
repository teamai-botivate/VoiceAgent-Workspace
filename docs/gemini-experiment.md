# Gemini Live with Google ADK

A standalone Bun/TypeScript experiment on port 3200. The existing ElevenLabs
server on 3100, its scheduler, agent configuration, commands and public URL are
unchanged. There is no AutoRocket integration.

## Start and call

1. Save `GEMINI_API_KEY` in `.env` (never commit it).
2. Run `bun run gemini:check`: opens ADK Live, requests a brief synthetic greeting,
   verifies returned PCM audio, then closes without dialing.
3. Run `cloudflared tunnel --url http://localhost:3200` in another terminal.
4. Set `GEMINI_PUBLIC_BASE_URL` to its HTTPS address. Do not change the ElevenLabs
   `PUBLIC_BASE_URL`. `GEMINI_PORT` defaults to 3200 and `GEMINI_LIVE_MODEL` defaults
   to `gemini-2.5-flash-native-audio-latest`.
5. Run `bun run gemini:start`.
6. Check `curl --fail http://localhost:3200/health/live`; it reports
   `engine: google-adk`.
7. With the caller's permission and existing Twilio credit, run
   `bun run gemini:call -- +917499938218`.

Keep the server and tunnel running. Trial destinations must be verified in Twilio
and approved/allowlisted locally. Outbound URLs are supplied per call: incoming
Twilio number configuration is not changed. No automatic Gemini calling scheduler
is enabled. Follow-up sessions share the existing active-call guard; do not run
ElevenLabs and Gemini simultaneously against the same demo follow-up.

## Architecture

Twilio bidirectional Media Streams ↔ Bun gateway ↔ Google ADK
(`LlmAgent`, seven `FunctionTool` instances, `InMemoryRunner.runLive`,
`LiveRequestQueue`) ↔ Gemini native audio.

ADK owns the Live session and model tool execution. It receives no Turso
credentials or arbitrary SQL tool. Tools dispatch to the existing authenticated
business routes in-process; trusted tenant/follow-up/call-session identity is
bound in server-side closures and overrides any model arguments. Existing
consent, approved destinations, current requirement versions, per-call description
caches and pricing preview/confirmation/commit rules remain authoritative.

An adapter dispatches Gemini 2.5 tool-call packets immediately: ADK 2.1.0's
default aggregator otherwise waits for turn completion while Gemini waits for
tool results. Live Schema declarations remove unsupported non-string enums;
the original Zod constraints still validate execution. Retest these adapters
when upgrading ADK or changing models.

The gateway verifies HTTP callbacks and WebSocket handshake signatures with
Twilio's SDK and a configured origin, never caller-controlled Host headers.
WebSocket validation accepts exact/slash HTTPS and WSS variants, with the same
secret required for every accepted variant. Short-lived, single-use stream
capabilities bind connections to the outbound CallSid. Expired, forged, unbound
and duplicate handshakes fail closed and log distinct safe reason codes.
Stream-status callbacks report stream errors; inspect Twilio Debugger for details.

Input μ-law 8 kHz converts to PCM16 16 kHz. Output PCM16 24 kHz converts to μ-law
8 kHz and up-to-20 ms frames. Interruption events clear Twilio playback buffers.
After successful finalization and the model's goodbye, a Twilio mark acknowledgement
allows the bridge to close after queued speech plays. The gateway closes on invalid
audio, overload, provider failure or caller disconnect; it never silently redials.

## Non-dialing gateway probe

With the actual Gemini server stopped, keep its tunnel running and execute
`bun run gemini:probe`. The diagnostic executable temporarily listens on the same
port, simulates a signed Twilio handshake through Cloudflare and requests two
ADK tools before accepting returned speech as success.

This probe uses hard-coded fixtures only: no Turso connection, call creation,
pricing writes or business outcomes. It is not a public diagnostic route on the
actual application. Its fixture tools still require the agent-tool secret.

Only with explicit authorization to export dummy data to Gemini, run
`bun run gemini:probe -- --turso-readonly` instead. This reads existing demo
context and payment terms directly through read-only repository methods;
it skips the serving route's context-loaded write. All other tools reject writes.
Neither probe dials nor creates a call session. Tool retrieval plus audio does
not prove spoken factual accuracy; verify that in a human test call.

## Verification and limits

Unit/integration tests cover μ-law conversion, chunk boundaries, pricing guards,
trusted identity, exact/slash signatures, invalid/expired/duplicate/unbound
connections, mismatched CallSid, bidirectional gateway audio, interruptions and
bounded ADK input. Run `bun run typecheck`, `bun run test`, and `bun run build`.
WebSocket integration tests require permission to bind localhost sockets.

Calls are capped at five minutes and four pending/active sessions per process.
ADK setup times out after twenty seconds; its input queue is bounded to two
seconds. Outbound socket buffering is bounded too. ADK sessions and transcripts
are in memory and deleted at teardown; no raw audio/transcript logging or artifacts.
Logs contain lifecycle codes and first-audio/tool timings only.

Live API and ADK runLive are experimental APIs; dependency versions are recorded in
bun.lock. The lightweight resampler needs quality benchmarking before production.
Health/live is not a guarantee of quota or tunnel readiness. Live-session resumption,
durable stream capabilities and Gemini post-call analytics are not implemented.
Repository call records retain the legacy provider default; Gemini calls are
identified by this endpoint and transport event payload. A transport completion
does not prove that a business outcome was committed.

A synthetic probe proves gateway/ADK plumbing, not real Twilio handshake behavior
or human speech quality. A real test call remains necessary to verify those.
Only dummy, explicitly approved data should be sent to Gemini free-tier services;
Google may use free-tier content to improve products. Twilio calls consume credit.
