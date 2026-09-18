# Webex Compliance Monitoring System

A self-hosted compliance tool for **chaperoned Webex meetings**: a visible bot joins each
tracked meeting and streams its **live audio** to a web console where compliance officers listen
in real time. Built for a compliance desk that oversees calls between external analysts and
internal front-office staff: several meetings in progress at once, hop between them, and know
*instantly* when monitoring coverage breaks.

**Listen-only, by design. Nothing is recorded.** No audio is written to disk anywhere in the
system. The bot is a normal, named participant in the meeting roster (no hidden monitoring); its
display name is configurable.

Licensed under the [MIT License](LICENSE).

## How it works

```
Webex calendar ──sync──▶ meeting registry ──due──▶ headless Chromium joins via Webex JS SDK
                                                        │ guest identity, receive-only audio
officer browser ◀──WebSocket (Opus)── backend ◀──loopback WS── WebCodecs AudioEncoder (Opus)
       │
   Webex OAuth login + email allowlist            participant roster / join-leave
   (officers listen; admins manage)  ◀──polling── via Webex admin APIs
```

- **Backend** — Node 24 + Express + TypeScript, `node:sqlite` for persistence. Orchestrates bot
  lifecycle (dial, retry with capped backoff, fail-loud give-up), fans audio out over
  `/live/:meetingId` WebSockets, polls the Webex participants API for each live meeting's roster,
  and keeps an audit log (bot join/leave, officer listen start/stop).
- **Media** — one headless Chromium context per bot (Puppeteer), running the vendored Webex JS
  SDK on a loopback bot page. The bot joins each meeting as a **guest identity** (a token minted
  by the Service App), **receive-only**: no camera or mic is ever published. Remote meeting audio
  is captured with WebCodecs (`AudioEncoder`, Opus, 48 kHz mono, 20 ms frames) and streamed over
  a loopback WebSocket into the backend, which fans it out to the console. Per-bot media
  isolation is inherent (one Chromium context per meeting, no shared audio device), so
  per-meeting audio never cross-bleeds.
- **Console** — React 18 + Vite. Meeting overview, live listen view with audio meter and
  pause/resume, roster with join/leave history, settings, and a session listening log (every
  listen is also recorded server-side in the audit table).
- **Webex integration** — two Webex apps:
  - an **OAuth Integration** for officer/admin login (`spark:people_read` + email allowlists),
  - a **Service App** with admin scopes (`meeting:admin_schedule_read/write`,
    `meeting:admin_participants_read`) for calendar sync, rosters, and meeting creation, plus
    `guest-issuer:read` / `guest-issuer:write` — the scopes that let it mint the bot's guest
    tokens — all on a dedicated scheduler account. Tokens rotate automatically and live in sqlite.

## Console features

- **Overview** — Active meetings grid with per-bot status (non-color-reliant indicators), an
  Upcoming section from calendar sync, and a Past section: cleanly-ended meetings age out of
  Active; **failed bots stay pinned in Active for 15 minutes** so a fresh compliance gap cannot
  be buried (fail-loud is the core UI rule; the header badge counts every bot needing attention).
- **Live listening** — per-meeting audio with a 9-band level meter, pause/resume, free hopping
  between meetings; listening activity is logged.
- **Roster** — real join/leave times per participant, role-classified by authenticated email
  domain (*Internal Analyst* / *External Expert* / guests / the bot itself). **PSTN dial-ins**
  get a phone-glyph avatar and, when Webex exposes it, the full caller ID instead of the masked
  `8452****46` display name.
- **In-portal scheduling** (admin) — creates a real Webex meeting on the scheduler account
  (no-lobby, join-before-host, so the guest bot can auto-join via the Webex SDK), invites emailed by Webex.
- **View attendees for a failed join** — a bot-independent roster peek shows who is in a meeting
  even when the bot could not join it.
- **Ended-meeting history** — join/leave history is persisted, so an ended meeting opens as a
  frozen, read-only timeline (survives restarts). Roster precedence: live > peek > stored.
- **Admin controls** — remove meetings (two-step confirm), role-gated UI (officers never see
  admin controls).

### Participant roles

Participants are classified by the domain of their authenticated Webex email:

| Role key  | Console label     | Meaning                                                    |
|-----------|-------------------|------------------------------------------------------------|
| `fo`      | Internal Analyst  | Email domain is in `INTERNAL_EMAIL_DOMAINS` (front office) |
| `analyst` | External Expert   | Any other authenticated Webex user                          |
| `bot`     | Compliance bot    | Display name matches `BOT_DISPLAY_NAME`                     |
| `other`   | Guest             | Unauthenticated or PSTN participant                         |

The role keys are stored in the database and returned by the API; the labels are UI-only and easy
to change in `frontend/src/components/chaperone/AttendeesPanel.tsx`.

## Bot lifecycle safeguards

- **Auto-register + auto-join** at scheduled start (manual registration wins conflicts).
- **Solitude hang-up** — if the bot is the only live participant for a grace period
  (default 10 min), it hangs up rather than listening to an empty room. The timer freezes rather
  than acts when roster polling is blind (never hang up on missing data).
- **Definitive meeting-end detection** — a Webex 404 on the participant poll concludes the
  meeting immediately instead of leaving a phantom "connected" bot.
- **Chaperone-gap detection** *(designed, not yet built)* — if a meeting is ended by accident and
  humans rejoin, detect "humans present, bot absent," auto-rejoin within the scheduled window, and
  prompt the officer loudly otherwise.

## Status

The bot join/media path runs on the **Webex JS SDK** in headless Chromium with a guest identity.
It is **validated live**: a guest bot joins a real Webex meeting, captures the room audio (a single
server-mixed "transcoded" stream, encoded to Opus in-browser), and streams it to the console in
real time.

Test suites: **backend 350, frontend 498**, TypeScript strict, production build clean. Dev mock
mode (`VITE_MOCK`) is tree-shaken out of production bundles.

**Known limitations (honest list):**

- **Concurrent meetings are implemented but not yet proven live.** Per-meeting audio isolation
  is inherent (one Chromium context each), and every bot mints its own Webex guest identity
  (`WEBEX_GUEST_SUBJECT_PREFIX` plus a digest of the meeting id) so two bots no longer collide at
  the Webex device level. Unit tests pin the invariants; two simultaneous real meetings have not
  yet been validated end to end.
- **The guest bot needs meetings with no waiting room.** An org that lobbies guests holds the bot
  in the waiting room until a host admits it. Schedule chaperoned meetings with no waiting room, or
  run the bot under a licensed machine account (the token seam supports it) so it isn't treated as
  a guest.
- **No live captions yet.** The SDK exposes real-time transcript events (which require Webex
  Assistant licensing), but surfacing them in the console is a separate build.
- Full PSTN caller-ID visibility depends on what the Webex participants API returns; the masked
  name is the graceful fallback.
- Meeting policies such as disabling video or screen-share are **not** set by this app (Webex
  rejects those at meeting-create); they're a Control Hub site/account policy on the scheduler
  account.

## Repository layout

```
backend/          Express/TS API, bot orchestration, media pipeline, sqlite
frontend/         React console (Vite; `npm run dev:mock` = full UI on seeded data, no Webex)
bot-page/         loopback bot page the headless Chromium loads (vendored Webex JS SDK)
docker/           container entrypoint
Dockerfile        multi-stage Node 24 + headless-Chromium image
docker-compose.example.yml  reference single-container compose (copy and fill in placeholders)
scripts/          deploy-zip builder (source-only, secret-free, verified at build time)
PRODUCT.md        product strategy + design principles   DESIGN.md  visual system
```

## Running it

**Dev:** `cd backend && npm i && npm run dev` and `cd frontend && npm i && npm run dev`
(or `npm run dev:mock` for the console alone, no Webex credentials needed).

**Config:** copy `backend/.env.example` to `backend/.env` and fill in the two Webex apps,
allowlists, bot identity (`BOT_DISPLAY_NAME`; the legacy `SIP_LOCAL_URI`/`SIP_TRANSPORT` values
are kept only for identity/audit continuity), the SDK bot runtime (`BOT_PAGE_ASSET_DIR`,
`CHROMIUM_PATH`, `BOT_MEDIA_MODE`, join-retry tuning), `CALENDAR_SYNC_ENABLED`, and
sync/poll/solitude intervals. Nothing Webex-site-specific or bot-identity-specific is hardcoded.

**Deploy with Docker Compose:**

```bash
cp docker-compose.example.yml docker-compose.yml   # edit hostnames, TZ, volume paths
cp backend/.env.example .env                        # fill in secrets
docker compose up -d --build
curl -fsS http://localhost:4000/health
```

`bash scripts/make-deploy-zip.sh` builds a source-only zip for hosts without git access. It
never contains `.env` (enforced by the script). Put a TLS-terminating reverse proxy or tunnel in
front of the container and set `APP_BASE_URL` and `WEBEX_OAUTH_REDIRECT_URI` to the public
hostname.

## Deploying on Kubernetes / enterprise infra

The reference deployment is single-host Docker Compose; everything it does translates. What an
implementer needs to know:

**Process model.** One container runs the Node app plus one **headless Chromium context per
active bot** (Puppeteer), each loading the vendored Webex JS SDK on a loopback origin
(`127.0.0.1`, never exposed publicly). No privileged mode, no host audio devices, no extra
capabilities: the bot's media is captured entirely in-browser via WebCodecs, not through any
system audio device. Per-meeting media isolation is inherent (one Chromium context per meeting,
no shared process or device), and each bot has its own Webex guest identity (see Known
limitations for the validation status of concurrent meetings).

**Networking.**

- The bot's media is **WebRTC**, initiated outbound from the browser exactly like a normal
  Webex web-client join: no inbound listener of any kind, no fixed UDP port range to manage.
- On K8s that means standard pod networking is sufficient (no `hostNetwork: true`), as long as
  the CNI/egress NAT keeps outbound UDP flows pinned for the duration of a call (typical). No
  Service or Ingress is involved in media.
- Egress firewall: allow HTTPS to `webexapis.com` and outbound UDP to Webex's media clouds
  (dynamic Cisco IP ranges; prefer domain-based egress rules such as `*.webex.com`/`*.wbx2.com`
  over fixed IPs if outbound filtering is ever enabled).
- The console is **one origin** on `PORT`: SPA + REST + the `/live` WebSocket. Any WS-capable
  ingress works; terminate TLS at the edge and set `APP_BASE_URL` / `WEBEX_OAUTH_REDIRECT_URI`
  to the public hostname.
- Chromium needs real `/dev/shm`. The container/pod default (often 64 MB) is too small for
  sustained headless use; 1 GB is a safe floor (see `shm_size` in the example compose).

**State & scaling.** Persistence is a single sqlite file (WAL) at `DATABASE_PATH`; mount a
ReadWriteOnce PVC. Live state (roster cache, WebSocket hubs, bot processes) is in-process, so
this is a **single-replica** workload: use a `Recreate` deployment strategy (two replicas would
double-dial every meeting). Horizontal scale-out is not supported; scaling today means sharding
meeting sets across independent instances.

**Config & secrets.** All configuration is the env vars in `backend/.env.example`; map to a
Secret/ConfigMap. The Service-App refresh token is bootstrap-only; rotated tokens persist to
sqlite thereafter.

**Probes & observability.** Unauthenticated `GET /health` (registered before the auth layer) for
liveness/readiness. Logs go to stdout/stderr with a deliberate fail-loud convention: errors are
prominent and greppable, and no tokens, passcodes, or phone numbers are ever logged.

**Identity.** Login is Webex OAuth + an email allowlist. If the org standard is a different IdP,
the auth layer is a self-contained Express router behind a `requireRole` seam, swappable without
touching the rest of the system.

**Bot identity.** The bot joins with a Webex guest token minted by the Service App behind a
swappable provider seam. An enterprise deploy can substitute a licensed machine account so the
bot is not subject to guest waiting-room policy.

**Webex org prerequisites.** Two Webex apps (an OAuth Integration for console login and an
org-admin-authorized Service App carrying both the admin meeting scopes **and**
`guest-issuer:read` / `guest-issuer:write` — the scopes that let it mint the bot's guest tokens),
plus a dedicated scheduler account that owns the chaperoned meetings. Service-App authorization is
a Control Hub admin action; scope changes require re-authorization. Note that scopes are baked into
a token at issuance, so after adding a scope you must **regenerate the Service App's refresh
token** for the new scope to take effect.

## Security & compliance posture

- No recording, anywhere. Live listening only, and every listen is auditable.
- Meeting passcodes (the `dtmf` field, used for Webex JS SDK password verification at join
  time) are **redacted from every API response**; tokens and phone numbers are never logged.
- Console access = Webex OAuth **and** an explicit email allowlist; admin actions are
  role-gated server-side.
- The bot is always visible in the meeting roster. This tool does not do covert monitoring.

## Contributing

Issues and pull requests are welcome. Run both test suites (`npm test` in `backend/` and
`frontend/`) and the TypeScript check before opening a PR.
