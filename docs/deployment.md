# Docker deployment

This deploys the standalone ADK/Gemini gateway. ElevenLabs and AutoRocket are
not reconfigured. The same Docker image can run ElevenLabs via its default CMD,
but Compose intentionally runs Gemini only. Do not enable an automatic calling
scheduler during testing.

Requires a Docker-capable Linux VPS, Docker Compose, and a domain whose A record
points to that VPS. Hostinger managed Cloud hosting is not equivalent to a VPS;
verify Docker and persistent WebSocket support before deployment. Inspect existing
services before binding ports 80/443; use the existing reverse proxy if occupied.

1. Clone the public source repository on the server.
2. Create `.env` on the server using `.env.example` as a reference. Transfer API
   credentials over authenticated SSH only, never Git. Restrict permissions with
   `chmod 600 .env`. The Docker build context excludes secrets and local configs.
3. Set `VOICE_DOMAIN=voice.yourdomain.com` and
   `GEMINI_PUBLIC_BASE_URL=https://voice.yourdomain.com` in the server `.env`.
   Keep `SCHEDULER_ENABLED=false`. Configure the existing remote Turso demo database,
   Gemini/Twilio keys, internal authentication token and agent-tool secret.
   Never expose INTERNAL_API_TOKEN in a frontend or public repository.
4. Run `docker compose --profile https up -d --build` after confirming ports
   are available. Caddy provisions HTTPS and proxies WebSocket upgrades automatically.
5. Check `docker compose ps`, `docker compose logs --tail=100 gemini` and
   `curl --fail https://voice.yourdomain.com/health/live`.
6. Place a single authorized test call through the authenticated
   `/internal/gemini/calls` endpoint, or run
   `sudo docker compose exec -T gemini bun deploy/call-gemini.ts +<approved-number>`.
   This uses container environment credentials; it needs no host Bun installation.

The runtime image has no development scripts, API keys or source maps containing
credentials. Source maps describe code only. Health checks prove liveness, not
provider quota or spoken accuracy. This remains an experimental single-instance
gateway: live sessions and stream tokens are in memory. Updates/restarts interrupt
active calls; drain and verify no active calls before `docker compose up -d --build`.

No Cloudflare development tunnel is needed once the stable HTTPS domain is working.
Do not overwrite the ElevenLabs `PUBLIC_BASE_URL` with Gemini's URL.

## Temporary demo without a domain

Run `docker compose --profile demo up -d --build`. Read the generated HTTPS URL
using `docker compose logs demo-tunnel`, update the server's
`GEMINI_PUBLIC_BASE_URL` to that address, then run
`docker compose up -d --no-deps gemini` to reload environment configuration.
This does not use ports 80/443 or alter existing reverse proxies. The tunnel
address can change when the tunnel container restarts; repeat the URL update then.
Keep `.env` restricted to mode 600. No API key belongs in a public Git repository.
