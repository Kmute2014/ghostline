# Project Worklog — "Ghostline" Anonymous Location Chat & Social Discovery App

Shared worklog. Each agent MUST read this file before working and append a section (starting with `---`) after finishing its Task ID.

## Architecture Decisions (read first)

- **Stack adaptation** (allowed by spec §2 "adapt while preserving functional requirements"):
  - Supabase → Next.js 16 API routes + Prisma + SQLite (sandbox DB). Production path: swap provider to PostgreSQL + PostGIS, documented in README.
  - Supabase Realtime → dedicated **socket.io mini-service** on port 3003 (`mini-services/realtime`), reached by clients via `io('/?XTransformPort=3003')` (gateway pattern).
  - Supabase Storage → local file storage in `uploads/`, served ONLY via authorized `GET /api/files/[id]` (participant/audience checks server-side).
  - Supabase Anonymous Auth → httpOnly cookie sessions + `sessions` table (token + separate socketToken), optional recovery-code restore.
- **Privacy**: internal cuids are never exposed to clients. All client payloads use `publicId` (e.g. `GX-7K2N9Q`). Distances are rounded (≈10/25/100 m buckets). Location rows deleted when discovery disabled.
- **Realtime notify path**: Next.js API routes → `POST http://127.0.0.1:3004/notify` (internal, token-guarded) → socket.io emits to user rooms. Clients poll TanStack Query as fallback.
- **Expiration**: conversation-level shared policy (`24h` | `3months` | `never`), server-computed `expiresAt`; either participant may change; sweeps run in mini-service every 60s (expired conversations + messages + media deleted, expired stories deleted, stale presence flipped offline).
- **Friendship**: one-way saved contacts (owner→contact). "Friends only" stories = users the creator saved. Nicknames are private aliases on Contact rows.
- **Invite conversations** go directly to the inbox (documented choice); blocks + rate limits still apply.

---
Task ID: 1
Agent: main (Z.ai Code)
Task: Initialize worklog, plan phases.

Work Log:
- Inspected scaffold: Next.js 16 + Tailwind 4 + shadcn/ui (New York) + Prisma/SQLite at db/custom.db, dev server already running on :3000.
- Read websocket example: server `path: '/'` on :3003, client `io('/?XTransformPort=3003')`.
- Planned schema and API/socket contracts (see Architecture Decisions).

Stage Summary:
- Environment understood; proceeding with schema + libs + APIs + realtime service + frontend, with stories/profile screens delegated to subagents.

---
Task ID: 3+4
Agent: main (Z.ai Code)
Task: API routes + realtime mini-service

Work Log:
- Wrote all API routes: /api/session (GET/POST/PUT-recover), /api/me, /api/auth/delete, /api/location, /api/nearby, /api/conversations(+[id], messages, read), /api/contacts(+[publicId]), /api/invites(+redeem), /api/stories(+[id], view, viewers), /api/blocks(+[publicId]), /api/reports, /api/moderation/reports (token-guarded), /api/upload, /api/files/[id] (authorized media gateway w/ range support), /api/match (atomic in-process mutex).
- Built mini-services/realtime (socket.io :3003 path '/', internal notify :3004 loopback): authenticated handshakes via session.socketToken, auto-join conversation rooms, message relay w/ participant+block+expiry validation, typing, read receipts, heartbeats, 60s sweeps (expired conversations+media, expired stories, stale presence, search queue), hourly orphan-file cleanup.
- tsc --noEmit passes for src/ (pre-existing errors only in examples/ + skills/).
- Started realtime service detached (setsid), notify endpoint verified {"ok":true}.

Stage Summary:
- Backend complete. Contracts in src/lib/types.ts (DTOs) + src/lib/dto.ts (serializers). Client uses publicId everywhere; cuids only for opaque resources.
- Key env: DATABASE_URL, INTERNAL_TOKEN (default ghostline-internal-dev), MODERATION_TOKEN optional.

---
Task ID: 6-b
Agent: frontend-styling-expert (profile)
Task: Profile & privacy screen

Work Log:
- Read worklog, types.ts, client-api.ts, app-store, user-avatar, report-dialog, globals.css, ui components, and /api/me + /api/invites + /api/contacts/[publicId] routes to confirm contracts (PATCH accepts avatarFileId; invite GET returns shareUrl; rename rejects empty nickname; server name regex ^[\p{L}\p{N} _.'-]{2,24}$u).
- Created src/components/screens/profile/profile-bits.tsx: copyWithToast (clipboard + execCommand fallback, toast feedback), relativeTime (date-fns), CodeRow (mono value row with copy button + optional action slot, copied check state).
- Created profile-screen.tsx with named + default export ProfileScreen: page header, max-w-2xl single column, store profile as render source + useQuery(['me']) refresh synced into store via setProfile; applyProfile helper does setProfile + invalidateQueries(['session']) after every updateMe.
- Identity card: UserAvatar(72) + hidden file input (images only, <=4MB client check) -> api.upload(file,'avatar') -> updateMe({avatarFileId}); inline display-name edit with live validation mirroring server regex, Save disabled unless dirty+valid; public ID in CodeRow with copy; "Member since" date.
- Recovery card: recovery code masked (Eye/EyeOff reveal), Copy button, amber warning box with the exact spec text.
- Invite card: useQuery(['invite']) -> code (mono) + share link, Copy via CodeRow, Share button (navigator.share {title:'Ghostline',text,url:shareUrl} with AbortError guard, fallback copy link + toast), Rotate code behind AlertDialog explaining old links die -> api.rotateInvite + invalidate ['invite']/['me'] + api.getMe -> applyProfile.
- Discovery & privacy card: Nearby visibility switch with optimistic set + revert: ON requires navigator.geolocation.getCurrentPosition(enableHighAccuracy) then updateMe({nearbyVisible:true}) + updateLocation(lat,lng,accuracy) (+invalidate ['me']); denial (PERMISSION_DENIED) -> explanatory toast + switch reverts; OFF -> disableLocation() + updateMe({nearbyVisible:false}); status box shows navigator.permissions.query({name:'geolocation'}) live badge (granted/prompt/denied/unsupported) and "Coordinates last shared" relative time or "Never shared". Random chat availability switch (independent, helper text explains invite-code chats still work). Default story audience Select (Public / Friends only) -> updateMe({defaultStoryAudience}). Small print about 10/25/100 m distance buckets, no exact coordinates, 5 m GPS indoors unreliability.
- contacts-card.tsx: useQuery(['contacts']); rows with UserAvatar (online dot), nickname ?? displayName (+original in parens when aliased), "Saved contact · saved <rel>", rename Dialog (Input 1-40 chars, Enter-to-save) -> api.renameContact, remove AlertDialog -> api.removeContact, both invalidate ['contacts']; skeleton loading + dashed empty state.
- blocked-card.tsx: useQuery(['blocks']); rows with avatar + "Blocked <rel>" + Unblock button -> api.unblockUser + invalidate ['blocks']; empty state "No blocked users".
- Danger zone card (border-destructive/50): AlertDialog warning (erases profile/messages/stories/contacts; removed for the other person too) requiring typed DELETE to enable "Delete forever" -> api.deleteAccount() -> window.location.reload().
- Verified: bunx tsc --noEmit — zero errors in src/components/screens/profile (remaining project errors are pre-existing: examples/, skills/, app-root imports of parallel-agent screens, use-realtime onClick toast type, client-api.ts updateMe Pick constraint).

Stage Summary:
- Profile & privacy screen complete: src/components/screens/profile/{profile-screen.tsx, contacts-card.tsx, blocked-card.tsx, profile-bits.tsx}. ProfileScreen exported named (+ default) for app-root.
- All mutations optimistic with revert-on-error, toast feedback everywhere, applyProfile = setProfile + invalidate ['session'] (['me'] used as refresh query).
- Contract gap noticed (not touched, outside my folder): client-api.ts updateMe param is Partial<Pick<OwnProfile,...>> which cannot include 'avatarFileId' (line 90 ts2344) — server PATCH /api/me DOES accept avatarFileId; suggest adding 'avatarFileId' to the pick or widening the patch type. Call sites still typecheck today because the failing constraint doesn't poison the parameter type.
- Contract gap noticed: renameContact cannot clear a nickname (server rejects empty) — UI enforces non-empty; clearing a nickname = remove + re-save contact.

---
Task ID: 6-a
Agent: frontend-styling-expert (stories)
Task: Stories screen (tray, composer, viewer)

Work Log:
- Read worklog, types.ts, client-api.ts, app-store.ts, app-root.tsx, globals.css, ui primitives (dialog, alert-dialog, radio-group, button, skeleton) and verified lucide-react icon exports before writing code.
- Created src/components/screens/stories/stories-screen.tsx: `useQuery(['stories'], api.getStories, refetchInterval 60s)`; horizontal tray (ul/li, 56px avatars in 64px tiles, ghostline-scroll) with own group FIRST, "+" badge on own tile (expanded hit area via after:-inset-2) and dashed "Your story" tile when no own stories; unseen groups ring-2 ring-primary, seen ring-border; displayName truncated under each circle; loading skeletons, error state with Retry, empty state ("No stories right now — be the first to share one."), header "New story" button; tap opens StoryViewer at first unseen index; viewer close invalidates ['stories'].
- Created story-composer.tsx: Dialog with segmented Text/Photo/Video control; textarea (500-char counter), media picker with client-side size validation (images 8 MB, videos 50 MB, toast errors), immediate upload via api.upload with preview (object URL, revoked on replace/unmount), upload-failure retry button, optional caption (200 chars) for media; audience RadioGroup Public/Friends-only defaulting to profile.defaultStoryAudience; submit calls api.createStory({type,text,fileId,audience}) then invalidates ['stories'], toast success, close; ApiClientError messages surfaced via sonner toasts; busy state covers upload+create.
- Created story-viewer.tsx: fixed inset-0 z-50 bg-background overlay (no route change), body scroll lock, focus + role=dialog/aria-modal; segmented progress bars where current text/image segment fills via @keyframes gl-story-progress over 5s (keyframes injected via <style> since globals.css is off-limits) and video segment fills from onTimeUpdate; navigation via left-third / right-two-thirds tap zones layered beneath a pointer-events-none body (video re-enables pointer events so native controls work), ArrowLeft/ArrowRight/Escape keys, X close; auto-advance timer for text/image, onEnded for video, end of group closes; api.viewStory fired once per non-own story with local viewed Set; own stories get Eye N views toggle fetching api.getStoryViewers (inline "Viewed by" panel with viewer avatars/names/timeAgo) and Trash2 delete confirmed by AlertDialog calling api.deleteStory then invalidating ['stories'] and advancing/closing when group empties; header shows owner, formatDistanceToNow, remaining-until-expiresAt label (30s tick) and footer 24 h lifetime hint.
- bunx tsc --noEmit: zero errors under src/components/screens/stories (remaining build 500s are only the concurrently-missing nearby/random/chats/chat-view/profile screens).

Stage Summary:
- Stories feature frontend complete: tray + composer + viewer in src/components/screens/stories/ (stories-screen.tsx, story-composer.tsx, story-viewer.tsx), all "use client", strict TS, no any, no new deps, semantic tokens only, 44px+ touch targets.
- Decisions: viewer is a plain fixed overlay (full control over tap zones/keys) instead of Radix Dialog; caption for media stories travels in createStory `text` (max 200 client-side, server slices to 500); viewer snapshots group.stories locally so deletes don't fight the query cache;['stories'] invalidated on composer success, delete, and viewer close.
- Contract notes: getStories returns groups with owner.isOwn flag (own group first server-side, client re-sorts defensively); viewStory is POST with empty body; upload returns {id,url}; no gaps found.

---
Task ID: 5,6-a,6-b,7,8,9,10
Agent: main (Z.ai Code)
Task: Frontend, integration fixes, E2E verification, deployment docs

Work Log:
- Built theme (dark navy + violet), app shell (mobile bottom nav / desktop sidebar + sticky footer), zustand store, realtime hook, onboarding (with recovery + privacy explainer), invite deep-link dialog.
- Subagents delivered Stories screen (tray/composer/viewer, Task 6-a) and Profile screen (identity/invite/privacy toggles/contacts/blocked/deletion, Task 6-b); fixed their reported contract gaps (updateMe avatarFileId type, sonner onClick → action).
- Built Nearby (radius presets+custom+privacy copy), Random Chat (availability, atomic match UI, skip/end), Chats list, full ChatView (optimistic send via socket w/ HTTP fallback, read receipts, typing, media, settings sheet: expiration picker, rename, block/report/end/delete).
- Added POST /api/conversations (direct creation), poll-driven match retry (fixes waiting-pair deadlock), HTTP send path now emits message:new via notify.
- Root-caused process deaths: unhandled promise rejections in socket handlers under Bun kill the process → added global handlers + guard() wrappers in the realtime service; moved service in-process via src/instrumentation.ts (sandbox reaps detached processes at command boundaries; port guard makes standalone vs in-process mutually exclusive).
- Fixed missing /api/conversations/[id]/route.ts (write had silently failed on missing dir) and dash-format lookups for invite + recovery codes.
- E2E verified (browser + Node socket client + API): onboarding, persistence, nearby show/hide, matching both directions, realtime messaging + read receipts, image upload/render, nicknames, expiration (policy change, 410 rejection, list hiding, sweep deletion), story audiences (public/friends/stranger-hidden), view tracking, invite redemption (with random-chat OFF), block/unblock effects, report stored, recovery restore, rate-limit 429s, desktop + mobile layouts with sticky footer.
- Removed E2E harness artifacts; lint + tsc clean.

Stage Summary:
- All 5 phases implemented and browser-verified; README.md contains deployment instructions, env vars, moderation process and production swap notes (PostGIS, object storage, advisory-lock matching).
- Known sandbox constraint: the platform reaps background processes started from agent shells at command boundaries; the realtime service runs in-process with Next.js to survive this.

---
Task ID: 11 (pivot — remove matching, add People online directory)
Agent: main (Z.ai Code)
Task: User request: "dont match users, just let them see all the people online and chat with them" — replace Random-Chat matching with a live People directory + one-tap direct chat.

Work Log:
- Schema: renamed Profile.randomChatAvailable → showInPeople (default true), dropped Presence.searchingSince (queue column); prisma db push OK, data preserved.
- Deleted /api/match route, RandomChatScreen, activeRandomConversationId; removed matching sweep + all match:found wiring (use-realtime).
- New GET /api/people: online directory = showInPeople && presence.isOnline && heartbeat < 75s, block-filtered both directions, sorted by lastHeartbeatAt, each entry carries existing active conversationId (re-open instead of duplicate).
- /api/me PATCH accepts showInPeople; DTO/types cleaned (PublicProfile lost randomChatAvailable, ConversationSummary.type now 'direct' only, MatchState/MatchResult removed).
- Realtime service: presence broadcasts are now block-aware (emitPresence fans out per-socket, skipping blocked pairs); stale-queue sweep removed.
- Frontend: new PeopleScreen (live count, client-side search, amber "You're invisible" banner with inline re-enable switch, one-tap Chat/Open → createConversation('never') or openConversation); nav tab Random→People (Users icon), default tab now 'people'; profile toggle reworded to "Show me in People"; onboarding/footer copy updated.
- E2E verified through the Caddy gateway (:81 — direct :3000 bypasses XTransformPort proxying, which produced an orange dot in early testing): scripted probe user online → appeared in People for both browser sessions; one-tap chat created conversation, messages delivered live both directions with read receipts; probe exit removed them from lists (server-side presence truth); Luna's visibility toggle removed her from Vega's People list while she could still see/chat with others; mobile viewport + sticky footer verified.
- Cleaned up: test identities deleted (cascade), rt-test probe and screenshots removed, tsc + eslint clean, README updated.

Stage Summary:
- Matching is gone. The app is now: People (everyone online, tap to chat) + Nearby + Stories + Chats + Profile, with unchanged safety (blocks stop discovery+messages both ways) and server-authoritative presence.
- Key lesson: agent-browser tests must go through http://localhost:81 (gateway), not :3000, for realtime to work.

---
Task ID: 14-a
Agent: frontend-styling-expert (code-search)
Task: In-app invite-code search → chat UX: CodeSearchDialog (lookup → preview → expiration → connect → chat), plus entry points in People and Chats.

Work Log:
- Read worklog, invite-dialog.tsx (redemption pattern), client-api.ts, app-store, types, lookup/redeem routes, user-avatar, expiration-dialog, people/chats screens, profile-bits before writing.
- Created src/components/screens/code-search-dialog.tsx: controlled Dialog (max-w-md) with two steps. Step 1: mono/tracking-widest uppercase input (maxLength 12, placeholder XK7Q-2M9P, autoCapitalize/autocorrect off), Enter-to-submit + "Find" button disabled until ≥7 chars, Loader2 spinner while searching; input is uppercased + spaces stripped locally (plain string handling — server normalizeCode handles dashes/shape 7–8). Step 2: preview card with UserAvatar(52, online dot), "Online now" / "Last seen <formatDistanceToNow>" (null → "a while ago"), publicId in small muted mono; "This chat should disappear after…" + <ExpirationPicker value={policy} onChange={setPolicy}/> default '24h'; Connect → api.redeemInvite(normalizedCode, policy) → invalidate ['conversations'] → openConversation(id) → onClose(); Connect shows spinner/"Connecting…". "Back" returns to search (keeps typed code for typo fixes) with reversed slide.
- Framer-motion: AnimatePresence mode="popLayout" (no height-collapse flash between steps) with directional push-slide variants (custom dir ±1, x ±36 + opacity, spring stiffness 400 damping 34); whileTap scale 0.98 on Find/Connect, 0.97 on People rows, 0.98 on invite card. Step area uses overflow-hidden + px-1/-mx-1 so the push-slide clips but focus rings don't.
- Errors surfaced inline as destructive role="alert" text under the step (err instanceof ApiClientError ? err.message : fallback) — covers INVITE_NOT_FOUND / SELF_INVITE / INVALID_INVITE / RATE_LIMITED messages verbatim from the server. State fully resets on every open.
- people-screen.tsx: KeyRound icon button (aria-label + title "Find someone by invite code") next to Refresh; compact one-row "Your invite code" card under the header (KeyRound tile, mono tracking code, tap anywhere to copy via reused copyWithToast('Invite code copied') with copied→Check feedback, Share button stopPropagation → navigator.share {title:'Ghostline', text:'Add me on Ghostline — my code: <CODE> or open <shareUrl>'} with AbortError guard and clipboard fallback); shareUrl from useQuery(['invite'], api.getInvite, enabled on profile) — cache key shared with Profile screen. All existing behavior (visibility banner, search, openChat) untouched. Row <li> cards wrapped in motion.div whileTap 0.97 (spring release), 44px avatars/touch areas preserved.
- chats-screen.tsx: KeyRound icon button in header actions; empty state got a secondary "Use an invite code" button; also fixed stale copy that still referenced the removed "Random chat" (now People/Nearby/invite code).
- bunx tsc --noEmit: zero errors in my files (code-search-dialog.tsx, people-screen.tsx, chats-screen.tsx). Remaining project errors are pre-existing: examples/websocket, mini-services/realtime/service.ts(478), skills/*.

Stage Summary:
- Code-search flow complete: People header + Chats header/empty-state open CodeSearchDialog; lookup→preview→expiration→redeem→chat in one dialog; own-code sharing (copy + share) lives on People screen.
- Decisions: popLayout over mode="wait" to avoid dialog-height collapse between steps; back button keeps the typed code; redemption reuses the exact normalized code that resolved the lookup; copy helper reused from profile-bits (no duplicate clipboard logic); invite query gated on profile to avoid a fetch before identity exists.
- Contract notes (no changes needed): /api/invites/lookup returns { profile: InviteLookup } exactly as consumed; blocked pairs get the same vague 404 wording as redeem (by design); lookup rate limit is per-user with 60s retry; ['invite'] query cache key now shared by Profile + People (single fetch, consistent shareUrl).

---
Task ID: 14-b
Agent: frontend-styling-expert (motion+PWA UI)
Task: Apple-like native feel on every phone (framer-motion transitions, safe areas, tap feedback) + PWA install affordances + push-notification UI (NotificationsCard).

Work Log:
- globals.css (append-only): added .pt-safe/.pb-safe, -webkit-fill-available html, overscroll-behavior-y none + tap-highlight transparent on body, .app-shell (min-height:100dvh), .no-select, .touch-scroll; introduced --gl-header-h var (3.5rem; grows by env(safe-area-inset-top) under @media (display-mode: standalone)) and the spec'd `header.app-header { padding-top: env(safe-area-inset-top) }` rule extended with a matching height bump so the 14px header never clips under a notch/Dynamic Island when installed.
- app-root.tsx: wired `usePwaRuntime(handleNotificationDeepLink)` (regex-matches `?chat=` and calls openConversation — notification taps open the right chat, cold start + postMessage both covered). Replaced conditional screen rendering with one `AnimatePresence initial={false} mode="popLayout" custom={direction}`; direction derived from tab index (people=0…profile=4, render-phase ref compare); variants: enter {opacity:0, x:dir*28}, exit {opacity:0, x:dir*-20}, iOS spring stiffness 400 / damping 38 / mass 0.9; ChatView lives in the same presence keyed "chat" with enter/exit {opacity:0, y:24, scale:0.995} (iOS page push/pop) — conversation-to-conversation switches keep the same key so ChatView updates in place (no logic regression). Reduced motion → opacity-only variants. Install banner: Chrome/Android variant (canInstall → /icon-192.png 44px rounded-[10px], "Install Ghostline", "Full-screen app, faster starts, works offline.", Install button → promptInstall() + toast on accepted, X dismiss) and iOS Safari instructions variant ("Add to Home Screen — tap ⬆︎ Share …", required for push on iOS); dismissals persisted in localStorage gl-install-dismissed / gl-install-dismissed-ios; mobile fixed above BottomNav (bottom calc(64px + safe-area)) with main pb bumped to 140px while visible, md+ floating bottom-right card; slide-up entrance via AnimatePresence. Header got `app-header` class; root/Splash/error wrappers switched min-h-screen → app-shell.
- nav.tsx: BottomNav buttons → motion.button whileTap scale 0.82 (spring 500/30), active icon lifts y:-1, static underline replaced by motion.span layoutId="nav-active-pill" (glides between tabs; duration 0 under reduced motion); SideNav got the same treatment (layoutId="nav-side-pill", whileTap 0.97). Aria attributes, unread badge, 56px hit area, safe-area pb kept.
- chat-view.tsx: message wrapper divs → motion.div layout="position" with spring entrance (stiffness 500/damping 35); own bubbles enter from x:+10, others from x:-10, y:10, scale 0.97; animation gated by `fresh` (pending/optimistic OR createdAt < 10s) so bulk history loads mount with initial={false} (no stagger). Added typing-indicator bubble (three staggered dots opacity [0.2,1,0.2], 1.1s, delay i*0.18) in its own AnimatePresence under the message list (header "typing…" label unchanged). Send button wrapped in motion.div whileTap scale 0.88. Chat height calc now uses var(--gl-header-h) so installed-mode safe-area offsets stay correct. No messaging/socket logic touched.
- NEW profile/notifications-card.tsx (NotificationsCard): states from push-client — checking → muted loader row; unsupported → "Not available in this browser."; denied → amber box (exact spec copy incl. iOS Settings → Safari → Notifications) + "Try again" that re-runs enablePush to surface the reason as toast; default → "Enable notifications" button (enablePush() inside the click gesture; success toast "…you'll get pings even when the app is closed." + state refresh; failure → toast.error(reason)); granted → emerald "On" badge row + "Send test" (api.sendTestPush → delivered>0 ? "Test notification sent (N devices)" : "No device subscribed yet…") + "Turn off" (disablePush → toast). iOS hint line ("On iPhone, notifications require Ghostline installed on your Home Screen…") shown when isIOSDevice() && !isStandalone(). State refreshes on mount AND on visibilitychange (permissions change outside the app). Card idiom matches neighbors (CardHeader/CardTitle+Description, outline buttons, text-[11px] small print).
- profile-screen.tsx: rendered <NotificationsCard /> between InviteCard and DiscoveryCard (spacing via existing space-y rhythm).
- nearby-screen.tsx (light polish): radius chips + Custom chip → motion.button whileTap 0.94; people list → motion.ul/motion.li staggerChildren 0.03 with spring items; row button whileTap 0.985. No logic changes.
- onboarding.tsx (light polish): motion.main entrance (y:16 spring), intro list staggered (motion.ul/motion.li), intro↔recover crossfade via AnimatePresence mode="wait" keyed by mode, primary CTAs whileTap 0.98, root → app-shell. No logic changes.
- Verified: bunx tsc --noEmit — zero errors in src/ (remaining errors are pre-existing/outside scope: examples/websocket, mini-services/realtime/service.ts:478 async-await — file modified by the push-infra agent, skills/*). Dev server (hot reload) returns HTTP 200 and renders; manifest + icon-192 reachable (200).
- Not done (no browser device here): visual verification on real iOS/Android — transitions, banner offsets and standalone safe-area behavior should get one manual pass via the agent-browser gateway (:81) in a follow-up.

Stage Summary:
- App now behaves like an installed Apple-style product: direction-aware spring tab slides, iOS page push/pop for chats, springy nav with a gliding active pill, animated message bubbles + typing dots, safe-area-aware header/nav/chat heights in standalone mode, and reduced-motion fallbacks everywhere.
- PWA affordances: install card (Chrome/Android native prompt) + iOS Add-to-Home-Screen instructions, both dismissible with persistence; NotificationsCard gives full enable/test/disable lifecycle for pop-up message pings and is the required UI companion for the Task 14-a push pipeline.
- Files touched: src/app/globals.css (append), src/components/app-root.tsx, src/components/nav/nav.tsx, src/components/screens/chat-view.tsx, src/components/screens/nearby-screen.tsx, src/components/screens/onboarding.tsx, src/components/screens/profile/profile-screen.tsx, NEW src/components/screens/profile/notifications-card.tsx.

---
Task ID: 15
Agent: main (Z.ai Code)
Task: Post-launch browser verification pass of the post-pivot app (Task 14-b follow-up): full E2E golden paths via agent-browser, fix defects found, clean test data.

Work Log:
- Runtime health: realtime service confirmed in-process (next-server pid holds :3003 socket.io + :3004 internal notify), app 200 via gateway :81, manifest/sw.js 200, /api/push/config 401 unauthenticated (by design) and returns {enabled:true, publicKey(87 chars)} for authed sessions.
- Two independent anonymous sessions (agent-browser --session ghostA/ghostB, 390x844, Reykjavik coords): onboarding (default name suggestion, enter) → People list shows both + live client; cross-visibility OK.
- Code search E2E: CodeSearchDialog accepted messy input "pgvt arrw" (server normalization), preview → expiration picker (24h default) → Connect → ChatView opened; toast + conversation created with 24h expiry.
- Realtime chat E2E: A sent message → "Sent" status; B received live (no refresh: People row flipped to "Existing chat", nav unread "1 Chats"); B replied → A received live; A's bubble flipped to "Read" (read receipts); chat header shows peer "Online" presence.
- BUG FOUND + FIXED (1/2): tapping any nav tab while inside ChatView was inert (ChatView replaced the whole tab area; only "Back to chats" escaped) — dead nav buttons. Fix: store setTab now always clears activeConversationId (iOS-style tab pop). Verified: B tapped Stories from inside chat → popped correctly.
- Stories E2E: composer (Text tab, 500-char, audience Public default) → story posted, own group first; B saw A's story in tray unseen-ring → viewed (progress viewer, story text visible) → A saw view count 1 + "23 h left" countdown.
- BUG FOUND + FIXED (2/2): own-story "+" badge used after:-inset-2 expanded hit area which reached the 62px tile's CENTER — center taps opened the composer instead of the viewer (Playwright click intercepted by button.absolute.-bottom-0.5 pseudo-area). Fix: stories-screen.tsx badge after:-inset-2 → after:-inset-1 (36px effective, no center overlap). Verified center tap opens viewer.
- Nearby E2E: headless geolocation permission auto-denied (CDP set geo alone insufficient) → monkey-patched navigator.geolocation.getCurrentPosition in-page (app's real call chain exercised; OS permission layer simulated) → both enabled "Nearby visibility" via Profile switch → "Coordinates last shared: <1 min" → each radar showed the other "≈ 850 m away · online" (true distance ~857m, privacy-bucketed, symmetric). Denied-permission UX verified organically first (switch revert + "Location permission: Denied" badge).
- Profile screen: all cards render (avatar, name, recovery, invite, NotificationsCard "Enable notifications" default state, switches, story audience, danger zone).
- Desktop 1280x800: sidebar nav with active pill, sticky footer at bottom (footerAtBottom:true), content centered; screenshots /tmp/gl-desktop.png + /tmp/gl-mobile.png confirm navy/violet theme, mobile bottom nav + install banner + safe layout.
- Errors: zero page/console errors in both sessions across the whole pass. dev.log: only expected artifacts (old fake-endpoint push test line, one libuv thread assertion + Fast Refresh full reload during hot edit). During test-identity deletion, [rt] logged P2025 join races for still-connected sockets of deleted users — guards caught it, service survived (by design).
- Data cleanup: enumerated DB — deleted 14 stale automated-test identities (Aurora×2, Basil×4, SockTest×2, Casper×2, RecoverMe, RateTest, Ghost-5055, Ghost-1332) + 1 fake-endpoint push subscription + 2 orphaned conversations. PRESERVED: Ghost-4876 (live user, heartbeating) and Nova (live user's chat partner — conversation with expiry tomorrow + push sub).
- Account deletion re-verified via API: bare POST → {requiresConfirmation} (double-submit pattern correct); POST {confirm:"DELETE"} → {deleted:true} ×2, cascade wiped stories/conversations/messages/locations/push subs; deleted session reloads to onboarding.
- bunx tsc --noEmit: zero errors in src/. bun run lint: clean.

Stage Summary:
- Full browser-verified E2E pass complete on the final feature set (People + code search + realtime chat/receipts + stories + nearby + PWA + push config + desktop/mobile). 2 real UX defects found and fixed (dead nav tabs during chat; story "+" badge stealing center taps). DB purged of all automated-test identities; live users untouched.
- Verification constraint: real OS push notification display and geolocation permission grant cannot be exercised in headless Chrome (permission auto-denied) — push pipeline verified up to VAPID key delivery + UI states; geolocation verified with in-page patched coordinates through the app's real API path. Real-device spot check of both remains the only outstanding manual item.
- Files touched: src/store/app-store.ts (setTab pops chat), src/components/screens/stories/stories-screen.tsx (badge hit area). DB rows cleaned via Prisma; no other code changes.

---
Task ID: 16
Agent: main (Z.ai Code)
Task: User request — (1) WhatsApp-seamless keyboard in chat + hide navigation while chatting; (2) navigation must override the back button (no dead nav / no double-back).

Work Log:
- app-root.tsx: chat is now a full-screen page on mobile — BottomNav and InstallBanner unmount while a conversation is open; main padding collapses to pb-0 (chat composer owns the bottom edge). Desktop keeps the SideNav (WhatsApp Web parity).
- app-root.tsx: chat = pushed history page. Opening a chat pushes {glChat:true}; popstate (Android/iOS hardware back gesture) closes the chat; ANY in-app dismissal (chat back button, nav tab tap, end/delete) consumes the pushed entry automatically via a suppress-flag guard — no stale entries, no double-back. Verified: history.state.glChat is null after both nav-override and hardware-back paths.
- chat-view.tsx: ALL back paths (header back, expired view, error view, end conversation, delete conversation) now route through setTab('chats') — back always lands on the chats list like WhatsApp, regardless of where the chat was opened from (People row, code search, notification deep link).
- Keyboard (the core ask): ChatView tracks the software keyboard via visualViewport (resize+scroll) and writes the overlap into --gl-kb; scroll pinned-state (markScrollPinned, <80px from bottom) keeps you glued to the newest message when the keyboard opens/closes. Android additionally benefits from viewport meta interactiveWidget=resizes-content added in layout.tsx (iOS ignores it — visualViewport is the universal path).
- BUG FOUND: Tailwind 4 never compiled the arbitrary height classes h-[calc(100dvh-var(--gl-header-h,3.5rem)-64px)] or the new --gl-kb variant (nested var(…,…) calc with commas → no CSS emitted; the chat height had been accidentally correct via flex stretch, which also silently ignored the keyboard var). Second bug: even with a real class, flex-1 (flex-basis 0%) on the same element makes the column-flex algorithm ignore explicit height. Fixes: plain .gl-chat-viewport class in globals.css (mobile: 100dvh − --gl-header-h − --gl-kb; md: 100dvh − --gl-header-h − 49px) + removed flex-1 from the chat root. Verified: 788px → 488px with simulated 300px keyboard → restores 788px.
- Composer: WhatsApp-style auto-grow (JS effect, field-sizing-content is Chromium-only — Safari needs it), reset on send; enterKeyHint="send" (mobile keyboard shows Send key), autoComplete off; Enter still sends, Shift+Enter newlines; no blur() anywhere → keyboard stays open after sending (16px text on mobile already prevents iOS focus-zoom).
- Verified end-to-end in two browser sessions: nav absent in chat (only hidden desktop sidebar nav in DOM), main pb 0, keyboard shrink path, auto-grow 40→92px (3 lines) →44px after send, multiline message delivered live both directions, back→Chats from People-opened chat, desktop SideNav tap overrides chat + consumes history entry, history.back() closes chat, install banner hidden in chat.
- Also fixed during verification: Turbopack watcher missed a globals.css append (stale CSS chunk) — a re-touch forced recompile; noted as sandbox quirk.
- bunx tsc --noEmit: zero src errors; eslint clean. Test identities Ghost-5117/Ghost-4802 deleted via API (double-confirm), no orphans; live users Ghost-4876 + Nova preserved; ports 3000/3003/3004 healthy.

Stage Summary:
- Chat now behaves like WhatsApp: no bottom navigation while chatting, composer flush on the bottom edge and riding above the software keyboard (visualViewport-driven), auto-growing input with Send key, keyboard stays up after sending, back (hardware or UI) always returns to the chats list, and nav/hardware-back always override an open chat without requiring the back button first.
- Files: src/app/layout.tsx (interactiveWidget), src/app/globals.css (.gl-chat-viewport + --gl-kb), src/components/app-root.tsx (nav/banner hide, history integration), src/components/screens/chat-view.tsx (keyboard var, pinned scroll, auto-grow, back routing, full-screen height class).
- Constraint note: real soft-keyboard behavior was verified via the visualViewport math path (headless Chrome can't raise a keyboard); the identical code path runs on devices — a real Android/iOS spot check remains worthwhile.

---
Task ID: 17
Agent: main (Z.ai Code)
Task: User request — (1) group chats (form groups, chat in the group); (2) notification-enable prompt on EVERY refresh until enabled; (3) favourite users that always pin to the top of Chats; (4) chat history kept across refreshes.

Work Log:
- Schema: Conversation.name (group display name) + Contact.favorite added; db:push + client regen clean.
- DTO/access layer rewrite: toConversationSummary rebuilt to one group-aware builder (participants+presence+contact-flags in → summary out); ConversationSummary now a discriminated shape {type:'direct'|'group', name, other?|members, createdByPublicId, favorited}; MessageDTO.senderName added; getConversationAccess returns others[] (multi-member), block checks scoped to direct chats only (groups are shared spaces).
- New APIs: POST /api/groups (name + memberPublicIds, block-pair skipping w/ skipped[] report, system message "X created the group", rate-limited), POST /api/conversations/[id]/leave (system message, last-leave deletes group + media), POST /api/push/test (route was MISSING while client-api called it — NotificationsCard "Send test" used to 404; now implemented via lib/push).
- Group rules in existing routes: conversations GET/[id] build group summaries (member roster w/ presence+nicknames, unread = all-others count); PATCH forbids expiration/end for groups (GROUP_NO_EXPIRY/GROUP_NO_END); DELETE restricted to creator (others → leave); messages GET returns senderName for groups + otherLastReadAt only for direct; read route notifies all others; people route returns favorited; contacts PATCH accepts {favorite} (auto-saves contact, block-guarded); invite redeem migrated to new builder.
- Realtime service: group messages skip pairwise block gate; offline push title "GroupName · Sender" for groups; sweep emits conversation:deleted to ALL participants (was first two); message payload carries senderName for groups.
- Frontend: ChatsScreen — favourited DMs pinned under a "Favourites" header (server + client sort), group rows (UsersRound avatar chip, "N members — say hi" empty state, "Sender: text" previews, unread badges), "New group" dialog button; NEW GroupCreateDialog (name + searchable member picker = contacts ∪ people, selected-count CTA, skipped-members toast); PeopleScreen star toggle per row (optimistic, aria-pressed, auto-saves contact); ChatView group mode — group avatar/name + "N members" header, sender-name labels on others' bubbles, centered system-message pills, settings sheet variant (member roster with "You/creator" crown, Leave group, creator-only Delete group) with direct-only sections (expiration/nickname/block/report) preserved; leaveGroup/deleteConversation invalidate caches; read receipts naturally direct-only (otherLastReadAt null for groups).
- Notification prompt (NEW NotificationPrompt, app-root): Dialog that pops on EVERY app load when pushSupported && (permission==='default' || (granted && no device subscription)); Enable runs the real enablePush flow in-gesture; "Not now" dismisses in-memory ONLY — refresh brings it back; denied stops the loop (OS final word); suppressed while a chat is open (active={!chatOpen}), pops again on return to tabs.
- History after refresh: conversations/messages were already DB-backed — verified organically; ADDED view restoration: store persists gl-active-conv to sessionStorage on open/close/tab-pop; app-root restores the open chat after reload once the conversations list confirms it still exists (deep-link safe, clears stale ids). Default expiration policy for new invite/code-search chats flipped '24h' → 'never' (keep-history default; 24h still selectable).
- Verified E2E (agent-browser ghostA/ghostB, 390x844 via gateway :81): onboarding → prompt appears + "Not now" + reappears on reload (3×); People star → contact favorite:true (API-verified); DM chat live both ways + Read receipt + unread nav badge; chats list: "Favourites" header + starred row pinned, "All chats" below; group create "Test Crew" (system message, "2 members", member picker), A↔B live group messaging with sender-name labels + group-named toasts + unread counts; settings: creator roster/Leave/Delete vs member Leave-only; B leaves → live "Ghost-3236 left the group" + count drops; A deletes → gone for everyone; reload in DM and in group restores the open chat with full history; unfav/refav re-pins; /api/push/test 200 {delivered:0} authed, 401 unauth; groups/leave/push-test unauth → 401; desktop 1280×800 sidebar + footer at 800/800 + new-group button present.
- Test identities Ghost-1131/Ghost-3236 deleted via double-confirm API (cascade wiped conversations/messages/contacts); Ghost-4876 + Nova preserved untouched; realtime service survived the expected P2025 deletion races (same guarded pattern as Task 15).
- bunx tsc --noEmit: zero src errors; bun run lint: clean. Dev server + in-process realtime (:3003/:3004) healthy after restart.

Stage Summary:
- Ghostline now has real group chat (create → chat → leave/delete, all realtime, push-aware, block-safe), favouriting that pins users to the top of Chats, an unmissable-but-dismissible notification prompt that returns on every refresh until the device is actually subscribed, and chat views that survive refresh with full server-side history.
- Note: headless Chrome cannot grant Notification permission, so the prompt's Enable path was verified up to the permission request step (same constraint as Task 15's push checks); the Profile NotificationsCard lifecycle remains the manual real-device item.
- Files: prisma/schema.prisma; src/lib/{types,dto,conversation-access,conversation-create,client-api}.ts; src/app/api/{groups,conversations,conversations/[id],conversations/[id]/messages,conversations/[id]/leave,conversations/[id]/read,contacts,contacts/[publicId],people,invites/redeem,push/test}/route.ts; mini-services/realtime/service.ts; src/hooks/use-realtime.ts; src/store/app-store.ts; src/components/app-root.tsx; src/components/shared/{notification-prompt (NEW)}; src/components/screens/{chats-screen,people-screen,chat-view,code-search-dialog,invite-dialog,group-create-dialog (NEW)}; src/components/shared/expiration-dialog.tsx.

---
Task ID: 18
Agent: main (Z.ai Code)
Task: User request — "add a pop up with a trigger that makes users auto add app to their home screen when using mobile including iphones" (aggressive Add-to-Home-Screen install prompt replacing the old passive, permanently-dismissible banner).

Work Log:
- use-pwa.ts: added detectAndroid() (Android UA), isMobile (isIOS || isAndroid), and installed state — set by the real appinstalled event AND persisted to localStorage key gl-pwa-installed (a reload right after installing must not resurrect the nag; standalone mode only applies from the next home-screen launch). onInstalled writes the flag (try/catch for private mode).
- app-store: installPromptOpen + setInstallPromptOpen (shared by auto-triggers and the Profile manual entry).
- NEW src/components/shared/install-prompt.tsx — A2HS bottom sheet (Dialog restyled: full-width sheet pinned to bottom with rounded-t-3xl + safe-area padding on mobile, centered max-w-md card at md:). Three variants: `native` (Android/Chrome where beforeinstallprompt was captured — "Install app" fires the REAL native install dialog via promptInstall()), `ios` (iPhone/iPad: guided steps — Safari toolbar mock with highlighted Share button, 1/2/3 numbered steps Share → "Add to Home Screen" → Add, plus helper footnote), `manual` (event-less browsers: menu → "Install app"/"Add to Home screen"). Triggers: (1) instant open when canInstall flips true (browser says installable), (2) 6s delayed auto-open for platforms that never fire the event (iOS). Dismissal ("Got it"/"Not now"/X/overlay) is SESSION-ONLY in-memory — every refresh brings the popup back until actually installed; installed/standalone stops it permanently. Busy state on the install button while awaiting the native userChoice; accepted → success toast + close; stale event → fallback toast.
- Sequencing: NotificationPrompt gained optional onResolved (fires when the question settles: enabled/unsupported/denied/dismissed-this-session); AppRoot gates installEligible = !chatOpen && notifResolved && isMobile && !standalone && !installed — one dialog at a time on first load, popup suppressed in chats, resumes automatically on exit. Old InstallBanner component + gl-install-dismissed{,-ios} localStorage logic + its pb-[140px] layout branch removed from app-root.
- Profile screen: new InstallCard ("Get the app") — manual trigger button opening the popup on any platform; hidden when standalone OR gl-pwa-installed=1. Fixed a transient title/× overlap in the sheet (pr-6 on title + description).
- Verified E2E (agent-browser): desktop viewport — NO auto-popup 8s after settling notifications (0 dialogs), manual Profile trigger opens the centered native-variant card (screenshot /tmp/gl-install-desktop.png); iPhone 14 device emulation — popup auto-opens after the notification question is dismissed, iOS sheet renders correctly (/tmp/gl-install-ios.png, /tmp/gl-install-ios-refresh.png), "Got it" keeps it away for the rest of the session, refresh brings it back; Pixel 7 emulation — synthetic beforeinstallprompt (stubbed prompt/userChoice) → popup opened INSTANTLY (trigger 1), Install app → accepted → closed, synthetic appinstalled → gl-pwa-installed=1 persisted, after reload + notification settle: 0 popups at 8s AND Profile card hidden; real-flow chat gate — conversation restored on load via gl-active-conv, 12s in chat fully quiet (both prompts), leaving chat → notification question re-appears → dismissing it releases the install popup within 6s. The installable event fires even under device-emulated UA in headless Chrome (Trigger 1 also exercised on the iPhone session); the 6s delay path is the production iOS path and was verified there.
- Note: real Android phones show Chrome's actual native install dialog on "Install app" (headless cannot render it — the click path was verified through promptInstall()/userChoice with a stubbed event, same technique as the geolocation patch in Task 15). A real-device spot check remains worthwhile.
- bun run lint: clean; bunx tsc --noEmit: no src/ errors (only pre-existing examples/ + skills/ noise). Dev server healthy, no new errors in dev.log.

Stage Summary:
- Ghostline now actively drives home-screen installs: a triggered A2HS popup (instant on browser installability, 6s otherwise) that returns on every refresh until the user actually installs, with a one-tap native install dialog on Android/Chrome and a guided Share→Add-to-Home-Screen sheet on iPhone (where installing is also the only way to get push notifications), plus a permanent "Get the app" manual entry in Profile. Desktop stays nag-free. Sequenced behind the notification prompt and fully suppressed inside chats.
- Files: src/hooks/use-pwa.ts; src/store/app-store.ts; src/components/shared/install-prompt.tsx (NEW); src/components/shared/notification-prompt.tsx (onResolved); src/components/app-root.tsx (banner removed, sequencing added); src/components/screens/profile/profile-screen.tsx (InstallCard).

---
Task ID: 19
Agent: main (Z.ai Code)
Task: User request — "user should be able to invite users to join group" (group invites on top of Task 17's group system).

Work Log:
- Schema: Conversation.joinCode (String?, @unique) added + db:push; required a dev-server restart because the running process held the pre-migration Prisma client (first /invite call 500'd with "Unknown argument joinCode" — resolved by restart, not a code bug).
- src/lib/ids.ts: generateGroupJoinCode() = "G" + 4-4 chars → normalized length 9 with leading G, while user invite codes normalize to 8 — code shape alone routes lookup/join between the two tables (no ambiguity, dashed or plain).
- NEW POST /api/conversations/[id]/members — any participant can invite; resolves publicIds, drops self/already-members, skips (and reports by display name) anyone block-paired with the INVITER (mirrors Task 17 group-create policy), 30-member cap, createMany participants, system message "X added A, B" (3+ names → "A, B, C +N more"), notifyUsers: added → conversation:new (toast "Added to “group”" + room join), everyone → conversation:updated (live roster + timeline). Rate-limited via new LIMITS.memberAdd (30/h).
- NEW POST /api/conversations/[id]/invite — participant-only group join-code endpoint; lazy-generates for pre-joinCode groups, {rotate:true} issues a fresh code (inviteRotate limit 5/3h) and kills the old one; returns {joinCode, shareUrl(origin-built), rotated}. Collision retry loop (3×) on the unique constraint.
- NEW POST /api/groups/join — redeems a group code (dashed or plain, shape-validated: G + 8); idempotent for existing members (joined:false + summary), refuses at 30 members, block check vs EVERY current member (either direction → vague 403 INVITE_UNAVAILABLE — a shared code must not route around a block), system message "X joined via invite code", conversation:updated to all. inviteRedeem rate limit.
- /api/invites/lookup extended into a shape-routed union: user codes → {type:'user', profile} (unchanged behavior), group codes → {type:'group', group:{name, memberCount, isMember}} — blocks vs any member → same vague 404 as user flow (can't probe codes), already-member preview allowed (isMember:true).
- Client: types.InviteLookupResponse union; client-api addGroupMembers/getGroupInvite/joinGroup + lookupInvite retyped. NEW src/components/screens/group-add-members-dialog.tsx — picker over contacts ∪ online people minus existing members (reuses GroupCreateDialog patterns incl. render-time reset, skipped-blocks toast).
- ChatView group settings: Members header now has an "Invite" button (opens the picker); new "Group invite code" section — Show invite code → mono code + Copy code + Copy link + "New code" (rotate w/ busy state + confirmation toast); joinCode cached per conversationId (reset on chat switch).
- invite-dialog.tsx (?invite= deep link): mounts with a lookup of the passed code — group codes render a "You're invited to a group" preview card (name, member count, isMember note) with Join group / Open group; user codes keep the classic expiry+Connect flow; redeem 404 falls back to one group-join attempt (covers hand-typed codes). code-search-dialog.tsx handles the union: group preview card + Join group button inside the existing two-step slide flow.
- AppRoot: NotificationPrompt active now also gated on !pendingInviteCode — fixes a REAL stacking bug found in testing (cold-start invite link + notification dialog stacked two modals; the top overlay swallowed clicks). One-dialog-at-a-time chain preserved: invite → notification → install.
- Verified E2E (agent-browser, gateway :81 — note: :3000 direct gives no sockets, so presence/people stay empty; onboarding via :81 required): UI group create (UiA Crew w/ UiB) → settings shows Members+Invite button + Group invite code section; Invite picker lists ONLY UiC (existing members excluded) → Add → toast, roster 3; UiC got "Added to" toast + group in Chats + both system pills ("created the group", "added UiC"); UiB's open sheet updated LIVE (3 members, UiC in roster with creator crown intact) + timeline pills; invite code G4282-PR4K shown w/ copy buttons (screenshot /tmp/gl-group-invite-code.png); UiC deep-link → "3 members · you are already in this group" → Open group (idempotent); fresh UiD cold-start → onboarding → invite dialog survives → Join group → lands in chat (4 members) with "UiD joined via invite code" pill, UiA's view live-updated to "4 members" + UiD in list; UI rotate → GEG77-UJUC, old code join → 404; second group via API → UiD code-search dialog → "Block Squad · group invite" preview → Join group → joined + system pill. API battery (curl): lookup/join/idempotent-join/rotate/old-code-404/unauth-401 ×3; block matrix: blocked-by-member lookup → vague 404, join → vague 403, add-members → skipped report, after unblock → success.
- Found & fixed during verification: two stacked dialogs on cold invite links (see AppRoot note above).
- Cleanup: all 8 browser/curl test identities deleted via double-confirm API; Task 18 residue profiles (Ghost-9543/8361/5379) + orphan conversations + linked media purged via Prisma script; DB now holds only the preserved Ghost-4876 (GX-GFA5DM) ↔ Nova pair (1 direct conv, 1 message). dev.log clean.
- bun run lint: clean; bunx tsc --noEmit: no src/ errors. Realtime service survived the deletion races (guarded pattern).

Stage Summary:
- Group invites are complete on both doors: (1) any member can add people from their network via an in-chat picker with live roster/system-message updates, and (2) every group has a shareable invite code + deep link (?invite=GXXXX-XXXX) that previews the group (name + member count) and joins in one tap — idempotent for members, block-safe against every current member, rotate-able when a link leaks, and works cold (onboard → join in one flow). User invite codes and group codes are shape-disambiguated (8 vs 9 chars, G-prefix) so one code-entry UI serves both.
- Files: prisma/schema.prisma; src/lib/{ids,rate-limit,types,client-api}.ts; src/app/api/{conversations/[id]/members (NEW),conversations/[id]/invite (NEW),groups/join (NEW),invites/lookup}; src/components/screens/{group-add-members-dialog (NEW),chat-view,invite-dialog,code-search-dialog}; src/components/app-root.tsx.

---
Task ID: 20-b
Agent: general-purpose (sub-agent 20-b)
Task: Fix user-reported "glitches when I'm typing in the chat" — four diagnosed root causes, all fixed inside src/components/screens/chat-view.tsx only: (1) composer text state re-rendering the entire message list per keystroke, (2) CSS field-sizing-content fighting the JS auto-grow with post-paint height writes, (3) unconditional scroll-to-bottom on message-count change, (4) visualViewport update thrash + iOS window panning.

Work Log:
- Extracted ChatComposer (same file, above ChatView). It now owns: local text state (THE perf fix — every keystroke re-renders only the composer, not N framer-motion layout nodes + dialogs/sheets), the typing-emit throttle moved verbatim (emitTyping + lastTypingSent/typingTimeout refs, 1.5s re-emit, 2s stop — identical socket payloads), the hidden image/video file inputs + ImagePlus/VideoIcon buttons (refs moved in), Enter-to-send (without Shift), enterKeyHint="send", maxLength 2000, placeholder "Message…", and the send button inside its motion.div whileTap scale wrapper. Wrapper classes kept byte-identical (border-t p-2.5 + safe-area max() padding + bg-background/90 backdrop-blur; inner flex items-end gap-1.5) so nothing shifts visually; returns null when disabled — the parent renders the canSend=false notice instead.
- Parent reshaped: sendText(value: string) uses the composer-trimmed value; removed parent-level text state, sending state, textareaRef, imageInputRef/videoInputRef, typing refs, emitTyping/onInputChange and the auto-grow effect. Optimistic-append / pending / retry logic stays in the parent with identical behavior. Dropped the no-op image-button disabled={socketConnected ? false : false} (always false) and with it the now-unused socketConnected store selector.
- Double-send guard: composer keeps a sendingRef that blocks re-entry for the rest of the current macrotask (released via setTimeout 0 alongside setSending(false)) — rapid repeated Enter cannot fire two optimistic sends; the send itself stays fully synchronous/instant.
- Auto-grow fixed: useLayoutEffect (runs before paint — no one-frame-late growth) + Tailwind 4 field-sizing-fixed added to the Textarea className; tailwind-merge 3.3.1 (field-sizing group) strips the shadcn base field-sizing-content so only the JS owns height (auto → min(scrollHeight, 128)px). Verified field-sizing-fixed ships in the installed tailwindcss v4 dist.
- Scroll jump fixed: the [allMessages.length] effect now calls scrollToBottom() only when pinnedRef.current is true (markScrollPinned tracking untouched) — reading history and "Load older messages" prepends no longer yank the viewport; new-message-while-pinned and mount-time bottom anchoring preserved.
- visualViewport effect rebuilt: resize/scroll coalesced per animation frame (single pending rAF, cancelled in cleanup); last rounded overlap tracked in lastKbOverlapRef; --gl-kb written only when the rounded overlap actually CHANGES; the pinned scroll-to-bottom fires only on an actual overlap change; window.scrollTo(0, 0) whenever overlap > 0 so iOS cannot pan the app shell while the keyboard is up; cleanup still resets --gl-kb to 0px.
- Extracted memoized MessageBubble (React.memo) with the full per-message JSX (motion.div layout="position", day divider, bubble, group sender name, text/image/video render, time + status ticks: failed→retry, pending clock, read double-check, sent check). Props: m/mine/fresh/showDay/readByOther/isGroup/reduced + stable onLightbox/onRetry. Parent callbacks openLightbox/retryMessage useCallback-ized, and the call chain beneath them (sendViaSocket → sendViaHttp → markOptimistic/optimisticAppend) converted to useCallback with stable deps so the memo actually holds. System-message pills stay inline in the map (tiny branch).
- Not broken (re-read final render tree + lint/tsc pass): read-receipt ticks, failed/retry, optimistic pending/failed + clientId dedupe, day dividers, typing indicator bubble, image lightbox dialog, group system messages, group-mode composer parity.
- bun run lint: clean. bunx tsc --noEmit: zero src/ errors; only pre-existing noise remains (examples/websocket/server.ts missing socket.io types; skills/image-edit + skills/stock-analysis type mismatches — untouched, outside scope).

Stage Summary:
- All four typing-glitch roots closed in one file: composer isolation (keystrokes no longer re-render the list), single-owner pre-paint auto-grow (field-sizing-fixed + useLayoutEffect), pinned-only auto-scroll (history browsing and load-older keep their position), and rAF-coalesced change-only keyboard sizing with an iOS pan lock. Socket events, API calls, DOM structure and visual classes unchanged; git diff = 414 insertions / 293 deletions in chat-view.tsx alone (mostly the two extracted components + comment lines).
- Files: src/components/screens/chat-view.tsx (only source file touched; this worklog appended).
- Verification caveat (same as Task 16): soft-keyboard behavior verified via the visualViewport math path logic, not a real device — an Android/iOS spot check of typing smoothness + keyboard-follow remains worthwhile.

---
Task ID: 21
Agent: main (Z.ai Code)
Task: Post-Task-20 continuation — "continue": reconcile stale summary state, verify the full backlog (group invites / A2HS / favorites / history / keyboard / back-button) is actually shipped, and fix the one live defect found in dev.log (presence P2025 spam from the realtime service).

Work Log:
- State reconciliation: the continuation summary claimed group invites were unimplemented — FALSE. Worklog Task 19 recorded the complete implementation (in-chat member picker + shareable group join codes + deep-link previews + rotate) and Task 20-b the chat typing fixes. Confirmed in code: schema (Conversation.type/joinCode/name), api.groups* + api.addGroupMembers in client-api.ts, GroupCreateDialog/GroupAddMembersDialog, invite-dialog group preview, favorites (Contact.favorite + chats-screen pinning/star), back-button popstate handling in app-root.tsx, nav hidden while chat open.
- Real defect in dev.log: recurring `db.presence.update()` P2025 ("No record was found") from mini-services/realtime — setOnline/heartbeat used update-only, so any session whose Presence row was missing (deleted test identities' lingering sockets; any future account-mid-session edge) never showed as online AND spammed error logs every heartbeat (~30s) forever.
- Fix 1 (functional): all three presence writes (setOnline, connection else-branch, heartbeat) converted to upsert — a missing Presence row is now created instead of failing; affected users appear online correctly.
- Fix 2 (eviction): new touchPresence() helper catches P2003 (FK) / P2025 from the upsert — meaning the account was deleted mid-session — and force-disconnects that user's sockets (io.in(userRoom).disconnectSockets(true)) + clears socketsByUser. One logged FK error per stale socket instead of endless per-heartbeat spam; reconnect is already refused at the handshake because the session row cascades away.
- Restart notes: discovered background process survival requirements in this sandbox — `nohup bun run dev &` died between tool calls; `(setsid bun run dev < /dev/null > /dev/null 2>&1 &)` survives. Realtime service runs in-process via src/instrumentation.ts (ports 3003/3004 confirmed inside next-server pid), so service.ts edits require a dev-server restart to load.
- E2E regression pass (agent-browser, gateway :81, iPhone 14 × 2 sessions): onboarding + prompt chain (notification → A2HS → main) intact; presence live BOTH directions (B saw A "Online now" instantly on first People load; A's refresh showed B); group create "E2E Sanity Crew" → creator toast + live "Added to" toast on B; group message relayed live to B's Chats preview with sender prefix ("Ghost-8485: hello crew"); group settings intact (Members + Invite button, invite code reveal GTJMG-JPHU, Copy code/link + New code rotate buttons, Leave/Delete actions); invite picker correctly excludes existing members with the right empty state ("Everyone you know is already in this group — share the group invite code instead.").
- Presence fix verification: fresh session after restart → /api/me online:true (upsert path); account deletion with socket connected → exactly ONE FK error then eviction, zero repeats 40s later (old code: error every 30s indefinitely).
- Cleanup: all E2E identities deleted (A/B via double-confirm API, one straggler via Prisma); DB restored to preserved pair (Ghost-4876 ↔ Nova, 1 direct conv, 1 msg). Investigated a Ghost-3338/Ghost-4909 naming duality during scripted onboarding — traced to client-side random name regeneration vs SSR suggestion in the test harness; POST /api/session handler itself is single-create (verified), no app bug.
- bun run lint: clean. bunx tsc --noEmit: no errors in src/ or mini-services/realtime. dev.log: one informational FK error at the eviction instant, otherwise clean.

Stage Summary:
- Backlog fully reconciled: everything previously listed as pending (group invites, A2HS popup, favorites pinning, chat-history persistence, WhatsApp-style keyboard work, back-button override, nav-hiding in chat) is confirmed shipped and regression-verified E2E in mobile viewports.
- Presence hardening shipped: missing-row self-heal (upsert) + deleted-account socket eviction (touchPresence) — People/Nearby online state is now correct even after account deletion races, and the error log stays quiet.
- Files: mini-services/realtime/service.ts (only source change: setOnline upsert + touchPresence helper + 2 call sites).

---
Task ID: 22
Agent: main (Z.ai Code)
Task: User request — "add a place where users can make a post whats on their mind (no pictures or videos) and other users can comment under it. users can like or dislike posts. like jodel app" → new "Buzz" feed tab (text-only posts + comments + like/dislike votes).

Work Log:
- Schema: Post (authorId, text, cached voteScore/commentCount, createdAt) + PostVote (postId+userId unique, value 1/-1) + PostComment (postId, authorId, text, createdAt); Profile relations posts/postVotes/postComments; db:push + client regenerate (dev server restarted afterwards — pre-migration client held by running process, same pattern as Task 19).
- src/lib/posts.ts (NEW): POST/COMMENT_MAX_LEN=300, author/post/comment → DTO mappers (author online = presence.isOnline + 75s heartbeat freshness, same as People), notBlockedAuthor where-clause (excludes block-paired authors from feed AND comments), hotRank (decayed score: (votes+comments)/(hours+2)^1.4 over the 150 newest posts), recomputeVoteScore (aggregate _sum → cached column).
- API (all auth-guarded, rate-limited via new LIMITS postCreate 10/h, postComment 40/h, postVote 120/h):
  - GET/POST /api/posts — feed (sort=hot|new; block-filtered; myVote + isOwn included) / create (text 1..300, trims; broadcasts feed:update {reason:'post'} to the new global "feed" socket room).
  - DELETE /api/posts/[id] — author-only; cascade removes votes+comments; broadcast post_deleted.
  - POST /api/posts/[id]/vote — {value:1|-1|0}; upsert on postId_userId (switching direction updates in place), 0 clears; SELF_VOTE 400 (no score farming); recomputes cached score; NOT broadcast (client optimistic + poll).
  - GET/POST /api/posts/[id]/comments — GET returns {post, comments} so threads are self-sufficient (comments block-filtered, oldest-first); POST increments cached commentCount in a transaction, broadcasts comment.
  - DELETE /api/posts/[id]/comments/[commentId] — comment author OR post author (thread-owner moderation); decrements count in transaction; broadcasts comment_deleted.
- Realtime: every socket now joins the global "feed" room on connect; /notify endpoint accepts {rooms:[...]} alongside userIds (notify.ts gained notifyRoom(); notifyUsers refactored onto a shared postNotify). Client use-realtime: feed:update → invalidate ['posts'] + ['post-thread', postId].
- Frontend: Tab union + 'feed'; NAV_ITEMS "Buzz" (Zap icon) inserted between Nearby and Stories; BottomNav grid-cols-5→6; TAB_ORDER updated; FeedScreen rendered in app-root. client-api: getPosts/createPost/deletePost/votePost/getPostThread/commentPost/deleteComment; types: PostAuthorDTO/PostDTO/PostCommentDTO.
- src/components/screens/feed-screen.tsx (NEW): composer card (avatar + textarea, 300-char counter, optimistic prepend to both cached sorts), Hot/New segmented sort, memoized PostCard with vote rail (chevron up/score/chevron down — emerald/rose when active, disabled on own posts), relativeTime author line + YOU badge, footer (comment toggle w/ count, delete-own vs report-others via existing ReportDialog), inline expandable comments thread (lazy ['post-thread', id] query, oldest-first, own-comment + thread-owner remove buttons), comment composer (field-sizing-content auto-grow, Enter to send). Shared AlertDialog for post/comment deletion at screen level; 30s poll reconciles votes (deliberately not broadcast) and anything else missed.
- Verified E2E (agent-browser, 2× iPhone 14 sessions via gateway :81): 6-tab nav renders; A posts → appears with YOU badge, vote arrows disabled, delete button; B sees the post LIVE (feed broadcast) with Report instead of Delete; B like → +1 emerald; B comments → count 1, comment visible on B ("You") and LIVE on A (author view); A replies → LIVE on B; B toggle-off → 0, dislike → −1; A's card reconciled to −1/1 comment without manual refresh; New sort works; A posts 2nd → Delete → confirm dialog (AlertDialog) → gone on BOTH sides (post_deleted broadcast); A (post author) removes B's comment → confirm → gone on BOTH sides (comment_deleted broadcast); unauth GET/POST /api/posts → 401; note: raw eval .click() doesn't trigger React synthetic handlers — used agent-browser role clicks.
- Post-E2E: both test identities deleted via API (posts/votes/comments cascade-verified: 0 rows remain); one stray onboarding profile traced to a scripted double-submit across a page reload (3 POST /api/session in log; POST handler itself single-create — harness artifact, not an app bug); 3 one-time presence FK errors = Task 21 eviction design firing for each deleted socket (zero repeats).
- bun run lint: clean. bunx tsc --noEmit: zero src/ errors (pre-existing skills/ noise only). dev.log: clean apart from the 3 expected eviction errors.

Stage Summary:
- Buzz ships Jodel-style anonymous posting: text-only (300 chars, enforced client+server), everyone can like/dislike (toggle + switch, self-vote blocked) and comment, post authors moderate their thread. Feed is global, block-safe (paired authors' posts AND comments hidden), realtime to every connected client via a new broadcast room with polling fallback, votes optimistic with server reconciliation. Comments are cached-count + transactional so counters never drift.
- Files: prisma/schema.prisma; src/lib/{posts (NEW),types,rate-limit,notify,client-api}.ts; src/app/api/posts/{route (NEW),[id]/route (NEW),[id]/vote/route (NEW),[id]/comments/route (NEW),[id]/comments/[commentId]/route (NEW)}; mini-services/realtime/service.ts (feed room + rooms in /notify); src/hooks/use-realtime.ts; src/store/app-store.ts; src/components/nav/nav.tsx; src/components/app-root.tsx; src/components/screens/feed-screen.tsx (NEW).

---
Task ID: 23
Agent: main (Z.ai Code)
Task: User request — "set it for supabase" (deployment target: Vercel + Supabase Postgres; user had hit SQLite's "Unable to open the database file" / "Could not create identity" on Vercel).

Work Log:
- Discovered the sandbox had been RESET: /home/z/my-project contained only download/skills/upload + 2 trivial git commits; the entire Ghostline codebase was gone. Found a complete system snapshot at /tmp/my-project (src 143 files, prisma, mini-services, db/custom.db, worklog through Task 22 — incl. the Buzz feed which was fully shipped + E2E-verified in the previous session, beyond what the old summary claimed). Restored with cp -a; preserved fresh skills/ + .git.
- Rebuilt toolchain after reset: bun install (848 pkgs) + prisma generate; mini-services/realtime had its own node_modules wiped → bun install there too (socket.io MODULE_NOT_FOUND on instrumentation boot otherwise). daemonize.py helper gone → relaunched dev server via setsid pattern with UPLOAD_DIR/NEXT_TELEMETRY_DISABLED/INTERNAL_TOKEN env, output to dev.log. First boot after restore showed a transient /api/session 500 (stale process) — clean restart resolved it; all three ports healthy (3000 app, 3003 socket.io handshake, 3004 notify).
- Supabase switch: prisma/schema.prisma datasource → provider "postgresql" + url env(DATABASE_URL) + directUrl env(DIRECT_URL) (pooled 6543 for runtime, direct 5432 for db push/migrate — standard Supabase layout); header comment updated. prisma validate + generate OK. Schema was already portable (no enums/Json/sqlite native types/no raw SQL anywhere in src or realtime service).
- package.json: added "postinstall": "prisma generate" so Vercel builds generate the client.
- .env rewritten: Supabase DATABASE_URL/DIRECT_URL placeholders (user must paste real strings), fresh VAPID keypair generated via web-push (old keys lost in reset; boot warning "VAPID keys missing" now gone — push re-enabled), INTERNAL_TOKEN kept.
- .gitignore hardened (was only "skills/ + node_modules/" and .env was TRACKED in git): now ignores .env, dev.log, server.log, .next/, uploads/, db/, tool-results/, verify-*.png; `git rm --cached .env`; committed the restored project + Supabase switch as ea3300c.
- README rewritten: Stack section now documents Supabase Postgres as the actual target; Running locally + env var table (DATABASE_URL pooled / DIRECT_URL direct / VAPID); Production deployment checklist updated with Supabase + Vercel steps and the realtime-on-serverless warning.
- Dev server restarted on the postgres client: interim state is expected DB errors (sweep P1001 against placeholder URL) until the user's real connection strings land; app shell + unauth /api/session serve 200; lint clean.

Stage Summary:
- Codebase fully restored from /tmp snapshot (worklog Tasks 1–22 intact; Buzz feed confirmed shipped in Task 22, no work lost).
- Ghostline is now Supabase-ready end to end: postgres schema + pooled/direct URL split + postinstall generate + VAPID keys + secrets untracked from git. BLOCKED on user input: the two Supabase connection strings (pooled + direct) to put into .env, run `bun run db:push`, restart, and E2E-verify on Postgres. Vercel needs the same env vars set in its dashboard. Known deployment caveat (unchanged): mini-services/realtime cannot run on Vercel serverless and needs a long-running host.

---
Task ID: 24
Agent: main (Z.ai Code)
Task: Complete the Supabase switch — wire real connection strings, push schema, verify app end-to-end on Postgres (continuation of Task 23).

Work Log:
- User supplied the direct connection string (db.vgwnphnjglnizwebildn.supabase.co:5432, password URL-encoded). That host proved IPv6-only (TCP connect fails from IPv4-only sandbox — and would fail on Vercel too).
- Discovered the project's pooler region by probing all Supabase regions with real PG auth: aws-0-* all "tenant not found" → project uses the NEWER aws-1-* pooler hostnames; aws-1-eu-west-3.pooler.supabase.com authenticated OK.
- .env written: DATABASE_URL = aws-1-eu-west-3 transaction pooler :6543 with ?pgbouncer=true&sslmode=require (IPv4-safe for Vercel serverless; pgbouncer=true disables prepared statements required on transaction mode); DIRECT_URL = aws-1-eu-west-3 session pooler :5432 (db.* direct host unreachable over IPv4). Same URLs go to Vercel env vars.
- bun run db:push succeeded — full Ghostline schema created on Supabase (Prisma CLI overrides shell env, which is why it worked while the app didn't).
- ROOT-CAUSE BUG FOUND: the sandbox shell exports DATABASE_URL=file:/home/z/my-project/db/custom.db globally (sandbox bootstrap .zscripts) — real env vars beat .env file values, so next dev silently used the stale SQLite URL ("the URL must start with the protocol postgresql://" in sweep + identity creation; createAnonymousIdentity's catch{} masked it as "Could not create identity"). Turbopack cache was NOT the issue (rm -rf .next did not help). FIX: launch dev server with explicit DATABASE_URL/DIRECT_URL in the setsid env line — /proc/<pid>/environ verified correct afterwards. Prisma-in-Turbopack itself works fine with the postgres engine.
- E2E verified on Supabase Postgres: POST /api/session creates identity (nested presence create OK); two-identity API smoke — post to Buzz, feed read, vote +1, vote switch −1 (mutual exclusion), comment, thread read with isOwn/myVote correct; /api/auth/delete for both identities cascaded (0 profiles/posts/votes/comments/sessions remain); agent-browser iPhone 14 session — onboarding (identity → notification prompt → A2HS → main UI), 6-tab nav, Buzz composer → Post via UI, post card rendered with own-post vote rail disabled + delete available; final DB counts all zero.
- Note: agent-browser fill() left the Post button disabled once (React state not updated by scripted fill) — retyping with real keystrokes (click + ctrl+a + type) worked; raw eval clicks also unreliable, consistent with Task 22 harness notes.
- dev.log clean: 0 prisma:error; sweeps quiet; delete cascade logged as expected SQL.

Stage Summary:
- Ghostline now runs fully on Supabase Postgres (project vgwnphnjglnizwebildn, eu-west-3, aws-1-* Supavisor): schema pushed, identity/post/vote/comment/delete flows verified via API AND browser UI, cascade deletes confirmed, dev.log clean.
- Sandbox-only gotcha documented: shell-exported DATABASE_URL=file: must be overridden explicitly when launching dev servers here; production (Vercel) is unaffected since env comes from the dashboard.
- Remaining for user: set the same env vars in Vercel (DATABASE_URL/DIRECT_URL/VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/INTERNAL_TOKEN) and push the code; realtime mini-service still needs a long-running host (Vercel serverless limitation, unchanged).
