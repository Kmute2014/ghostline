/**
 * Hushly realtime service (Socket.IO + Firestore).
 *
 * Firestore layout used here:
 *   profiles/{userId}
 *   presences/{userId}
 *   sessions/{sessionId}             (queried by socketToken)
 *   conversations/{conversationId}
 *     participants/{userId}
 *     messages/{messageId}
 *   blockedUsers/{blockId}
 *   contacts/{contactId}             (ownerId/contactId fields)
 *   pushSubscriptions/{subscriptionId}
 *   posts/{postId}
 *   stories/{storyId}/views/{userId}
 *   files/{fileId}
 *
 * Media uploads are disabled by the web app. This service never accesses a
 * cloud storage provider; it only removes Firestore metadata where needed.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server, type Socket } from 'socket.io'
import webpush from 'web-push'
import {
  Timestamp,
  type DocumentReference,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore'
import { getFirebaseAdminFirestore } from '../../src/lib/firebase-admin'
import { getPostRetentionCutoff } from '../../src/lib/post-retention'

const INTERNAL_PORT = 3004
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'ghostline-internal-dev'
const ONLINE_GRACE_MS = 75_000
const BATCH_SIZE = 400

type AnyRecord = Record<string, any>
type PushPayload = { title: string; body: string; tag?: string; url?: string }

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (value instanceof Timestamp) return value.toDate()
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate()
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

function guard<Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) {
  return (...args: Args) => {
    Promise.resolve(fn(...args)).catch((err) => {
      console.error('[rt] handler error:', err)
    })
  }
}

async function portBusy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rt/socket.io/?EIO=4&transport=polling`, {
      signal: AbortSignal.timeout(1200),
    })
    const body = await res.text()
    return body.startsWith('0')
  } catch {
    return false
  }
}

async function deleteDocsInBatches(refs: DocumentReference[], batchSize = BATCH_SIZE): Promise<void> {
  for (let offset = 0; offset < refs.length; offset += batchSize) {
    const batch = getFirebaseAdminFirestore().batch()
    for (const ref of refs.slice(offset, offset + batchSize)) batch.delete(ref)
    await batch.commit()
  }
}

async function deleteSubcollection(
  parent: DocumentReference,
  collectionName: string,
  onDocument?: (doc: QueryDocumentSnapshot) => void,
): Promise<void> {
  const collection = parent.collection(collectionName)
  while (true) {
    const snap = await collection.limit(BATCH_SIZE).get()
    if (snap.empty) return
    const batch = getFirebaseAdminFirestore().batch()
    for (const doc of snap.docs) {
      onDocument?.(doc)
      batch.delete(doc.ref)
    }
    await batch.commit()
    if (snap.size < BATCH_SIZE) return
  }
}

/** Starts the standalone/in-process realtime service. */
export async function startRealtimeService(): Promise<void> {
  const PORT = Number(process.env.RT_PORT ?? 3003)
  if (await portBusy(PORT)) {
    console.log(`[rt] :${PORT} already served â€” skipping duplicate start`)
    return
  }

  const firestore = getFirebaseAdminFirestore()
  const httpServer = createServer()
  const socketsByUser = new Map<string, Set<string>>()
  const userRoom = (userId: string) => `user:${userId}`

  // Register the HTTP routes before Socket.IO's request listener, so Engine.IO
  // does not intercept health checks or the token-protected notification route.
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
    path: '/rt/socket.io',
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60_000,
    pingInterval: 25_000,
  })

  const pushEnabled = (() => {
    const publicKey = process.env.VAPID_PUBLIC_KEY
    const privateKey = process.env.VAPID_PRIVATE_KEY
    if (!publicKey || !privateKey) {
      console.warn('[push] VAPID keys missing â€” offline push notifications disabled')
      return false
    }
    try {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT ?? 'mailto:hello@ghostline.app',
        publicKey,
        privateKey,
      )
      return true
    } catch (err) {
      console.error('[push] invalid VAPID configuration:', err)
      return false
    }
  })()

  function hasLiveSockets(userId: string): boolean {
    return Boolean(socketsByUser.get(userId)?.size)
  }

  async function isBlockedBetween(firstUserId: string, secondUserId: string): Promise<boolean> {
    const [first, second] = await Promise.all([
      firestore.collection('blockedUsers')
        .where('blockerId', '==', firstUserId)
        .where('blockedId', '==', secondUserId).limit(1).get(),
      firestore.collection('blockedUsers')
        .where('blockerId', '==', secondUserId)
        .where('blockedId', '==', firstUserId).limit(1).get(),
    ])
    return !first.empty || !second.empty
  }

  async function blockedIdsFor(userId: string): Promise<Set<string>> {
    const [made, received] = await Promise.all([
      firestore.collection('blockedUsers').where('blockerId', '==', userId).get(),
      firestore.collection('blockedUsers').where('blockedId', '==', userId).get(),
    ])
    const ids = new Set<string>()
    for (const doc of made.docs) {
      const id = String(doc.data().blockedId ?? '')
      if (id && id !== userId) ids.add(id)
    }
    for (const doc of received.docs) {
      const id = String(doc.data().blockerId ?? '')
      if (id && id !== userId) ids.add(id)
    }
    return ids
  }

  async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
    if (!pushEnabled) return
    try {
      const subscriptions = await firestore.collection('pushSubscriptions')
        .where('userId', '==', userId).get()
      if (subscriptions.empty) return
      const stale: DocumentReference[] = []
      await Promise.allSettled(subscriptions.docs.map(async (doc) => {
        const sub = doc.data()
        try {
          await webpush.sendNotification(
            { endpoint: String(sub.endpoint), keys: { p256dh: String(sub.p256dh), auth: String(sub.auth) } },
            JSON.stringify(payload),
            { TTL: 3600 },
          )
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) stale.push(doc.ref)
          else console.warn(`[push] delivery failed (${status ?? 'network'}) for user ${userId}`)
        }
      }))
      await deleteDocsInBatches(stale)
    } catch (err) {
      console.error('[push] sendPushToUser failed:', err)
    }
  }

  function previewFor(type: string, text: string | null): string {
    if (type === 'image') return 'ðŸ“· Sent a photo'
    if (type === 'video') return 'ðŸŽ¥ Sent a video'
    const value = (text ?? '').trim()
    return value.length > 120 ? `${value.slice(0, 119)}â€¦` : value || 'Sent a message'
  }

  async function pushMessageToOffline(
    conversationId: string,
    senderId: string,
    offlineUserIds: string[],
    type: string,
    text: string | null,
  ): Promise<void> {
    const targets = offlineUserIds.filter((id) => id !== senderId && !hasLiveSockets(id))
    if (targets.length === 0) return
    const [senderSnap, conversationSnap] = await Promise.all([
      firestore.collection('profiles').doc(senderId).get(),
      firestore.collection('conversations').doc(conversationId).get(),
    ])
    const senderName = String(senderSnap.data()?.displayName ?? 'Someone')
    const conv = conversationSnap.data() ?? {}
    const isGroup = conv.type === 'group'
    const title = isGroup ? `${String(conv.name ?? 'Group')} Â· ${senderName}` : `${senderName} Â· Ghostline`
    await Promise.all(targets.map((id) => sendPushToUser(id, {
      title,
      body: previewFor(type, text),
      tag: `conv-${conversationId}`,
      url: `/?chat=${conversationId}`,
    })))
  }

  async function pushConversationNewToOffline(
    conversationId: string,
    userIds: string[],
    actorPublicId: string | null,
  ): Promise<void> {
    if (!actorPublicId) return
    const actorSnap = await firestore.collection('profiles').where('publicId', '==', actorPublicId).limit(1).get()
    if (actorSnap.empty) return
    const actorDoc = actorSnap.docs[0]
    if (!actorDoc) return
    const actor = actorDoc.data()
    const actorId = actorDoc.id
    const targets = userIds.filter((id) => id !== actorId && !hasLiveSockets(id))
    await Promise.all(targets.map((id) => sendPushToUser(id, {
      title: 'Ghostline',
      body: `${String(actor.displayName ?? 'Someone')} started a chat with you.`,
      tag: `conv-${conversationId}`,
      url: `/?chat=${conversationId}`,
    })))
  }

  async function emitPresence(userId: string, publicId: string, online: boolean, lastSeenAt: string): Promise<void> {
    let blockedIds: Set<string>
    try {
      blockedIds = await blockedIdsFor(userId)
    } catch (err) {
      console.error('[rt] presence broadcast skipped; block lookup failed:', err)
      return
    }
    const rooms: string[] = []
    for (const recipientId of socketsByUser.keys()) {
      if (recipientId === userId || blockedIds.has(recipientId)) continue
      rooms.push(userRoom(recipientId))
    }
    if (rooms.length) io.to(rooms).emit('presence:update', { publicId, online, lastSeenAt })
  }

  async function notifyPeopleOnline(userId: string, publicId: string, displayName: string): Promise<void> {
    const [profilesSnap, contactsSnap, blockedIds] = await Promise.all([
      firestore.collection('profiles').get(),
      firestore.collection('contacts').where('contactId', '==', userId).get(),
      blockedIdsFor(userId),
    ])
    const savedBy = new Set(contactsSnap.docs.map((doc) => String(doc.data().ownerId ?? '')).filter(Boolean))
    const recipients = profilesSnap.docs.filter((doc) => {
      if (doc.id === userId || blockedIds.has(doc.id)) return false
      const profile = doc.data()
      if (profile.notifyWhenPeopleOnline === false) return false
      const audience = String(profile.onlineNotificationAudience ?? 'anyone')
      return audience === 'anyone' || (audience === 'friends' && savedBy.has(doc.id))
    })
    await Promise.all(recipients.map((recipient) => sendPushToUser(recipient.id, {
      title: 'Someone is online',
      body: `${displayName} is now online.`,
      tag: `online-${publicId}`,
      url: '/',
    })))
  }

  async function setOnline(userId: string, online: boolean): Promise<void> {
    const now = Timestamp.now()
    const presenceRef = firestore.collection('presences').doc(userId)
    const [previousSnap, profileSnap] = await Promise.all([
      presenceRef.get(),
      firestore.collection('profiles').doc(userId).get(),
    ])
    if (!profileSnap.exists) return
    const profile = profileSnap.data() ?? {}
    const wasOnline = previousSnap.data()?.isOnline === true
    await presenceRef.set({
      userId,
      isOnline: online,
      lastHeartbeatAt: online ? now : (previousSnap.data()?.lastHeartbeatAt ?? null),
      lastSeenAt: now,
    }, { merge: true })
    const lastSeenAt = now.toDate().toISOString()
    await emitPresence(userId, String(profile.publicId ?? ''), online, lastSeenAt)
    if (online && !wasOnline && profile.showInPeople !== false) {
      void notifyPeopleOnline(userId, String(profile.publicId ?? ''), String(profile.displayName ?? 'Someone'))
        .catch((err) => console.error('[push] online notification failed:', err))
    }
  }

  async function touchPresence(userId: string): Promise<void> {
    const profileRef = firestore.collection('profiles').doc(userId)
    const presenceRef = firestore.collection('presences').doc(userId)
    const [profileSnap, presenceSnap] = await Promise.all([profileRef.get(), presenceRef.get()])
    if (!profileSnap.exists) {
      socketsByUser.delete(userId)
      io.in(userRoom(userId)).disconnectSockets(true)
      return
    }
    const now = Timestamp.now()
    await presenceRef.set({
      userId,
      isOnline: true,
      lastHeartbeatAt: now,
      lastSeenAt: presenceSnap.data()?.lastSeenAt ?? now,
    }, { merge: true })
  }

  async function deleteConversationData(convId: string, reason: string): Promise<void> {
    const convRef = firestore.collection('conversations').doc(convId)
    const participantsSnap = await convRef.collection('participants').get()
    const userIds = participantsSnap.docs.map((doc) => doc.id)
    for (const uid of userIds) {
      io.to(userRoom(uid)).emit('conversation:deleted', { conversationIds: [convId], reason })
    }
    const fileIds = new Set<string>()
    await deleteSubcollection(convRef, 'messages', (doc) => {
      const fileId = doc.data().fileId
      if (typeof fileId === 'string' && fileId) fileIds.add(fileId)
    })
    await deleteSubcollection(convRef, 'participants')
    await convRef.delete().catch(() => undefined)
    await deleteDocsInBatches([...fileIds].map((id) => firestore.collection('files').doc(id)))
  }

  async function sweepExpiredPosts(): Promise<void> {
    const cutoff = Timestamp.fromDate(getPostRetentionCutoff())
    let count = 0
    while (true) {
      const expired = await firestore.collection('posts').where('createdAt', '<', cutoff).limit(BATCH_SIZE).get()
      if (expired.empty) break
      await deleteDocsInBatches(expired.docs.map((doc) => doc.ref))
      count += expired.size
      if (expired.size < BATCH_SIZE) break
    }
    if (count > 0) {
      io.to('feed').emit('feed:update', { reason: 'posts_expired' })
      console.log(`[sweep] removed ${count} expired Buzz posts`)
    }
  }

  async function sweepExpiredConversations(): Promise<void> {
    const now = Timestamp.now()
    const endedCutoff = Timestamp.fromDate(new Date(Date.now() - 24 * 3_600_000))
    const [expiredByTime, endedOld] = await Promise.all([
      firestore.collection('conversations').where('expiresAt', '<=', now).limit(100).get(),
      firestore.collection('conversations').where('status', '==', 'ended').where('updatedAt', '<=', endedCutoff).limit(100).get(),
    ])
    const snapshots = new Map<string, QueryDocumentSnapshot>()
    for (const doc of expiredByTime.docs) snapshots.set(doc.id, doc)
    for (const doc of endedOld.docs) snapshots.set(doc.id, doc)
    for (const doc of snapshots.values()) {
      const data = doc.data()
      const expiresAt = asDate(data.expiresAt)
      const onlyEnded = data.status === 'ended' && !(expiresAt && expiresAt.getTime() <= Date.now())
      await deleteConversationData(doc.id, onlyEnded ? 'ended_cleanup' : 'expired')
      console.log(`[sweep] removed conversation ${doc.id} (${onlyEnded ? 'ended' : 'expired'})`)
    }
  }

  async function sweepStories(): Promise<void> {
    const [expiredByTime, deletedByStatus] = await Promise.all([
      firestore.collection('stories').where('expiresAt', '<=', Timestamp.now()).limit(200).get(),
      firestore.collection('stories').where('status', '==', 'deleted').limit(200).get(),
    ])
    const stories = new Map<string, QueryDocumentSnapshot>()
    for (const doc of expiredByTime.docs) stories.set(doc.id, doc)
    for (const doc of deletedByStatus.docs) stories.set(doc.id, doc)
    for (const storyDoc of stories.values()) {
      const story = storyDoc.data()
      await deleteSubcollection(storyDoc.ref, 'views')
      await storyDoc.ref.delete().catch(() => undefined)
      if (typeof story.fileId === 'string' && story.fileId) {
        await firestore.collection('files').doc(story.fileId).delete().catch(() => undefined)
      }
    }
    if (stories.size) console.log(`[sweep] removed ${stories.size} expired stories`)
  }

  async function sweepPresence(): Promise<void> {
    const cutoff = Timestamp.fromDate(new Date(Date.now() - ONLINE_GRACE_MS))
    const stale = await firestore.collection('presences')
      .where('isOnline', '==', true)
      .where('lastHeartbeatAt', '<', cutoff)
      .limit(200).get()
    for (const doc of stale.docs) {
      const userId = doc.id
      if (socketsByUser.get(userId)?.size) {
        await doc.ref.set({ lastHeartbeatAt: Timestamp.now() }, { merge: true })
        continue
      }
      const now = Timestamp.now()
      await doc.ref.set({ isOnline: false, lastSeenAt: now }, { merge: true })
      const profileSnap = await firestore.collection('profiles').doc(userId).get()
      const publicId = String(profileSnap.data()?.publicId ?? '')
      if (publicId) await emitPresence(userId, publicId, false, now.toDate().toISOString())
    }
  }

  async function sweepOrphanFiles(): Promise<void> {
    const cutoff = Timestamp.fromDate(new Date(Date.now() - 24 * 3_600_000))
    const files = await firestore.collection('files').where('createdAt', '<', cutoff).limit(300).get()
    for (const fileDoc of files.docs) {
      const fileId = fileDoc.id
      const [inMessage, inStory, asAvatar] = await Promise.all([
        firestore.collectionGroup('messages').where('fileId', '==', fileId).limit(1).get(),
        firestore.collection('stories').where('fileId', '==', fileId).limit(1).get(),
        firestore.collection('profiles').where('avatarFileId', '==', fileId).limit(1).get(),
      ])
      if (inMessage.empty && inStory.empty && asAvatar.empty) {
        await fileDoc.ref.delete().catch(() => undefined)
      }
    }
  }

  let sweeping = false
  async function runSweeps(): Promise<void> {
    if (sweeping) return
    sweeping = true
    try {
      await sweepExpiredPosts()
      await sweepExpiredConversations()
      await sweepStories()
      await sweepPresence()
    } catch (err) {
      console.error('[sweep] error', err)
    } finally {
      sweeping = false
    }
  }

  io.use(async (socket, next) => {
    try {
      const socketToken = String(socket.handshake.auth?.token ?? '')
      if (!socketToken) return next(new Error('auth required'))
      const sessions = await firestore.collection('sessions').where('socketToken', '==', socketToken).limit(1).get()
      if (sessions.empty) return next(new Error('invalid session'))
      const sessionDoc = sessions.docs[0]
      if (!sessionDoc) return next(new Error('invalid session'))
      const session = sessionDoc.data()
      const expiresAt = asDate(session.expiresAt)
      if (!expiresAt || expiresAt.getTime() < Date.now()) return next(new Error('invalid session'))
      const userId = String(session.userId ?? '')
      const profile = await firestore.collection('profiles').doc(userId).get()
      if (!userId || !profile.exists) return next(new Error('invalid session'))
      socket.data.userId = userId
      next()
    } catch (err) {
      console.error('[rt] handshake failed:', err)
      next(new Error('auth failed'))
    }
  })

  io.on('connection', guard(async (socket: Socket) => {
    const userId = String(socket.data.userId)
    const sockets = socketsByUser.get(userId) ?? new Set<string>()
    const wasOffline = sockets.size === 0
    sockets.add(socket.id)
    socketsByUser.set(userId, sockets)
    socket.join(userRoom(userId))
    socket.join('feed')
    if (wasOffline) await setOnline(userId, true)
    else await touchPresence(userId)

    try {
      const participations = await firestore.collectionGroup('participants')
        .where('userId', '==', userId).limit(100).get()
      for (const part of participations.docs) {
        const convId = part.ref.parent.parent?.id
        if (!convId) continue
        const conv = await firestore.collection('conversations').doc(convId).get()
        const data = conv.data()
        if (data?.status === 'active') socket.join(`conv:${convId}`)
      }
    } catch (err) {
      console.error('[rt] failed to join conversation rooms:', err)
    }

    socket.on('presence:heartbeat', guard(async () => {
      await touchPresence(userId)
    }))

    socket.on('conversation:subscribe', guard(async (data: { conversationId?: string }, ack?: (result: unknown) => void) => {
      const conversationId = String(data?.conversationId ?? '')
      if (!conversationId) return ack?.({ ok: false })
      const participant = await firestore.collection('conversations').doc(conversationId)
        .collection('participants').doc(userId).get()
      if (participant.exists) {
        socket.join(`conv:${conversationId}`)
        ack?.({ ok: true })
      } else {
        ack?.({ ok: false })
      }
    }))

    socket.on('message:send', guard(async (
      data: { conversationId?: string; clientId?: string; type?: string; text?: string; fileId?: string; replyToId?: string },
      ack?: (result: unknown) => void,
    ) => {
      try {
        const conversationId = String(data?.conversationId ?? '')
        if (!conversationId) return ack?.({ ok: false, error: 'not_participant' })
        const clientId = typeof data?.clientId === 'string' ? data.clientId.slice(0, 64) : null
        const text = typeof data?.text === 'string' ? data.text.slice(0, 2000).trim() : ''
        const fileId = data?.fileId ? String(data.fileId) : null
        const replyToId = typeof data?.replyToId === 'string' ? data.replyToId : null
        const type = ['text', 'image', 'video'].includes(String(data?.type)) ? String(data.type) : 'text'
        const convRef = firestore.collection('conversations').doc(conversationId)
        const participantRef = convRef.collection('participants').doc(userId)
        const [convSnap, participantSnap] = await Promise.all([convRef.get(), participantRef.get()])
        if (!convSnap.exists || !participantSnap.exists) return ack?.({ ok: false, error: 'not_participant' })
        const conv = convSnap.data() ?? {}
        const expiresAt = asDate(conv.expiresAt)
        if (conv.status !== 'active' || (expiresAt && expiresAt.getTime() <= Date.now())) {
          return ack?.({ ok: false, error: 'conversation_expired' })
        }
        const participantsSnap = await convRef.collection('participants').get()
        const others = participantsSnap.docs.filter((doc) => doc.id !== userId)
        if (conv.type !== 'group') {
          for (const other of others) {
            if (await isBlockedBetween(userId, other.id)) return ack?.({ ok: false, error: 'blocked' })
          }
        }
        if (type === 'text' && !text) return ack?.({ ok: false, error: 'empty' })
        let replyTo: AnyRecord | null = null
        if (replyToId) {
          const replySnap = await convRef.collection('messages').doc(replyToId).get()
          const reply = replySnap.data()
          const hidden = Array.isArray(reply?.hiddenForUserIds) && reply.hiddenForUserIds.includes(userId)
          if (!replySnap.exists || !reply || reply.deletedForEveryoneAt || hidden) {
            return ack?.({ ok: false, error: 'invalid_reply' })
          }
          const replySenderSnap = await firestore.collection('profiles').doc(String(reply.senderId)).get()
          const replySender = replySenderSnap.data() ?? {}
          replyTo = {
            id: replySnap.id,
            sender: {
              publicId: String(replySender.publicId ?? ''),
              displayName: String(replySender.displayName ?? 'Anonymous'),
            },
            type: String(reply.type ?? 'text'),
            text: reply.text ?? null,
          }
        }
        if (type !== 'text') {
          if (!fileId) return ack?.({ ok: false, error: 'media_required' })
          const file = await firestore.collection('files').doc(fileId).get()
          if (!file.exists || file.data()?.ownerId !== userId) return ack?.({ ok: false, error: 'invalid_media' })
        }
        const senderSnap = await firestore.collection('profiles').doc(userId).get()
        const sender = senderSnap.data() ?? {}
        const now = Timestamp.now()
        const messageRef = convRef.collection('messages').doc()
        await firestore.runTransaction(async (tx) => {
          const [freshConv, freshParticipant] = await Promise.all([tx.get(convRef), tx.get(participantRef)])
          const freshData = freshConv.data() ?? {}
          const freshExpires = asDate(freshData.expiresAt)
          if (!freshConv.exists || !freshParticipant.exists || freshData.status !== 'active' || (freshExpires && freshExpires.getTime() <= Date.now())) {
            throw new Error('CONVERSATION_NOT_AVAILABLE')
          }
          tx.create(messageRef, {
            conversationId,
            senderId: userId,
            type,
            text: text || null,
            fileId,
            clientId,
            replyToId,
            editedAt: null,
            deletedForEveryoneAt: null,
            hiddenForUserIds: [],
            createdAt: now,
          })
          tx.update(convRef, { updatedAt: now })
          tx.set(participantRef, { userId, lastReadAt: now }, { merge: true })
        }).catch((err) => {
          if (err instanceof Error && err.message === 'CONVERSATION_NOT_AVAILABLE') throw err
          throw err
        })
        const payload = {
          id: messageRef.id,
          conversationId,
          senderPublicId: String(sender.publicId ?? ''),
          senderName: conv.type === 'group' ? String(sender.displayName ?? 'Anonymous') : null,
          type,
          text: text || null,
          mediaUrl: fileId ? `/api/files/${fileId}` : null,
          createdAt: now.toDate().toISOString(),
          clientId,
          editedAt: null,
          deletedForEveryone: false,
          replyTo: replyTo ? {
            id: replyTo.id,
            senderPublicId: replyTo.sender.publicId,
            senderName: replyTo.sender.displayName,
            type: replyTo.type,
            text: replyTo.text,
            deletedForEveryone: false,
          } : null,
        }
        io.to(`conv:${conversationId}`).emit('message:new', payload)
        void pushMessageToOffline(conversationId, userId, others.map((doc) => doc.id), type, text || null)
        ack?.({ ok: true, message: payload })
      } catch (err) {
        if (err instanceof Error && err.message === 'CONVERSATION_NOT_AVAILABLE') {
          ack?.({ ok: false, error: 'conversation_expired' })
          return
        }
        console.error('[rt] message:send failed:', err)
        ack?.({ ok: false, error: 'server_error' })
      }
    }))

    socket.on('typing', guard(async (data: { conversationId?: string; typing?: boolean }) => {
      const conversationId = String(data?.conversationId ?? '')
      if (!conversationId) return
      const participant = await firestore.collection('conversations').doc(conversationId)
        .collection('participants').doc(userId).get()
      if (!participant.exists) return
      socket.to(`conv:${conversationId}`).emit('typing', { conversationId, typing: Boolean(data?.typing) })
    }))

    socket.on('conversation:read', guard(async (data: { conversationId?: string }) => {
      const conversationId = String(data?.conversationId ?? '')
      if (!conversationId) return
      const convRef = firestore.collection('conversations').doc(conversationId)
      const participantRef = convRef.collection('participants').doc(userId)
      const exists = await participantRef.get()
      if (!exists.exists) return
      const now = Timestamp.now()
      await participantRef.set({ userId, lastReadAt: now }, { merge: true })
      io.to(`conv:${conversationId}`).emit('conversation:read', {
        conversationId,
        userId,
        lastReadAt: now.toDate().toISOString(),
      })
    }))

    socket.on('disconnect', guard(async () => {
      const set = socketsByUser.get(userId)
      set?.delete(socket.id)
      if (set && set.size === 0) {
        socketsByUser.delete(userId)
        // Presence is maintained by the authenticated HTTP heartbeat as well.
        // Do not mark the user offline for a transient Socket.IO disconnect;
        // sweepPresence() marks them offline after the heartbeat grace period.
      }
    }))
  }))

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
    req.on('data', (chunk) => {
      body += chunk
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
          const ids = hasUsers ? userIds.map(String) : []
          for (const id of ids) io.to(userRoom(id)).emit(event, payload)
          for (const room of hasRooms ? rooms : []) io.to(String(room)).emit(event, payload)
          if (event === 'message:new' && payload && typeof payload === 'object') {
            const p = payload as { conversationId?: string; senderPublicId?: string; type?: string; text?: string | null }
            if (p.conversationId && p.senderPublicId && ids.length) {
              const senderSnap = await firestore.collection('profiles').where('publicId', '==', p.senderPublicId).limit(1).get()
              void pushMessageToOffline(p.conversationId, senderSnap.empty ? '' : (senderSnap.docs[0]?.id ?? ''), ids, String(p.type ?? 'text'), p.text ?? null)
            }
          } else if (event === 'conversation:new' && payload && typeof payload === 'object') {
            const p = payload as { conversationId?: string; byPublicId?: string }
            if (p.conversationId && ids.length) void pushConversationNewToOffline(p.conversationId, ids, p.byPublicId ?? null)
          } else if (event === 'buzz:notification' && payload && typeof payload === 'object') {
            for (const id of ids) void sendPushToUser(id, payload as PushPayload)
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
        } catch {
          res.writeHead(400).end(JSON.stringify({ error: 'bad json' }))
        }
      })().catch((err) => {
        console.error('[rt] internal notify handler failed:', err)
        try { res.writeHead(500).end() } catch { /* response may already be closed */ }
      })
    })
  }

  internalServerListen()

  function internalServerListen() {
    const internalServer = createServer(handleInternal)
    internalServer.listen(INTERNAL_PORT, '127.0.0.1', () => {
      console.log(`[rt] internal notify endpoint on 127.0.0.1:${INTERNAL_PORT}`)
    })
  }

  setInterval(() => { void runSweeps() }, 60_000).unref?.()
  setInterval(() => { void sweepOrphanFiles().catch((err) => console.error('[sweep] orphan files failed:', err)) }, 60 * 60_000).unref?.()

  httpServer.listen(PORT, async () => {
    console.log(`Realtime service listening on :${PORT}`)
    await runSweeps()
  })
}

