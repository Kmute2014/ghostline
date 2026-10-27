
import { NextRequest } from 'next/server'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import {
  handle,
  ok,
  unauthorized,
  badRequest,
  forbidden,
  notFound,
} from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getConversationAccess } from '@/lib/conversation-access'
import { getFirebaseAdminFirestore, publishFirebaseUserEvent } from '@/lib/firebase-admin'

export const dynamic = 'force-dynamic'

type Ctx = {
  params: Promise<{ id: string; messageId: string }>
}

export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id, messageId } = await ctx.params
  const userId = auth.profile.id

  const access = await getConversationAccess(id, userId)
  const body = await req.json().catch(() => ({}))
  const text = typeof body?.text === 'string' ? body.text.trim() : ''

  if (!text) {
    throw badRequest('Message text is empty.', 'EMPTY_MESSAGE')
  }

  if (text.length > 2000) {
    throw badRequest(
      'Messages can be up to 2000 characters.',
      'MESSAGE_TOO_LONG',
    )
  }

  const firestore = getFirebaseAdminFirestore()
  const messageRef = firestore
    .collection('conversations')
    .doc(id)
    .collection('messages')
    .doc(messageId)

  const editedAt = Timestamp.now()

  const result = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(messageRef)

    if (!snapshot.exists) {
      throw notFound('Message not found.')
    }

    const message = snapshot.data()!

    if (message.senderId !== userId) {
      throw forbidden('You can only edit your own messages.')
    }

    if (message.type !== 'text' || message.deletedForEveryoneAt) {
      throw badRequest(
        'Only an undeleted text message can be edited.',
        'MESSAGE_NOT_EDITABLE',
      )
    }

    transaction.update(messageRef, {
      text,
      editedAt,
    })

    return { messageId: snapshot.id }
  })

  await publishFirebaseUserEvent(
    [userId, ...access.others.map((other: any) => other.id)],
    'message:changed',
    {
      conversationId: id,
      messageId: result.messageId,
    },
  )

  return ok({
    messageId: result.messageId,
    text,
    editedAt: editedAt.toDate().toISOString(),
  })
})

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id, messageId } = await ctx.params
  const userId = auth.profile.id

  const access = await getConversationAccess(id, userId)
  const body = await req.json().catch(() => ({}))

  const mode =
    body?.mode === 'everyone'
      ? 'everyone'
      : body?.mode === 'me'
        ? 'me'
        : null

  if (!mode) {
    throw badRequest(
      'Choose whether to delete the message for you or everyone.',
      'INVALID_DELETE_MODE',
    )
  }

  const firestore = getFirebaseAdminFirestore()
  const messageRef = firestore
    .collection('conversations')
    .doc(id)
    .collection('messages')
    .doc(messageId)

  if (mode === 'me') {
    const snapshot = await messageRef.get()

    if (!snapshot.exists) {
      throw notFound('Message not found.')
    }

    await firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(messageRef)

      if (!current.exists) {
        throw notFound('Message not found.')
      }

      const data = current.data()!
      const hiddenForUserIds = Array.isArray(data.hiddenForUserIds)
        ? data.hiddenForUserIds as string[]
        : []

      if (!hiddenForUserIds.includes(userId)) {
        transaction.update(messageRef, {
          hiddenForUserIds: FieldValue.arrayUnion(userId),
        })
      }
    })

    await publishFirebaseUserEvent(
      [userId],
      'message:changed',
      { conversationId: id, messageId },
    )

    return ok({ deleted: true })
  }

  const deletedAt = Timestamp.now()

  const deleted = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(messageRef)

    if (!snapshot.exists) {
      throw notFound('Message not found.')
    }

    const message = snapshot.data()!

    if (message.senderId !== userId) {
      throw forbidden(
        'You can only delete your own messages for everyone.',
      )
    }

    if (message.deletedForEveryoneAt) {
      return false
    }

    transaction.update(messageRef, {
      text: null,
      fileId: null,
      deletedForEveryoneAt: deletedAt,
    })

    return true
  })

  if (!deleted) {
    return ok({ deleted: true })
  }

  await publishFirebaseUserEvent(
    [userId, ...access.others.map((other: any) => other.id)],
    'message:changed',
    { conversationId: id, messageId },
  )

  return ok({ deleted: true })
})
