
import { NextRequest } from 'next/server'
import {
  handle,
  ok,
  unauthorized,
  badRequest,
  gone,
  forbidden,
} from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getConversationAccess } from '@/lib/conversation-access'
import { getFirebaseAdminFirestore, publishFirebaseUserEvent } from '@/lib/firebase-admin'
import { toConversationSummary, type ContactFlags } from '@/lib/dto'
import {
  EXPIRATION_POLICIES,
  computeExpiresAt,
  isExpirationPolicy,
  isConversationExpired,
} from '@/lib/expire'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

function asDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate()
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

async function loadSummary(conversationId: string, meId: string) {
  const firestore = getFirebaseAdminFirestore()

  const conversationRef = firestore.collection('conversations').doc(conversationId)
  const conversationSnapshot = await conversationRef.get()

  if (!conversationSnapshot.exists) return null

  const conversationData = conversationSnapshot.data()!
  const conversation = {
    ...conversationData,
    id: conversationSnapshot.id,
    expiresAt: asDate(conversationData.expiresAt),
    createdAt: asDate(conversationData.createdAt) ?? new Date(0),
    updatedAt: asDate(conversationData.updatedAt) ?? new Date(0),
  }

  const [participantSnapshot, contactSnapshot] = await Promise.all([
    conversationRef.collection('participants').get(),
    firestore.collection('contacts').where('ownerId', '==', meId).get(),
  ])

  const participants = await Promise.all(
    participantSnapshot.docs.map(async (participantDoc) => {
      const participantData = participantDoc.data()
      const userId = String(participantData.userId ?? participantDoc.id)

      const [profileSnapshot, presenceSnapshot] = await Promise.all([
        firestore.collection('profiles').doc(userId).get(),
        firestore.collection('presences').doc(userId).get(),
      ])

      const profile = profileSnapshot.exists
        ? { ...profileSnapshot.data(), id: profileSnapshot.id }
        : {
            id: userId,
            publicId: '',
            displayName: 'Unknown user',
            avatarFileId: null,
            showInPeople: false,
          }

      return {
        userId,
        lastReadAt: asDate(participantData.lastReadAt),
        joinedAt: asDate(participantData.joinedAt),
        user: profile,
        presence: presenceSnapshot.exists
          ? presenceSnapshot.data()
          : null,
      }
    }),
  )

  const contacts: ContactFlags = new Map(
    contactSnapshot.docs.map((doc) => {
      const contact = doc.data()
      return [
        String(contact.contactId),
        {
          nickname: contact.nickname ?? null,
          favorite: Boolean(contact.favorite),
        },
      ]
    }),
  )

  const presenceByUser = new Map(
    participants.map((participant) => [
      participant.userId,
      participant.presence,
    ]),
  )

  return toConversationSummary(
    conversation as never,
    meId,
    participants as never,
    presenceByUser as never,
    contacts,
  )
}

async function deleteSubcollection(
  parentPath: string,
  subcollectionName: string,
): Promise<void> {
  const firestore = getFirebaseAdminFirestore()
  const collection = firestore.doc(parentPath).collection(subcollectionName)

  while (true) {
    const snapshot = await collection.limit(400).get()
    if (snapshot.empty) break

    const batch = firestore.batch()
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref)
    }
    await batch.commit()
  }
}

/** Get conversation details. */
export const GET = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)

  if (isConversationExpired(access.conversation)) {
    throw gone(
      'This conversation has expired.',
      'CONVERSATION_EXPIRED',
    )
  }

  const summary = await loadSummary(id, auth.profile.id)
  if (!summary) {
    throw gone(
      'This conversation has expired.',
      'CONVERSATION_EXPIRED',
    )
  }

  return ok({
    conversation: summary,
    iBlockedThem: access.iBlockedThem,
    theyBlockedMe: access.theyBlockedMe,
  })
})

/** Shared conversation settings. Direct conversations can use expiration policies. */
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)
  const body = await req.json().catch(() => ({}))
  const firestore = getFirebaseAdminFirestore()
  const conversationRef = firestore
    .collection('conversations')
    .doc(access.conversation.id)

  const eventUserIds = [
    auth.profile.id,
    ...access.others.map((other) => other.id),
  ]

  if (body.expirationPolicy !== undefined) {
    if (access.isGroup) {
      throw badRequest(
        'Groups keep their history until deleted — expiration does not apply.',
        'GROUP_NO_EXPIRY',
      )
    }

    if (access.conversation.status !== 'active') {
      throw gone(
        'Ended conversations cannot be changed.',
        'CONVERSATION_ENDED',
      )
    }

    if (!isExpirationPolicy(body.expirationPolicy)) {
      throw badRequest(
        'Unknown expiration policy.',
        'INVALID_POLICY',
      )
    }

    const policy = body.expirationPolicy as (typeof EXPIRATION_POLICIES)[number]
    const expiresAt = computeExpiresAt(policy)

    await conversationRef.update({
      expirationPolicy: policy,
      expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
      status: 'active',
      updatedAt: FieldValue.serverTimestamp(),
    })

    await publishFirebaseUserEvent(
      eventUserIds,
      'conversation:updated',
      {
        conversationId: access.conversation.id,
        expirationPolicy: policy,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    )
  }

  if (body.end === true) {
    if (access.isGroup) {
      throw badRequest(
        'Groups cannot be ended — leave the group or delete it if you created it.',
        'GROUP_NO_END',
      )
    }

    if (access.conversation.status !== 'active') {
      throw gone(
        'Conversation already ended.',
        'CONVERSATION_ENDED',
      )
    }

    await conversationRef.update({
      status: 'ended',
      updatedAt: FieldValue.serverTimestamp(),
    })

    await publishFirebaseUserEvent(
      eventUserIds,
      'conversation:updated',
      {
        conversationId: access.conversation.id,
        status: 'ended',
      },
    )
  }

  const summary = await loadSummary(id, auth.profile.id)
  if (!summary) {
    throw gone(
      'This conversation has expired.',
      'CONVERSATION_EXPIRED',
    )
  }

  return ok({ conversation: summary })
})

/** Deletes a conversation and its Firestore message and participant documents. */
export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)

  if (
    access.isGroup &&
    access.conversation.createdById !== auth.profile.id
  ) {
    throw forbidden(
      'Only the group creator can delete the group. You can leave it instead.',
      'GROUP_DELETE_CREATOR_ONLY',
    )
  }

  const firestore = getFirebaseAdminFirestore()
  const conversationRef = firestore
    .collection('conversations')
    .doc(access.conversation.id)

  const messageSnapshot = await conversationRef
    .collection('messages')
    .get()

  const fileIds = [
    ...new Set(
      messageSnapshot.docs
        .map((doc) => doc.data().fileId)
        .filter((fileId): fileId is string => typeof fileId === 'string' && fileId.length > 0),
    ),
  ]

  const userIds = [
    auth.profile.id,
    ...access.others.map((other) => other.id),
  ]

  // Remove subcollection documents explicitly: deleting a Firestore parent
  // document does not automatically delete its subcollections.
  await deleteSubcollection(conversationRef.path, 'messages')
  await deleteSubcollection(conversationRef.path, 'participants')

  // Remove file metadata only. This does not delete external storage objects.
  for (let offset = 0; offset < fileIds.length; offset += 400) {
    const batch = firestore.batch()

    for (const fileId of fileIds.slice(offset, offset + 400)) {
      batch.delete(firestore.collection('files').doc(fileId))
    }

    await batch.commit()
  }

  await conversationRef.delete()

  await publishFirebaseUserEvent(
    userIds,
    'conversation:deleted',
    {
      conversationIds: [access.conversation.id],
      reason: 'deleted',
    },
  )

  return ok({ deleted: true })
})
