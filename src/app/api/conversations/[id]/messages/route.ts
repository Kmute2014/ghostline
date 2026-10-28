import { notifyUsers } from '@/lib/notify'

import { NextRequest } from 'next/server'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import {
  handle,
  ok,
  unauthorized,
  badRequest,
  gone,
} from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getConversationAccess } from '@/lib/conversation-access'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { toMessageDTO } from '@/lib/dto'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const PAGE_SIZE = 30
const MAX_PAGE_SIZE = 50

function asDate(value: any): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value.toDate === 'function') return value.toDate()

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function isHiddenFor(message: any, userId: string): boolean {
  const hiddenForUserIds = message.hiddenForUserIds

  if (Array.isArray(hiddenForUserIds)) {
    return hiddenForUserIds.includes(userId)
  }

  return false
}

async function loadMessageDTO(
  messageDoc: FirebaseFirestore.QueryDocumentSnapshot,
  currentUserId: string,
  isGroup: boolean,
) {
  const firestore = getFirebaseAdminFirestore()
  const message = messageDoc.data()
  const senderId = String(message.senderId ?? '')

  const senderSnapshot = await firestore
    .collection('profiles')
    .doc(senderId)
    .get()

  const sender = senderSnapshot.exists ? senderSnapshot.data()! : null

  let replyTo: any = null

  if (message.replyToId) {
    const replySnapshot = await firestore
      .collection('conversations')
      .doc(message.conversationId)
      .collection('messages')
      .doc(String(message.replyToId))
      .get()

    if (replySnapshot.exists) {
      const replyData = replySnapshot.data()!

      if (!isHiddenFor(replyData, currentUserId)) {
        const replySenderSnapshot = await firestore
          .collection('profiles')
          .doc(String(replyData.senderId ?? ''))
          .get()

        const replySender = replySenderSnapshot.exists
          ? replySenderSnapshot.data()!
          : null

        replyTo = {
          id: replySnapshot.id,
          ...replyData,
          createdAt: asDate(replyData.createdAt) ?? new Date(0),
          editedAt: asDate(replyData.editedAt),
          deletedForEveryoneAt: asDate(
            replyData.deletedForEveryoneAt,
          ),
          sender: {
            publicId: replySender?.publicId ?? '',
            displayName: replySender?.displayName ?? '',
          },
          hiddenFor: [],
        }
      }
    }
  }

  const dtoInput = {
    id: messageDoc.id,
    ...message,
    senderId,
    createdAt: asDate(message.createdAt) ?? new Date(0),
    editedAt: asDate(message.editedAt),
    deletedForEveryoneAt: asDate(
      message.deletedForEveryoneAt,
    ),
    sender: {
      publicId: sender?.publicId ?? '',
      displayName: sender?.displayName ?? '',
    },
  }

  return toMessageDTO(
    dtoInput as any,
    sender?.publicId ?? '',
    isGroup ? sender?.displayName ?? '' : null,
    replyTo,
  )
}

/** Cursor-paginated message history, with oldest message first in the response. */
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id } = await ctx.params
  const userId = auth.profile.id

  const access = await getConversationAccess(id, userId)
  const firestore = getFirebaseAdminFirestore()

  const url = new URL(req.url)
  const beforeRaw = url.searchParams.get('before')
  const requestedLimit = Number(url.searchParams.get('limit') ?? PAGE_SIZE)

  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Number.isFinite(requestedLimit) ? requestedLimit : PAGE_SIZE,
    ),
  )

  let beforeDate: Date | null = null

  if (beforeRaw) {
    beforeDate = asDate(beforeRaw)

    if (!beforeDate) {
      throw badRequest('Invalid message cursor.', 'INVALID_CURSOR')
    }
  }

  const messagesRef = firestore
    .collection('conversations')
    .doc(id)
    .collection('messages')

  const visibleMessages: FirebaseFirestore.QueryDocumentSnapshot[] = []
  let query = messagesRef.orderBy('createdAt', 'desc')

  if (beforeDate) {
    query = query.where(
      'createdAt',
      '<',
      Timestamp.fromDate(beforeDate),
    )
  }

  // Read in batches so hidden messages do not normally leave a short page.
  let lastDocument:
    | FirebaseFirestore.QueryDocumentSnapshot
    | undefined

  let hasMore = false
  const batchSize = Math.min(100, Math.max(limit + 1, 30))

  while (visibleMessages.length <= limit) {
    let batchQuery = query.limit(batchSize)

    if (lastDocument) {
      batchQuery = batchQuery.startAfter(lastDocument)
    }

    const batch = await batchQuery.get()
    if (batch.empty) break

    for (const doc of batch.docs) {
      lastDocument = doc

      if (isHiddenFor(doc.data(), userId)) continue

      visibleMessages.push(doc)

      if (visibleMessages.length > limit) {
        hasMore = true
        break
      }
    }

    if (hasMore || batch.docs.length < batchSize) break
  }

  const page = visibleMessages.slice(0, limit)

  // Convert concurrently, then reverse so the oldest message is first.
  const dtos = await Promise.all(
    page.map((doc) =>
      loadMessageDTO(doc, userId, access.isGroup),
    ),
  )

  dtos.reverse()

  let otherLastReadAt: string | null = null

  if (!access.isGroup) {
    const participantsSnapshot = await firestore
      .collection('conversations')
      .doc(id)
      .collection('participants')
      .get()

    const otherParticipant = participantsSnapshot.docs.find(
      (doc) => {
        const data = doc.data()
        return String(data.userId ?? doc.id) !== userId
      },
    )

    if (otherParticipant) {
      const lastReadAt = asDate(
        otherParticipant.data().lastReadAt,
      )

      otherLastReadAt = lastReadAt?.toISOString() ?? null
    }
  }

  return ok({
    messages: dtos,
    hasMore,
    oldestCursor: dtos.length
      ? dtos[0].createdAt
      : null,
    otherLastReadAt,
  })
})

/** HTTP send path; writes the message to Firestore and publishes a realtime event. */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id } = await ctx.params
  const userId = auth.profile.id
  const access = await getConversationAccess(id, userId)

  if (access.conversation.status !== 'active') {
    throw gone(
      'This conversation has ended and no longer accepts messages.',
      'CONVERSATION_ENDED',
    )
  }

  if (
    access.conversation.expiresAt &&
    access.conversation.expiresAt.getTime() <= Date.now()
  ) {
    throw gone(
      'This conversation has expired and no longer accepts messages.',
      'CONVERSATION_EXPIRED',
    )
  }

  if (access.iBlockedThem || access.theyBlockedMe) {
    throw badRequest(
      'Messaging is unavailable between blocked users.',
      'BLOCKED',
    )
  }

  const body = await req.json().catch(() => ({}))

  const type = ['text', 'image', 'video'].includes(body?.type)
    ? body.type
    : 'text'

  const text =
    typeof body?.text === 'string'
      ? body.text.slice(0, 2000).trim()
      : ''

  const fileId = body?.fileId ? String(body.fileId) : null

  const clientId =
    typeof body?.clientId === 'string'
      ? body.clientId.slice(0, 64)
      : null

  const replyToId =
    typeof body?.replyToId === 'string'
      ? body.replyToId
      : null

  if (type === 'text' && !text) {
    throw badRequest('Message text is empty.', 'EMPTY_MESSAGE')
  }

  const firestore = getFirebaseAdminFirestore()
  const conversationRef = firestore
    .collection('conversations')
    .doc(id)

  let replyTo: any = null

  if (replyToId) {
    const replySnapshot = await conversationRef
      .collection('messages')
      .doc(replyToId)
      .get()

    if (!replySnapshot.exists) {
      throw badRequest(
        'That message cannot be replied to.',
        'INVALID_REPLY',
      )
    }

    const replyData = replySnapshot.data()!

    if (
      replyData.deletedForEveryoneAt ||
      isHiddenFor(replyData, userId)
    ) {
      throw badRequest(
        'That message cannot be replied to.',
        'INVALID_REPLY',
      )
    }

    const replySenderSnapshot = await firestore
      .collection('profiles')
      .doc(String(replyData.senderId ?? ''))
      .get()

    const replySender = replySenderSnapshot.exists
      ? replySenderSnapshot.data()!
      : null

    replyTo = {
      id: replySnapshot.id,
      ...replyData,
      createdAt: asDate(replyData.createdAt) ?? new Date(0),
      editedAt: asDate(replyData.editedAt),
      deletedForEveryoneAt: asDate(
        replyData.deletedForEveryoneAt,
      ),
      sender: {
        publicId: replySender?.publicId ?? '',
        displayName: replySender?.displayName ?? '',
      },
      hiddenFor: [],
    }
  }

  if (type !== 'text') {
    if (!fileId) {
      throw badRequest(
        'A media attachment is required.',
        'MEDIA_REQUIRED',
      )
    }

    const fileSnapshot = await firestore
      .collection('files')
      .doc(fileId)
      .get()

    if (
      !fileSnapshot.exists ||
      fileSnapshot.data()?.ownerId !== userId
    ) {
      throw badRequest(
        'Invalid media attachment.',
        'INVALID_MEDIA',
      )
    }
  }

  const now = Timestamp.now()
  const messageRef = conversationRef
    .collection('messages')
    .doc()

  const messageData = {
    conversationId: id,
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
  }

  const participantRef = conversationRef
    .collection('participants')
    .doc(userId)

  await firestore.runTransaction(async (transaction) => {
    const [conversationSnapshot, participantSnapshot] =
      await Promise.all([
        transaction.get(conversationRef),
        transaction.get(participantRef),
      ])

    if (!conversationSnapshot.exists) {
      throw badRequest(
        'Could not find the conversation.',
        'CONVERSATION_NOT_FOUND',
      )
    }

    const conversation = conversationSnapshot.data()!

    if (conversation.status !== 'active') {
      throw gone(
        'This conversation has ended and no longer accepts messages.',
        'CONVERSATION_ENDED',
      )
    }

    const expiresAt = asDate(conversation.expiresAt)

    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw gone(
        'This conversation has expired and no longer accepts messages.',
        'CONVERSATION_EXPIRED',
      )
    }

    if (!participantSnapshot.exists) {
      throw badRequest(
        'You are no longer a participant in this conversation.',
        'NOT_A_PARTICIPANT',
      )
    }

    transaction.create(messageRef, messageData)

    transaction.update(conversationRef, {
      updatedAt: now,
    })

    transaction.update(participantRef, {
      lastReadAt: now,
    })
  })

  const dtoInput = {
    id: messageRef.id,
    ...messageData,
    createdAt: now.toDate(),
    editedAt: null,
    deletedForEveryoneAt: null,
    sender: {
      publicId: auth.profile.publicId,
      displayName: auth.profile.displayName,
    },
  }

  const dto = toMessageDTO(
    dtoInput as any,
    auth.profile.publicId,
    access.isGroup ? auth.profile.displayName : null,
    replyTo,
  )

  await notifyUsers(access.others.map((other: any) => other.id), 'message:new', dto)

  return ok({ message: dto })
})


