/**
 * Ghostline Realtime Service (socket.io)
 * --------------------------------------
 * Port 3003 (gateway: /?XTransformPort=3003) + loopback-only internal notify
 * endpoint on 127.0.0.1:3004 used by the Next.js API routes.
 *
 * Responsibilities:
 *  - Authenticated presence (handshake via one-time socketToken, heartbeats,
 *    server-side expiry — no client-side booleans)
 *  - Realtime message relay with full server-side validation (participant,
 *    block-list, conversation expiry)
 *  - Typing indicators, read receipts
 *  - Scheduled sweeps: stale presence, expired conversations (messages + media),
 *    expired Buzz posts, stories, and orphaned files
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server } from 'socket.io'
import webpush from 'web-push'
import { db } from '../../src/lib/db'
import { unlinkByStoragePath } from '../../src/lib/uploads'
import { getPostRetentionCutoff } from '../../src/lib/post-retention'

// NOTE: the public port is resolved LAZILY inside startRealtimeService() —
// NOT at module level. ESM import hoisting evaluates this module before the
// standalone entry's body maps PaaS PORT → RT_PORT, and Next.js sets
// process.env.PORT for its own HTTP server, so an eager read would either
// miss the mapping or collide with the app port.
const INTERNAL_PORT = 3004
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'ghostline-internal-dev'
/**
 * Survive transient failures (e.g. SQLite contention under concurrent API
 * writes): Bun exits the process on unhandled rejections by default, which
 * would take the whole app down. Log loudly instead of dying.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[rt] unhandledRejection (suppressed):', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[rt] uncaughtException (suppressed):', err)
})

/** Wraps async socket handlers so no rejection escapes. */
function guard<Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) {
  return (...args: Args) => {
    Promise.resolve(fn(...args)).catch((err) => {
      console.error('[rt] handler error (suppressed):', err)
    })
  }
}

async function portBusy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rt/socket.io/?EIO=4&transport=polling`, {
      signal: AbortSignal.timeout(1200),
    })
    const text = await res.text()
    return text.startsWith('0')
  } catch {
    return false
  }
}

/**
 * Starts the realtime service. Safe to call from two places:
 *  - standalone entry (mini-services/realtime/index.ts via run.sh), or
 *  - in-process from src/instrumentation.ts (survives sandbox process reaping).
 * Whichever binds :3003 first wins; the other becomes a no-op.
 */
export async function startRealtimeService(): Promise<void> {
  // Lazy port resolution — see the note above INTERNAL_PORT.
  const PORT = Number(process.env.RT_PORT ?? 3003)
  if (await portBusy(PORT)) {
    console.log('[rt] :3003 already served — skipping duplicate start')
    return
  }

const httpServer = createServer()
// Cross-service entry points on the public port:
//   GET  /healthz → platform health check
//   POST /notify  → token-guarded notify from the Next.js API routes
// handleInternal is hoisted. Must be registered BEFORE socket.io attaches so
// engine.io caches this listener — see path note below.
httpServer.on('request', (req, res) => {
  const url = req.url ?? ''
  if (url === '/healthz' || url.startsWith('/healthz?')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (url.startsWith('/notify')) handleInternal(req, res)
})
const io = new Server(httpServer, {
  // Realtime HTTP+WS namespace. Path lives under /rt/socket.io so the same
  // public port can also serve /healthz and /notify (path '/' would let
  // engine.io swallow every request). The Caddy gateway forwards the full
  // path + query, so the sandbox flow is unchanged.
  path: '/rt/socket.io',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ─── helpers ─────────────────────────────────────────────────────────────────

const ONLINE_GRACE_MS = 75_000 // heartbeat considered fresh for this long
const LOCATION_TTL_MS = 0 // unused here (API owns location freshness)
void LOCATION_TTL_MS

const socketsByUser = new Map<string, Set<string>>()

function userRoom(userId: string) {
  return `user:${userId}`
}

// ─── Web Push (offline notifications) ───────────────────────────────────────

const pushEnabled = (() => {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) {
    console.warn('[push] VAPID keys missing — offline push notifications disabled')
    return false
  }
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT ?? 'mailto:hello@ghostline.app',
      publicKey,
      privateKey
    )
    return true
  } catch (err) {
    console.error('[push] invalid VAPID config:', err)
    return false
  }
})()

type PushPayload = { title: string; body: string; tag?: string; url?: string }

/** Sends a push to all registered devices; cleans up stale (404/410) endpoints. */
async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!pushEnabled) return
  try {
    const subs = await db.pushSubscription.findMany({ where: { userId } })
    if (subs.length === 0) return
    const staleIds: string[] = []
    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            { TTL: 3600 }
          )
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) staleIds.push(sub.id)
          else console.warn(`[push] delivery failed (${status ?? 'network'}) for user ${userId}`)
        }
      })
    )
    if (staleIds.length > 0) {
      await db.pushSubscription.deleteMany({ where: { id: { in: staleIds }, userId } }).catch(() => undefined)
    }
  } catch (err) {
    console.error('[push] sendPushToUser failed:', err)
  }
}

/** True when the user currently has at least one live socket (app in foreground). */
function hasLiveSockets(userId: string): boolean {
  return Boolean(socketsByUser.get(userId)?.size)
}

function previewFor(type: string, text: string | null): string {
  if (type === 'image') return '📷 Sent a photo'
  if (type === 'video') return '📹 Sent a video'
  const t = (text ?? '').trim()
  return t.length > 120 ? `${t.slice(0, 119)}…` : t || 'Sent a message'
}

/** Push a new message to participants who are not currently connected. */
async function pushMessageToOffline(
  conversationId: string,
  senderId: string,
  offlineUserIds: string[],
  type: string,
  text: string | null
) {
  const targets = offlineUserIds.filter((uid) => uid !== senderId && !hasLiveSockets(uid))
  if (targets.length === 0) return
  const [sender, conv] = await Promise.all([
    db.profile
      .findUnique({ where: { id: senderId }, select: { displayName: true } })
      .catch(() => null),
    db.conversation
      .findUnique({ where: { id: conversationId }, select: { type: true, name: true } })
      .catch(() => null),
  ])
  const name = sender?.displayName ?? 'Someone'
  const isGroup = conv?.type === 'group'
  const title = isGroup ? `${conv?.name ?? 'Group'} · ${name}` : `${name} · Ghostline`
  await Promise.all(
    targets.map((uid) =>
      sendPushToUser(uid, {
        title,
        body: previewFor(type, text),
        tag: `conv-${conversationId}`,
        url: `/?chat=${conversationId}`,
      })
    )
  )
}

/** Push a "new chat" nudge to the recipient when they are offline. */
async function pushConversationNewToOffline(
  conversationId: string,
  userIds: string[],
  actorPublicId: string | null
) {
  let actorId: string | null = null
  if (actorPublicId) {
    const actor = await db.profile
      .findUnique({ where: { publicId: actorPublicId }, select: { id: true, displayName: true } })
      .catch(() => null)
    if (!actor) return
    actorId = actor.id
    const targets = userIds.filter((uid) => uid !== actorId && !hasLiveSockets(uid))
    await Promise.all(
      targets.map((uid) =>
        sendPushToUser(uid, {
          title: 'Ghostline',
          body: `${actor.displayName} started a chat with you.`,
          tag: `conv-${conversationId}`,
          url: `/?chat=${conversationId}`,
        })
      )
    )
  }
}

/**
 * Presence broadcast that respects blocks: a user who blocked someone (or is
 * blocked by them) never receives their presence events — blocks stop
 * discovery, not just messaging.
 */
async function emitPresence(userId: string, publicId: string, online: boolean, lastSeenAt: string) {
  const payload = { publicId, online, lastSeenAt }

  // The caller already knows the internal user ID, so do not query Profile by
  // publicId for every connect/disconnect/sweep event.
  let blocks: { blockerId: string; blockedId: string }[]
  try {
    blocks = await db.blockedUser.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    })
  } catch (err) {
    // Fail closed: never broadcast presence if block privacy cannot be checked.
    console.error('[rt] presence broadcast skipped; block lookup failed:', err)
    return
  }

  const blockedIds = new Set<string>()
  for (const block of blocks) {
    blockedIds.add(block.blockerId === userId ? block.blockedId : block.blockerId)
  }

  // Broadcast to user rooms rather than emitting separately to every socket.
  // Socket.IO treats an array of rooms as a union, so users with multiple tabs
  // receive one event per socket while we avoid the nested per-socket emit loop.
  const recipientRooms: string[] = []
  for (const recipientId of socketsByUser.keys()) {
    if (recipientId === userId || blockedIds.has(recipientId)) continue
    recipientRooms.push(userRoom(recipientId))
  }
  if (recipientRooms.length > 0) {
    io.to(recipientRooms).emit('presence:update', payload)
  }
}

async function setOnline(userId: string, online: boolean) {
  const now = new Date()
  // Upsert — a session can outlive its Presence row (sweeps / manual cleanup);
  // update-only would P2025 and the user would never show as online.
  const previous = online
    ? await db.presence.findUnique({ where: { userId }, select: { isOnline: true } })
    : null
  const presence = await db.presence.upsert({
    where: { userId },
    create: online
      ? { userId, isOnline: true, lastHeartbeatAt: now, lastSeenAt: now }
      : { userId, isOnline: false, lastSeenAt: now },
    update: online
      ? { isOnline: true, lastHeartbeatAt: now, lastSeenAt: now }
      : { isOnline: false, lastSeenAt: now },
    include: { user: { select: { publicId: true, displayName: true, showInPeople: true } } },
  }).catch(() => null)
  if (presence) {
    await emitPresence(userId, presence.user.publicId, online, presence.lastSeenAt.toISOString())
    if (online && !previous?.isOnline && presence.user.showInPeople) {
      void notifyPeopleOnline(userId, presence.user.publicId, presence.user.displayName).catch((err) => {
        console.error('[push] online notification failed:', err)
      })
    }
  }
}

/** Notify opted-in users when someone appears in the People directory. */
async function notifyPeopleOnline(userId: string, publicId: string, displayName: string) {
  const recipients = await db.profile.findMany({
    where: {
      id: { not: userId },
      notifyWhenPeopleOnline: true,
      pushSubscriptions: { some: {} },
      OR: [
        { onlineNotificationAudience: 'anyone' },
        {
          onlineNotificationAudience: 'friends',
          contactsOwned: { some: { contactId: userId } },
        },
      ],
      blocksReceived: { none: { blockerId: userId } },
      blocksMade: { none: { blockedId: userId } },
    },
    select: { id: true },
  })
  await Promise.all(
    recipients.map((recipient) =>
      sendPushToUser(recipient.id, {
        title: 'Someone is online',
        body: `${displayName} is now online.`,
        tag: `online-${publicId}`,
        url: '/',
      })
    )
  )
}

/**
 * Refresh presence for a still-connected user (connection refresh + heartbeat).
 * If the account was deleted mid-session (FK violation), evict every socket of
 * that user instead of erroring on every future heartbeat — the handshake
 * middleware rejects any reconnect because the session row cascaded away.
 */
async function touchPresence(userId: string) {
  try {
    await db.presence.upsert({
      where: { userId },
      create: { userId, isOnline: true, lastHeartbeatAt: new Date() },
      update: { isOnline: true, lastHeartbeatAt: new Date() },
    })
  } catch (e) {
    const code = (e as { code?: string } | null)?.code
    if (code === 'P2003' || code === 'P2025') {
      socketsByUser.delete(userId)
      io.in(userRoom(userId)).disconnectSockets(true)
      return
    }
    throw e
  }
}

// ─── connection lifecycle ────────────────────────────────────────────────────

io.use(async (socket, next) => {
  try {
    const token = String(socket.handshake.auth?.token ?? '')
    if (!token) return next(new Error('auth required'))
    const session = await db.session.findUnique({
      where: { socketToken: token },
      select: { userId: true, expiresAt: true },
    })
    if (!session || session.expiresAt.getTime() < Date.now()) {
      return next(new Error('invalid session'))
    }
    socket.data.userId = session.userId
    next()
  } catch {
    next(new Error('auth failed'))
  }
})

io.on('connection', guard(async (socket) => {
  const userId = socket.data.userId as string
  const set = socketsByUser.get(userId) ?? new Set<string>()
  const wasOffline = set.size === 0
  set.add(socket.id)
  socketsByUser.set(userId, set)

  socket.join(userRoom(userId))
  // Global feed room — every connected client hears Buzz updates
  socket.join('feed')

  if (wasOffline) await setOnline(userId, true)
  else await touchPresence(userId)

  // Join every active conversation room so messages/read receipts arrive live
  try {
    const participations = await db.conversationParticipant.findMany({
      where: { userId, conversation: { status: 'active' } },
      select: { conversationId: true },
      take: 100,
    })
    for (const p of participations) socket.join(`conv:${p.conversationId}`)
  } catch (e) {
    console.error('[rt] failed to join conversation rooms', e)
  }

  socket.on('presence:heartbeat', guard(async () => {
    await touchPresence(userId)
  }))

  socket.on('conversation:subscribe', guard(async (data: { conversationId?: string }, ack?: (r: unknown) => void) => {
    const conversationId = String(data?.conversationId ?? '')
    const participant = await db.conversationParticipant.findFirst({
      where: { conversationId, userId },
    })
    if (participant) {
      socket.join(`conv:${conversationId}`)
      ack?.({ ok: true })
    } else {
      ack?.({ ok: false })
    }
  }))

  // ── realtime messaging (server-validated) ──────────────────────────────────

  socket.on(
    'message:send',
    guard(
    async (
      data: { conversationId?: string; clientId?: string; type?: string; text?: string; fileId?: string; replyToId?: string },
      ack?: (r: unknown) => void
    ) => {
      try {
        const conversationId = String(data?.conversationId ?? '')
        const clientId = typeof data?.clientId === 'string' ? data.clientId.slice(0, 64) : null
        const text = typeof data?.text === 'string' ? data.text.slice(0, 2000).trim() : ''
        const fileId = data?.fileId ? String(data.fileId) : null
        const replyToId = typeof data?.replyToId === 'string' ? data.replyToId : null
        const type = ['text', 'image', 'video'].includes(String(data?.type)) ? String(data.type) : 'text'

        const participation = await db.conversationParticipant.findFirst({
          where: { conversationId, userId },
          include: { conversation: { include: { participants: true } } },
        })
        if (!participation) return ack?.({ ok: false, error: 'not_participant' })

        const conv = participation.conversation
        if (conv.status !== 'active' || (conv.expiresAt && conv.expiresAt.getTime() <= Date.now())) {
          return ack?.({ ok: false, error: 'conversation_expired' })
        }

        // Blocks stop messaging in both directions — direct chats only.
        // Groups are shared spaces; a member block mutes the DM, not the room.
        const others = conv.participants.filter((p) => p.userId !== userId)
        if (conv.type !== 'group' && others.length > 0) {
          const blocks = await db.blockedUser.findMany({
            where: {
              OR: [
                { blockerId: userId, blockedId: { in: others.map((o) => o.userId) } },
                { blockerId: { in: others.map((o) => o.userId) }, blockedId: userId },
              ],
            },
          })
          if (blocks.length > 0) return ack?.({ ok: false, error: 'blocked' })
        }

        if (type === 'text' && !text) return ack?.({ ok: false, error: 'empty' })
        const replyTo = replyToId
          ? await db.message.findFirst({
              where: {
                id: replyToId,
                conversationId,
                deletedForEveryoneAt: null,
                hiddenFor: { none: { userId } },
              },
              include: { sender: { select: { publicId: true, displayName: true } } },
            })
          : null
        if (replyToId && !replyTo) return ack?.({ ok: false, error: 'invalid_reply' })
        if (type !== 'text') {
          if (!fileId) return ack?.({ ok: false, error: 'media_required' })
          const file = await db.file.findUnique({ where: { id: fileId } })
          if (!file || file.ownerId !== userId) return ack?.({ ok: false, error: 'invalid_media' })
        }

        const message = await db.message.create({
          data: { conversationId, senderId: userId, type, text: text || null, fileId, clientId, replyToId },
        })
        await Promise.all([
          db.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
          db.conversationParticipant
            .update({ where: { id: participation.id }, data: { lastReadAt: new Date() } })
            .catch(() => undefined),
        ])

        const sender = await db.profile.findUnique({ where: { id: userId }, select: { publicId: true, displayName: true } })
        const payload = {
          id: message.id,
          conversationId,
          senderPublicId: sender?.publicId ?? '',
          senderName: conv.type === 'group' ? (sender?.displayName ?? null) : null,
          type,
          text: message.text,
          mediaUrl: message.fileId ? `/api/files/${message.fileId}` : null,
          createdAt: message.createdAt.toISOString(),
          clientId: message.clientId,
          editedAt: null,
          deletedForEveryone: false,
          replyTo: replyTo
            ? {
                id: replyTo.id,
                senderPublicId: replyTo.sender.publicId,
                senderName: replyTo.sender.displayName,
                type: replyTo.type,
                text: replyTo.text,
                deletedForEveryone: false,
              }
            : null,
        }
        io.to(`conv:${conversationId}`).emit('message:new', payload)
        // Offline participants (no live socket) get a Web Push notification.
        void pushMessageToOffline(
          conversationId,
          userId,
          others.map((o) => o.userId),
          type,
          message.text
        )
        ack?.({ ok: true, message: payload })
      } catch (e) {
        console.error('[rt] message:send failed', e)
        ack?.({ ok: false, error: 'server_error' })
      }
    }
    )
  )

  socket.on('typing', (data: { conversationId?: string; typing?: boolean }) => {
    const conversationId = String(data?.conversationId ?? '')
    if (!conversationId) return
    socket.to(`conv:${conversationId}`).emit('typing', {
      conversationId,
      typing: Boolean(data?.typing),
    })
  })

  socket.on('conversation:read', guard(async (data: { conversationId?: string }) => {
    const conversationId = String(data?.conversationId ?? '')
    const participation = await db.conversationParticipant.findFirst({
      where: { conversationId, userId },
    })
    if (!participation) return
    const now = new Date()
    await db.conversationParticipant
      .update({ where: { id: participation.id }, data: { lastReadAt: now } })
      .catch(() => undefined)
    io.to(`conv:${conversationId}`).emit('conversation:read', {
      conversationId,
      userId,
      lastReadAt: now.toISOString(),
    })
  }))

  socket.on('disconnect', guard(async () => {
    const set = socketsByUser.get(userId)
    set?.delete(socket.id)
    if (set && set.size === 0) {
      socketsByUser.delete(userId)
      await setOnline(userId, false)
    }
  }))
  })) // end io.on('connection')

// ─── internal notify endpoint (loopback only, token-guarded) ────────────────

function handleInternal(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST' || !req.url?.startsWith('/notify')) {
    res.writeHead(404).end()
    return
  }
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    res.writeHead(401).end(JSON.stringify({ error: 'bad token' }))
    return
  }
  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > 1_000_000) req.destroy()
  })
  req.on('end', () => {
    void (async () => {
    try {
      const { userIds, rooms, event, payload } = JSON.parse(body)
      const hasUsers = Array.isArray(userIds) && userIds.length > 0
      const hasRooms = Array.isArray(rooms) && rooms.length > 0
      if ((!hasUsers && !hasRooms) || typeof event !== 'string') {
        res.writeHead(400).end(JSON.stringify({ error: 'bad payload' }))
        return
      }
      for (const uid of hasUsers ? userIds : []) io.to(userRoom(String(uid))).emit(event, payload)
      for (const room of hasRooms ? rooms : []) io.to(String(room)).emit(event, payload)
      // Offline push: new messages / new chats reach users with no live socket.
      if (event === 'message:new' && payload && typeof payload === 'object') {
        const p = payload as {
          conversationId?: string
          senderPublicId?: string
          type?: string
          text?: string | null
        }
        if (p.conversationId && p.senderPublicId) {
          const sender = await db.profile
            .findUnique({ where: { publicId: p.senderPublicId }, select: { id: true } })
            .catch(() => null)
          void pushMessageToOffline(
            p.conversationId,
            sender?.id ?? '',
            userIds.map(String),
            String(p.type ?? 'text'),
            p.text ?? null
          )
        }
      } else if (event === 'conversation:new' && payload && typeof payload === 'object') {
        const p = payload as { conversationId?: string; byPublicId?: string }
        if (p.conversationId) {
          void pushConversationNewToOffline(p.conversationId, userIds.map(String), p.byPublicId ?? null)
        }
      } else if (event === 'buzz:notification' && payload && typeof payload === 'object') {
        const p = payload as PushPayload
        for (const userId of userIds.map(String)) {
          // A live socket does not mean the app is foregrounded. The service
          // worker suppresses the OS notification only for a visible, focused
          // client, so always attempt push delivery for Buzz activity.
          void sendPushToUser(userId, p)
        }
      }
      res.writeHead(200).end(JSON.stringify({ ok: true }))
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'bad json' }))
    }
    })().catch((err) => {
      console.error('[rt] internal notify handler failed:', err)
      try { res.writeHead(500).end() } catch { /* already sent */ }
    })
  })
}

// ─── scheduled sweeps (server-side expiry — never trusts client timers) ─────

async function deleteFileBytes(storagePath: string | null | undefined) {
  await unlinkByStoragePath(storagePath)
}

async function sweepExpiredConversations() {
  // Expired conversations are removed. Ended conversations stay readable for
  // 24h after ending, then are swept too (they already reject new messages).
  const endedCutoff = new Date(Date.now() - 24 * 3_600_000)
  const expired = await db.conversation.findMany({
    where: {
      OR: [
        { expiresAt: { lte: new Date() } },
        { status: 'ended', updatedAt: { lte: endedCutoff } },
      ],
    },
    include: { participants: true },
    take: 100,
  })
  for (const conv of expired) {
    const onlyEnded = conv.status === 'ended' && !(conv.expiresAt && conv.expiresAt.getTime() <= Date.now())
    const userIds = conv.participants.map((p) => p.userId)
    for (const uid of userIds) {
      io.to(userRoom(uid)).emit('conversation:deleted', {
        conversationIds: [conv.id],
        reason: onlyEnded ? 'ended_cleanup' : 'expired',
      })
    }

    const messages = await db.message.findMany({ where: { conversationId: conv.id }, select: { fileId: true } })
    await db.conversation.delete({ where: { id: conv.id } }) // cascades messages + participants

    const fileIds = messages.map((m) => m.fileId).filter((v): v is string => Boolean(v))
    if (fileIds.length) {
      const files = await db.file.findMany({ where: { id: { in: fileIds } } })
      await db.file.deleteMany({ where: { id: { in: fileIds } } })
      for (const f of files) await deleteFileBytes(f.storagePath)
    }
    if (expired.length > 0) console.log(`[sweep] removed conversation ${conv.id} (${onlyEnded ? 'ended' : 'expired'})`)
  }
}

async function sweepStories() {
  const expired = await db.story.findMany({
    where: { OR: [{ expiresAt: { lte: new Date() } }, { status: 'deleted' }] },
    take: 200,
  })
  for (const s of expired) {
    await db.story.delete({ where: { id: s.id } }).catch(() => undefined)
    if (s.fileId) {
      const f = await db.file.findUnique({ where: { id: s.fileId } })
      if (f) {
        await db.file.delete({ where: { id: f.id } }).catch(() => undefined)
        await deleteFileBytes(f.storagePath)
      }
    }
  }
  if (expired.length) console.log(`[sweep] removed ${expired.length} expired stories`)
}

async function sweepExpiredPosts() {
  const expired = await db.post.deleteMany({
    where: { createdAt: { lt: getPostRetentionCutoff() } },
  })
  if (expired.count > 0) {
    io.to('feed').emit('feed:update', { reason: 'posts_expired' })
    console.log(`[sweep] removed ${expired.count} expired Buzz posts`)
  }
}

async function sweepPresence() {
  const cutoff = new Date(Date.now() - ONLINE_GRACE_MS)
  const stale = await db.presence.findMany({
    where: { isOnline: true, lastHeartbeatAt: { lt: cutoff } },
    include: { user: { select: { publicId: true } } },
    take: 200,
  })
  for (const p of stale) {
    // A live socket means a missed sweep, not an offline user
    if (socketsByUser.get(p.userId)?.size) {
      await db.presence
        .update({ where: { userId: p.userId }, data: { lastHeartbeatAt: new Date() } })
        .catch(() => undefined)
      continue
    }
    await db.presence
      .update({ where: { userId: p.userId }, data: { isOnline: false, lastSeenAt: new Date() } })
      .catch(() => undefined)
    await emitPresence(p.userId, p.user.publicId, false, new Date().toISOString())
  }
}

async function sweepOrphanFiles() {
  const cutoff = new Date(Date.now() - 24 * 3_600_000)
  const files = await db.file.findMany({ where: { createdAt: { lt: cutoff } }, take: 300 })
  for (const f of files) {
    const [inMessage, inStory, asAvatar] = await Promise.all([
      db.message.count({ where: { fileId: f.id } }),
      db.story.count({ where: { fileId: f.id } }),
      db.profile.count({ where: { avatarFileId: f.id } }),
    ])
    if (inMessage === 0 && inStory === 0 && asAvatar === 0) {
      await db.file.delete({ where: { id: f.id } }).catch(() => undefined)
      await deleteFileBytes(f.storagePath)
    }
  }
}

let sweeping = false
async function runSweeps() {
  if (sweeping) return
  sweeping = true
  try {
    await sweepExpiredPosts()
    await sweepExpiredConversations()
    await sweepStories()
    await sweepPresence()
  } catch (e) {
    console.error('[sweep] error', e)
  } finally {
    sweeping = false
  }
}

setInterval(runSweeps, 60_000).unref?.()
setInterval(sweepOrphanFiles, 60 * 60_000).unref?.()
setInterval(() => {
  // Keep SQLite connection warm; also serves as a liveness log line.
  db.presence.count().catch(() => undefined)
}, 10 * 60_000).unref?.()

// ─── boot ────────────────────────────────────────────────────────────────────

const internalServer = createServer(handleInternal)
internalServer.listen(INTERNAL_PORT, '127.0.0.1', () => {
  console.log(`[rt] internal notify endpoint on 127.0.0.1:${INTERNAL_PORT}`)
})

httpServer.listen(PORT, async () => {
  console.log(`Realtime service listening on :${PORT}`)
  await runSweeps().catch(() => undefined) // catch up on missed cleanups (offline users, restarts)
})
}
