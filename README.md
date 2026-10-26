# Hushly — Quiet Nearby Chat & Social Discovery

Anonymous, mobile-first social discovery: see **everyone who's online** in the People directory,
find people **Nearby**, share 24-hour **Stories**, and connect through **invite codes** — with
no phone number, no email, and no password. No matching algorithms: pick a person, tap, chat.

## Feature overview

| Area | What works |
|---|---|
| **Anonymous identity** | Instant identity on first visit (httpOnly cookie session), optional recovery code restore, optional avatar, display name. Internal ids never exposed — users see `publicId` (`GX-XXXXXX`). |
| **Nearby discovery** | Opt-in location sharing, radius presets 5 m – 5 km + custom slider, haversine distance with rounded/approximate labels (10/25/100 m buckets), server-side presence filter, freshness threshold (15 min), pause visibility deletes stored coordinates immediately. |
| **Presence** | socket.io connections + heartbeats + server-side expiry (75 s grace). No client-side booleans. Live online/last-seen in chat headers and nearby lists. |
| **People (online directory)** | Live list of every online user (server-side presence, no matching/queue). One tap opens a chat instantly — existing conversations re-open instead of duplicating. Independent "Show me in People" visibility toggle; blocks filter both directions; list updates in realtime via `presence:update`. |
| **Online notifications** | Push alerts when someone visible in People comes online, enabled by default. Choose anyone or friends (saved contacts) in Profile; separate from chat notifications and requires push to be enabled on a device. |
| **Messaging** | Realtime socket path with HTTP fallback, text + image + video, long-press message actions (reply, edit, delete for you/everyone), delivery/Read receipts (single/double check), typing indicators, cursor pagination, optimistic sending with retry, per-conversation media authorization. |
| **Chat expiration** | Shared conversation-level policy: new direct chats default to 24 h; 3 months or never can be selected instead. Server-computed `expiresAt`, expired chats reject messages (410), scheduled sweep deletes conversations + messages + media, "expiring soon" warnings. Either participant can change the policy (broadcast to both). |
| **Stories** | Text/image/video, default 24 h server-enforced lifetime, audience **Public** / **Friends only** (one-way saved contacts), view tracking with owner-only viewer list, story tray with unseen rings, full-screen viewer with progress bars. |
| **Buzz** | Public text posts are removed from the feed at 90 days and deleted from the database by the scheduled cleanup; comments and votes are deleted with each post. |
| **Invite codes** | Unique code per user (`XXXX-XXXX`), rotate (revoke), share link `/?invite=CODE`, deep-link redemption dialog with expiration choice. Never bypasses blocks. |
| **Contacts** | One-way saved contacts, private nicknames ("Person from the library") visible only to the namer, removal clears alias. Nickname does not change the other user's display name. |
| **Safety** | Block (stops People listing, discovery, invites, messaging — both directions), report with reason + details, token-guarded moderation review API, rate limits on every sensitive action, upload validation (MIME + magic-byte sniffing + size caps), account deletion erasing all data. |

## Stack

Postgres (Supabase) + Prisma, with the sandbox specifics documented per concern:

| Concern | Implementation |
|---|---|
| Database | **Supabase PostgreSQL** + Prisma (`provider = "postgresql"`, pooled `url` + direct `directUrl`) |
| Nearby queries | Bounding-box prefilter + haversine filter in JS (`src/lib/geo.ts`), radii ≤ 5 km — optional upgrade: `ST_DWithin(loc, pt, radius)` with a GiST index on `Location` |
| Realtime | Dedicated socket.io service (`mini-services/realtime`, port 3003 via gateway in sandbox; boots in-process via `src/instrumentation.ts`) |
| Media storage | Local `uploads/` served only through authorized `GET /api/files/[id]` — swap to S3/GCS behind the same authorization helper |
| Anonymous Auth | Cookie sessions + `sessions` table (token + separate `socketToken`) |
| Web Push | VAPID keys from env (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`); private key never ships to the client |

Messages are **not** end-to-end encrypted (stated in-app); they travel over TLS in production and
are stored until expiration.

## Architecture

```
Browser ──► Caddy gateway (:81)
             ├─ /                    ──► Next.js 16 app (:3000)   UI + all REST APIs
             │        └─ in-process realtime service (:3003 socket.io, :3004 loopback notify)
             └─ /?XTransformPort=3003 ──► realtime service (same process)
```

- `src/instrumentation.ts` boots the realtime service **inside** the Next.js process in this
  sandbox (the standalone `mini-services/realtime` entry remains for production; a port guard
  makes the two mutually exclusive).
- API routes are the authorization boundary: participants-only message reads, audience-checked
  story media, distance-only location exposure.

## Running locally

```bash
bun install            # also runs `prisma generate` (postinstall)
bun run db:push        # create/sync schema on Supabase Postgres (uses DIRECT_URL)
bun run dev            # Next.js on :3000 (realtime boots in-process on :3003)
# standalone realtime (optional, e.g. separate host):
cd mini-services/realtime && bun install && bun run dev
```

Environment variables (see `.env`):

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Supabase **pooled** connection string (port 6543) — app runtime + Vercel |
| `DIRECT_URL` | — | Supabase **direct** connection string (port 5432) — `prisma db push` / `migrate` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | _(unset = push disabled)_ | Web Push signing keys |
| `INTERNAL_TOKEN` | `ghostline-internal-dev` | Shared secret for the loopback notify endpoint (`:3004`) |
| `INTERNAL_NOTIFY_URL` | `http://127.0.0.1:3004/notify` | Where API routes push realtime events |
| `MODERATION_TOKEN` | _(unset = review API disabled)_ | Bearer token for `GET/PATCH /api/moderation/reports` |
| `UPLOAD_DIR` | `./uploads` | Media storage root |

## Moderation review process

Abuse reports land in `abuse_reports` (`open` → `reviewing` → `resolved`/`dismissed`).

```bash
curl -H "Authorization: Bearer $MODERATION_TOKEN" http://host/api/moderation/reports?status=open
curl -X PATCH -H "Authorization: Bearer $MODERATION_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"reportId":"…","status":"resolved"}' http://host/api/moderation/reports
```

Without `MODERATION_TOKEN` the endpoint returns 503 (review directly in the DB).

## Deploying to Render (two web services + Supabase)

`render.yaml` (repo root) is a Blueprint defining both services. In the Render
dashboard: **New → Blueprint → connect the repo** — it creates:

1. **ghostline-web** — Next.js (`npm install && npm run build` → `npm run start:node`,
   health check `/api/health`). Env vars: `DATABASE_URL` (Supabase pooled 6543,
   `?pgbouncer=true&sslmode=require`), `DIRECT_URL` (session pooler 5432),
   `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, `INTERNAL_TOKEN`, plus after the
   realtime service exists: `INTERNAL_NOTIFY_URL` (its `/notify` URL) and
   `NEXT_PUBLIC_REALTIME_URL` (its origin — set before building, it inlines
   into the client bundle). `DISABLE_INPROCESS_REALTIME=1` is preset.
2. **ghostline-realtime** — `mini-services/realtime` on a pinned bun
   (health check `/healthz`, socket.io under `/rt/socket.io`, token-guarded
   `/notify` on the same public port). Env vars: `DATABASE_URL`, `DIRECT_URL`,
   `INTERNAL_TOKEN`, `VAPID_*`.

Deploy the realtime service first, then set the two cross-service vars on the
web service and redeploy. Caveats: free plan spins services down when idle
(use starter for an always-on chat/presence app); the default disk is
ephemeral, so move `uploads/` to object storage or attach a persistent disk
before relying on media.

## Production deployment checklist

1. **Supabase**: create the project, copy both connection strings (Settings → Database), run
   `bun run db:push` once against it. `DATABASE_URL` = pooled (6543), `DIRECT_URL` = direct (5432).
2. **Vercel**: set `DATABASE_URL`, `DIRECT_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and a
   strong `INTERNAL_TOKEN` in Project → Settings → Environment Variables. `prisma generate` runs
   via the `postinstall` hook during the build.
3. **Realtime does not run on Vercel serverless** — host `mini-services/realtime` on a
   long-running runtime (Railway/Fly/VPS), put it behind TLS, set `INTERNAL_NOTIFY_URL` to its
   internal notify endpoint, and point the client socket at it.
4. Serve behind TLS (cookie `secure` activates automatically with `NODE_ENV=production`).
5. Move `uploads/` to object storage (keep `GET /api/files/[id]` as the only public door).
6. Run the cleanup sweeps (conversation/story/post expiry, presence, orphan files) on a schedule —
   the realtime service already runs them every 60 s / hourly.
7. Scale note: presence fan-out and People queries are per-process; move presence state to
   Redis (or Postgres) before running multiple realtime instances.
8. Age policy: the app states 13+ during onboarding and offers an `underage` report reason;
   align retention/moderation policy with your jurisdiction before launch.

## Verified end-to-end (two anonymous sessions + a scripted realtime probe)

New-user onboarding → identity persistence → **People directory: online user appears live,
one-tap chat opens/creates conversation, message + reply delivered in realtime, offline
transition removes the person from the list** → visibility toggle hides/shows the user in
others' People lists → nearby discovery with radius selection → realtime text messaging with
read receipts → conversation expiration policy change → story creation + audience enforcement
→ invite redemption → block (People listing, invites, messaging all denied) → report stored
→ recovery-code identity restore → rate limits → account deletion path.
