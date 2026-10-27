# Hushly — Quiet Nearby Chat & Social Discovery

Anonymous, mobile-first social discovery: see **everyone who's online** in the People directory,
find people **Nearby**, share 24-hour **Stories**, and connect through **invite codes** — with
no phone number, no email, and no password. No matching algorithms: pick a person, tap, chat.

## Feature overview

| Area | What works |
|---|---|
| **Anonymous identity** | Instant identity on first visit (httpOnly cookie session), optional recovery code restore, optional avatar, display name. Internal ids never exposed — users see `publicId` (`GX-XXXXXX`). |
| **Nearby discovery** | Opt-in location sharing, radius presets 5 m – 5 km + custom slider, haversine distance with rounded/approximate labels (10/25/100 m buckets), server-side presence filter, freshness threshold (15 min), pause visibility deletes stored coordinates immediately. |
| **Presence** | Socket.IO connections + heartbeats + server-side expiry (75 s grace). No client-side booleans. Live online/last-seen in chat headers and nearby lists. |
| **People (online directory)** | Live list of every online user (server-side presence, no matching/queue). One tap opens a chat instantly — existing conversations re-open instead of duplicating. Independent "Show me in People" visibility toggle; blocks filter both directions; list updates in realtime via `presence:update`. |
| **Online notifications** | Push alerts when someone visible in People comes online, enabled by default. Choose anyone or friends (saved contacts) in Profile; separate from chat notifications and requires push to be enabled on a device. |
| **Messaging** | Firestore event listeners plus Socket.IO compatibility for presence, typing, and socket-originated messages; text + image + video, long-press message actions (reply, edit, delete for you/everyone), delivery/Read receipts, cursor pagination, optimistic sending with retry, per-conversation media authorization. |
| **Chat expiration** | Shared conversation-level policy: new direct chats default to 24 h; 3 months or never can be selected instead. Server-computed `expiresAt`, expired chats reject messages (410), scheduled sweep deletes conversations + messages + media, "expiring soon" warnings. Either participant can change the policy (broadcast to both). |
| **Stories** | Text/image/video, default 24 h server-enforced lifetime, audience **Public** / **Friends only** (one-way saved contacts), view tracking with owner-only viewer list, story tray with unseen rings, full-screen viewer with progress bars. |
| **Buzz** | Public text posts are removed from the feed at 90 days and deleted from the database by the scheduled cleanup; comments and votes are deleted with each post. |
| **Invite codes** | Unique code per user (`XXXX-XXXX`), rotate (revoke), share link `/?invite=CODE`, deep-link redemption dialog with expiration choice. Never bypasses blocks. |
| **Contacts** | One-way saved contacts, private nicknames ("Person from the library") visible only to the namer, removal clears alias. Nickname does not change the other user's display name. |
| **Safety** | Block (stops People listing, discovery, invites, messaging — both directions), report with reason + details, token-guarded moderation review API, rate limits on every sensitive action, upload validation (MIME + magic-byte sniffing + size caps), account deletion erasing all data. |

## Stack

Cloud SQL for PostgreSQL + Prisma, Firebase App Hosting, and Firebase Storage:

| Concern | Implementation |
|---|---|
| Database | **Google Cloud SQL for PostgreSQL** + Prisma (`provider = "postgresql"`) |
| Nearby queries | Bounding-box prefilter + haversine filter in JS (`src/lib/geo.ts`), radii ≤ 5 km — optional upgrade: `ST_DWithin(loc, pt, radius)` with a GiST index on `Location` |
| Realtime | Firestore listeners for API notifications; Socket.IO service (`mini-services/realtime`) handles presence, typing, and socket-originated messages |
| Media storage | Private Firebase Storage bucket served only through authorized `GET /api/files/[id]` |
| Anonymous Auth | Cookie sessions + `sessions` table, bridged to Firebase Authentication with custom tokens for Firestore listener rules |
| Web Push | VAPID keys from env (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`); private key never ships to the client |

Messages are **not** end-to-end encrypted (stated in-app); they travel over TLS in production and
are stored until expiration.

## Architecture

```
Browser ──► Firebase App Hosting ──► Next.js 16 app (UI + all REST APIs)
                                      ├─ Cloud SQL for PostgreSQL (Prisma)
                                      ├─ Firebase Storage (private media)
                                      └─ Firestore (realtime event fan-out)
Browser ──► dedicated realtime compatibility service on Cloud Run
```

- The realtime service must run on a long-lived WebSocket-capable service; Firebase App Hosting
  runs the Next.js app and does not replace the standalone realtime process.
- API routes are the authorization boundary: participants-only message reads, audience-checked
  story media, distance-only location exposure.

## Running locally

```bash
bun install            # also runs `prisma generate` (postinstall)
bun run db:push        # create/sync schema on the PostgreSQL URL in .env
bun run dev            # Next.js on :3000 (realtime boots in-process)
# Optional: run the standalone realtime service instead.
DISABLE_INPROCESS_REALTIME=1 bun run dev
cd mini-services/realtime && bun install && bun run dev
```

Environment variables (see `.env`):

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Cloud SQL PostgreSQL connection string for app runtime |
| `DIRECT_URL` | — | Cloud SQL PostgreSQL connection string for Prisma schema changes |
| `GOOGLE_CLOUD_PROJECT` | — | Firebase / Google Cloud project ID |
| `CLOUD_SQL_CONNECTION_NAME` | — | Cloud SQL instance connection name (`project:region:instance`) |
| `FIREBASE_STORAGE_BUCKET` | — | Firebase Storage bucket used for private media |
| `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID` | — | Firebase web-app config for Firestore listeners |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | _(unset = push disabled)_ | Web Push signing keys |
| `INTERNAL_TOKEN` | `ghostline-internal-dev` | Shared secret for the realtime notify endpoint |
| `INTERNAL_NOTIFY_URL` | `http://127.0.0.1:3004/notify` | Realtime service notify URL |
| `NEXT_PUBLIC_REALTIME_URL` | — | Public origin of the dedicated realtime service |
| `MODERATION_TOKEN` | _(unset = review API disabled)_ | Bearer token for `GET/PATCH /api/moderation/reports` |
| `UPLOAD_DIR` | `./uploads` | Legacy media source directory used during migration |

## Moderation review process

Abuse reports land in `abuse_reports` (`open` → `reviewing` → `resolved`/`dismissed`).

```bash
curl -H "Authorization: Bearer $MODERATION_TOKEN" http://host/api/moderation/reports?status=open
curl -X PATCH -H "Authorization: Bearer $MODERATION_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"reportId":"…","status":"resolved"}' http://host/api/moderation/reports
```

Without `MODERATION_TOKEN` the endpoint returns 503 (review directly in the DB).

## Firebase / Google Cloud deployment

1. Create a Firebase project and enable Firebase App Hosting, Firebase Authentication, Cloud
   Firestore, Firebase Storage, and Secret Manager. Enable custom-token authentication. Create a
   Cloud SQL for PostgreSQL instance and a database/user for Ghostline.
2. Set `DATABASE_URL` and `DIRECT_URL` as App Hosting secrets and set
   `CLOUD_SQL_CONNECTION_NAME` to `project:region:instance`. Grant the App Hosting service account
   the Cloud SQL Client role. The app uses the Cloud SQL Connector; do not expose the database to
   `0.0.0.0/0`.
3. Replace the Firebase project, storage bucket, and Firebase web-app config placeholders in
   `apphosting.yaml`. Store `INTERNAL_TOKEN`, `INTERNAL_NOTIFY_URL`, `NEXT_PUBLIC_REALTIME_URL`,
   `VAPID_PUBLIC_KEY`, and `VAPID_PRIVATE_KEY` as App Hosting secrets as appropriate. Grant the
   App Hosting service account Cloud SQL Client, Firebase Storage Object Admin, and Service Account
   Token Creator roles.
4. Create an App Hosting backend from the Firebase console, connect the repository, and deploy.
   The health check is `/api/health`.
5. Create an Artifact Registry repository named `ghostline`, then build the realtime image:

   ```bash
   gcloud builds submit --config cloudbuild.yaml .
   gcloud run deploy ghostline-realtime \
     --image us-central1-docker.pkg.dev/hushly-613a4/ghostline/realtime:latest \
     --region us-central1 --port 3003 --timeout 3600 --max 10 \
     --allow-unauthenticated \
     --set-env-vars CLOUD_SQL_CONNECTION_NAME=hushly-613a4:REGION:INSTANCE,GOOGLE_CLOUD_PROJECT=hushly-613a4,FIREBASE_STORAGE_BUCKET=BUCKET_NAME \
     --set-secrets DATABASE_URL=DATABASE_URL:latest,INTERNAL_TOKEN=INTERNAL_TOKEN:latest,VAPID_PUBLIC_KEY=VAPID_PUBLIC_KEY:latest,VAPID_PRIVATE_KEY=VAPID_PRIVATE_KEY:latest
   ```

   Grant its service account Cloud SQL Client, Firebase Storage Object Admin, and Service Account
   Token Creator roles. Set the
   resulting Cloud Run URL in `INTERNAL_NOTIFY_URL` and `NEXT_PUBLIC_REALTIME_URL`; redeploy the
   App Hosting backend after setting the latter because it is inlined during the build.
6. Copy existing Supabase data to an empty Cloud SQL database using
   `scripts/migrate-postgres.ps1` with `SOURCE_DATABASE_URL` and `TARGET_DATABASE_URL` set.
   Run this before switching App Hosting's `DATABASE_URL`; the script refuses a non-empty target.
7. Migrate local media to Firebase Storage with `bun run scripts/migrate-media.ts` while
   `DATABASE_URL` points to the imported Cloud SQL database and `UPLOAD_DIR` points to the old
   media directory. Verify the migration before deleting any old storage.
8. Configure Firestore TTL deletion on `expireAt` for `realtimeUsers/*/events` and
   `realtimeBroadcasts`, then deploy the Firebase rules with
   `firebase deploy --only firestore:rules,storage`.
9. Serve behind TLS (cookie `secure` activates automatically with `NODE_ENV=production`) and
   schedule the existing cleanup sweeps (conversation/story/post expiry, presence, orphan files).
10. Age policy: the app states 13+ during onboarding and offers an `underage` report reason;
   align retention/moderation policy with your jurisdiction before launch.

## Verified end-to-end (two anonymous sessions + a scripted realtime probe)

New-user onboarding → identity persistence → **People directory: online user appears live,
one-tap chat opens/creates conversation, message + reply delivered in realtime, offline
transition removes the person from the list** → visibility toggle hides/shows the user in
others' People lists → nearby discovery with radius selection → realtime text messaging with
read receipts → conversation expiration policy change → story creation + audience enforcement
→ invite redemption → block (People listing, invites, messaging all denied) → report stored
→ recovery-code identity restore → rate limits → account deletion path.
