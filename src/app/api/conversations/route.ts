
import { NextRequest } from 'next/server'
import {
  handle,
  ok,
  unauthorized,
  badRequest,
  tooMany,
} from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import {
  toConversationSummary,
  type ContactFlags,
} from '@/lib/dto'
import {
  isConversationExpired,
  isExpirationPolicy,
} from '@/lib/expire'
import { createDirectConversation } from '@/lib/conversation-create'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { publishFirebaseUserEvent } from '@/lib/firebase-admin'
import type { ConversationSummary } from '@/lib/types'

export const dynamic = 'force-dynamic'

function asDate(value: any): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value.toDate === 'function') return value.toDate()

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function asIsoDate(value: any): string | null {
  return asDate(value)?.toISOString() ?? null
}

export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const firestore = getFirebaseAdminFirestore()
  const meId = auth.profile.id

  const participantSnapshots = await firestore
    .collectionGroup('participants')
    .where('userId', '==', meId)
    .get()

  const conversationIds = [
    ...new Set(
      participantSnapshots.docs
        .map((doc) => doc.ref.parent.parent?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  ]

  const contactSnapshot = await firestore
    .collection('contacts')
    .where('ownerId', '==', meId)
    .get()

  const contacts: ContactFlags = new Map(
    contactSnapshot.docs.map((doc) => {
      const contact = doc.data()
      return [
        String(contact.contactId),
        {
          nickname: contact.nickname ?? null,
          favorite: contact.favorite === true,
        },
      ]
    }),
  )

  const active: ConversationSummary[] = []

  for (const conversationId of conversationIds) {
    const conversationRef = firestore
      .collection('conversations')
      .doc(conversationId)

    const conversationSnapshot = await conversationRef.get()
    if (!conversationSnapshot.exists) continue

    const rawConversation = conversationSnapshot.data()!
    const conversation = {
      id: conversationSnapshot.id,
      ...rawConversation,
      createdAt: asDate(rawConversation.createdAt) ?? new Date(0),
      updatedAt: asDate(rawConversation.updatedAt) ?? new Date(0),
      expiresAt: asDate(rawConversation.expiresAt),
    }

    if (isConversationExpired(conversation as any)) continue

    const participantsSnapshot = await conversationRef
      .collection('participants')
      .get()

    const participants = await Promise.all(
      participantsSnapshot.docs.map(async (participantDoc) => {
        const participant = participantDoc.data()
        const userId = String(participant.userId ?? participantDoc.id)

        const [profileSnapshot, presenceSnapshot] = await Promise.all([
          firestore.collection('profiles').doc(userId).get(),
          firestore.collection('presences').doc(userId).get(),
        ])

        if (!profileSnapshot.exists) return null

        const profile = profileSnapshot.data()!
        const presence = presenceSnapshot.exists
          ? presenceSnapshot.data()
          : null

        return {
          ...participant,
          userId,
          lastReadAt: asDate(participant.lastReadAt),
          joinedAt: asDate(participant.joinedAt) ?? new Date(0),
          user: {
            id: profileSnapshot.id,
            ...profile,
            createdAt: asDate(profile.createdAt) ?? new Date(0),
            updatedAt: asDate(profile.updatedAt) ?? new Date(0),
            presence: presence
              ? {
                  ...presence,
                  lastSeenAt: asDate(presence.lastSeenAt),
                  updatedAt: asDate(presence.updatedAt),
                }
              : null,
          },
        }
      }),
    )

    const validParticipants = participants.filter(
      (participant): participant is NonNullable<typeof participant> =>
        participant !== null,
    )

    if (
      (conversation as any).type !== 'group' &&
      !validParticipants.some((participant) => participant.userId !== meId)
    ) {
      continue
    }

    const presenceByUser = new Map(
      validParticipants.map((participant) => [
        participant.userId,
        participant.user.presence,
      ]),
    )

    active.push(
      await toConversationSummary(
        conversation as any,
        meId,
        validParticipants as any,
        presenceByUser as any,
        contacts,
      ),
    )
  }

  active.sort((a, b) => {
    const favoriteDifference =
      Number(Boolean(b.other?.favorited)) -
      Number(Boolean(a.other?.favorited))

    if (favoriteDifference !== 0) return favoriteDifference

    return new Date(b.updatedAt).getTime() -
      new Date(a.updatedAt).getTime()
  })

  return ok({ conversations: active })
})

/**
 * Starts a direct conversation with a user.
 * The initiator chooses the shared expiration policy.
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  if (
    !rateLimit(
      `conv:${auth.profile.id}`,
      LIMITS.conversationCreate.limit,
      LIMITS.conversationCreate.windowMs,
    )
  ) {
    throw tooMany(
      'You are opening too many conversations too quickly.',
      600,
    )
  }

  const body = await req.json().catch(() => ({}))
  const publicId = String(body?.publicId ?? '').trim()

  if (!publicId) {
    throw badRequest('A target user is required.', 'MISSING_USER')
  }

  const policy = isExpirationPolicy(body?.expirationPolicy)
    ? body.expirationPolicy
    : '24h'

  const firestore = getFirebaseAdminFirestore()

  const targetSnapshot = await firestore
    .collection('profiles')
    .where('publicId', '==', publicId)
    .limit(1)
    .get()

  if (targetSnapshot.empty) {
    throw badRequest('That user could not be found.', 'USER_NOT_FOUND')
  }

  const targetDoc = targetSnapshot.docs[0]
  const target = {
    id: targetDoc.id,
    ...targetDoc.data(),
  }

  const meId = auth.profile.id
  const targetId = target.id

  const conversation = await createDirectConversation(
    meId,
    targetId,
    policy,
  )

  await publishFirebaseUserEvent(
    [targetId, meId],
    'conversation:new',
    {
      conversationId: conversation.id,
      byPublicId: auth.profile.publicId,
    },
  )

  const conversationRef = firestore
    .collection('conversations')
    .doc(conversation.id)

  const freshSnapshot = await conversationRef.get()

  if (!freshSnapshot.exists) {
    throw badRequest(
      'Could not open the conversation.',
      'CONVERSATION_LOST',
    )
  }

  const rawConversation = freshSnapshot.data()!
  const fresh = {
    id: freshSnapshot.id,
    ...rawConversation,
    createdAt: asDate(rawConversation.createdAt) ?? new Date(0),
    updatedAt: asDate(rawConversation.updatedAt) ?? new Date(0),
    expiresAt: asDate(rawConversation.expiresAt),
  }

  const participantsSnapshot = await conversationRef
    .collection('participants')
    .get()

  const participants = await Promise.all(
    participantsSnapshot.docs.map(async (participantDoc) => {
      const participant = participantDoc.data()
      const userId = String(participant.userId ?? participantDoc.id)

      const [profileSnapshot, presenceSnapshot] = await Promise.all([
        firestore.collection('profiles').doc(userId).get(),
        firestore.collection('presences').doc(userId).get(),
      ])

      if (!profileSnapshot.exists) return null

      const profile = profileSnapshot.data()!
      const presence = presenceSnapshot.exists
        ? presenceSnapshot.data()
        : null

      return {
        ...participant,
        userId,
        lastReadAt: asDate(participant.lastReadAt),
        joinedAt: asDate(participant.joinedAt) ?? new Date(0),
        user: {
          id: profileSnapshot.id,
          ...profile,
          createdAt: asDate(profile.createdAt) ?? new Date(0),
          updatedAt: asDate(profile.updatedAt) ?? new Date(0),
          presence: presence
            ? {
                ...presence,
                lastSeenAt: asDate(presence.lastSeenAt),
                updatedAt: asDate(presence.updatedAt),
              }
            : null,
        },
      }
    }),
  )

  const validParticipants = participants.filter(
    (participant): participant is NonNullable<typeof participant> =>
      participant !== null,
  )

  const contactSnapshot = await firestore
    .collection('contacts')
    .where('ownerId', '==', meId)
    .get()

  const contacts: ContactFlags = new Map(
    contactSnapshot.docs.map((doc) => {
      const contact = doc.data()
      return [
        String(contact.contactId),
        {
          nickname: contact.nickname ?? null,
          favorite: contact.favorite === true,
        },
      ]
    }),
  )

  const presenceByUser = new Map(
    validParticipants.map((participant) => [
      participant.userId,
      participant.user.presence,
    ]),
  )

  const summary = await toConversationSummary(
    fresh as any,
    meId,
    validParticipants as any,
    presenceByUser as any,
    contacts,
  )

  return ok({ conversation: summary })
})

