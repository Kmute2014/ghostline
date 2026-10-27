import { NextRequest } from 'next/server'
import {
  FieldValue,
  Timestamp,
} from 'firebase-admin/firestore'
import {
  handle,
  ok,
  unauthorized,
  badRequest,
  notFound,
  tooMany,
  forbidden,
} from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore, publishFirebaseUserEvent } from '@/lib/firebase-admin'
import { normalizeCode, isValidCodeShape } from '@/lib/ids'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { toConversationSummary, type ContactFlags } from '@/lib/dto'

export const dynamic = 'force-dynamic'

const MAX_GROUP_MEMBERS = 30

/**
 * Joins a group through its shareable join code.
 * Accepts dashed or plain input and is idempotent for existing members.
 * Joining is refused if a block exists between the joiner and any member.
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()

  if (!auth) throw unauthorized()

  if (
    !rateLimit(
      `group-join:${auth.profile.id}`,
      LIMITS.inviteRedeem.limit,
      LIMITS.inviteRedeem.windowMs,
    )
  ) {
    throw tooMany('Too many invite attempts. Try again later.', 1800)
  }

  const body = await req.json().catch(() => ({}))
  const code = normalizeCode(String(body?.code ?? ''))

  if (
    !isValidCodeShape(code, 7, 12) ||
    !code.startsWith('G') ||
    code.length !== 9
  ) {
    throw badRequest(
      'Group invite codes look like GXK72M9P.',
      'INVALID_INVITE',
    )
  }

  const firestore = getFirebaseAdminFirestore()

  // The stored code may contain a dash; accept both formats.
  const candidates = [
    code,
    `G${code.slice(1, 5)}-${code.slice(5)}`,
  ]

  const conversationSnapshot = await firestore
    .collection('conversations')
    .where('joinCode', 'in', candidates)
    .where('type', '==', 'group')
    .where('status', '==', 'active')
    .limit(1)
    .get()

  if (conversationSnapshot.empty) {
    throw notFound(
      'This group invite is not valid anymore.',
      'INVITE_NOT_FOUND',
    )
  }

  const conversationDoc = conversationSnapshot.docs[0]
  const conversationId = conversationDoc.id
  const conversationRef = conversationDoc.ref
  const participantsRef = conversationRef.collection('participants')

  const participantSnapshot = await participantsRef.get()
  const memberIds = participantSnapshot.docs.map((doc) => doc.id)

  if (memberIds.includes(auth.profile.id)) {
    const summary = await buildSummary(conversationId, auth.profile.id)
    return ok({ conversation: summary, joined: false })
  }

  if (memberIds.length >= MAX_GROUP_MEMBERS) {
    throw badRequest('This group is full.', 'TOO_MANY_MEMBERS')
  }

  // Never allow a group invite to bypass a block in either direction.
  for (const memberId of memberIds) {
    const [blockedByMember, blockedByJoiner] = await Promise.all([
      firestore
        .collection('blockedUsers')
        .where('blockerId', '==', memberId)
        .where('blockedId', '==', auth.profile.id)
        .limit(1)
        .get(),
      firestore
        .collection('blockedUsers')
        .where('blockerId', '==', auth.profile.id)
        .where('blockedId', '==', memberId)
        .limit(1)
        .get(),
    ])

    if (!blockedByMember.empty || !blockedByJoiner.empty) {
      throw forbidden(
        'This group invite cannot be used right now.',
        'INVITE_UNAVAILABLE',
      )
    }
  }

  const participantRef = participantsRef.doc(auth.profile.id)
  const messagesRef = conversationRef.collection('messages')
  const messageRef = messagesRef.doc()
  const now = Timestamp.now()

  // Recheck membership and capacity atomically before joining.
  await firestore.runTransaction(async (transaction) => {
    const [freshConversation, freshParticipantSnapshot] =
      await Promise.all([
        transaction.get(conversationRef),
        transaction.get(participantsRef),
      ])

    if (
      !freshConversation.exists ||
      freshConversation.data()?.type !== 'group' ||
      freshConversation.data()?.status !== 'active' ||
      !freshConversation.data()?.joinCode ||
      !candidates.includes(String(freshConversation.data()?.joinCode))
    ) {
      throw notFound(
        'This group invite is not valid anymore.',
        'INVITE_NOT_FOUND',
      )
    }

    if (
      freshParticipantSnapshot.docs.some(
        (doc) => doc.id === auth.profile.id,
      )
    ) {
      return
    }

    if (freshParticipantSnapshot.size >= MAX_GROUP_MEMBERS) {
      throw badRequest('This group is full.', 'TOO_MANY_MEMBERS')
    }

    transaction.create(participantRef, {
      userId: auth.profile.id,
      joinedAt: now,
      lastReadAt: now,
    })

    transaction.create(messageRef, {
      conversationId,
      senderId: auth.profile.id,
      type: 'system',
      text: `${auth.profile.displayName} joined via invite code`,
      fileId: null,
      clientId: null,
      replyToId: null,
      editedAt: null,
      deletedForEveryoneAt: null,
      hiddenForUserIds: [],
      createdAt: now,
    })

    transaction.update(conversationRef, {
      updatedAt: FieldValue.serverTimestamp(),
    })
  })

  // Refresh membership after the transaction to handle concurrent joins.
  const joinedParticipant = await participantRef.get()

  if (!joinedParticipant.exists) {
    throw badRequest('Could not join the group.', 'GROUP_LOST')
  }

  const finalParticipants = await participantsRef.get()

  await publishFirebaseUserEvent(
    finalParticipants.docs.map((doc) => doc.id),
    'conversation:updated',
    { conversationId },
  )

  const summary = await buildSummary(conversationId, auth.profile.id)

  return ok({ conversation: summary, joined: true })
})

async function buildSummary(conversationId: string, meId: string) {
  const firestore = getFirebaseAdminFirestore()
  const conversationRef = firestore
    .collection('conversations')
    .doc(conversationId)

  const [conversationSnapshot, participantSnapshot, contactSnapshot] =
    await Promise.all([
      conversationRef.get(),
      conversationRef.collection('participants').get(),
      firestore
        .collection('contacts')
        .where('ownerId', '==', meId)
        .get(),
    ])

  if (!conversationSnapshot.exists) {
    throw badRequest('Could not open the group.', 'GROUP_LOST')
  }

  const participantDocs = participantSnapshot.docs
  const participantIds = participantDocs.map((doc) => doc.id)

  const [profileSnapshots, presenceSnapshots] = await Promise.all([
    Promise.all(
      participantIds.map((id) =>
        firestore.collection('profiles').doc(id).get(),
      ),
    ),
    Promise.all(
      participantIds.map((id) =>
        firestore.collection('presences').doc(id).get(),
      ),
    ),
  ])

  const profilesByUser = new Map(
    profileSnapshots.map((snapshot) => [
      snapshot.id,
      snapshot.exists
        ? { id: snapshot.id, ...snapshot.data() }
        : { id: snapshot.id, displayName: 'Anonymous' },
    ]),
  )

  const presenceByUser = new Map(
    presenceSnapshots.map((snapshot) => [
      snapshot.id,
      snapshot.exists ? snapshot.data() : null,
    ]),
  )

  const participants = participantDocs.map((doc) => ({
    ...doc.data(),
    userId: doc.id,
    user: {
      ...profilesByUser.get(doc.id),
      presence: presenceByUser.get(doc.id),
    },
  }))

  const contacts: ContactFlags = new Map(
    contactSnapshot.docs.map((doc) => {
      const contact = doc.data()

      return [
        contact.contactId,
        {
          nickname: contact.nickname ?? null,
          favorite: Boolean(contact.favorite),
        },
      ]
    }),
  )

  return toConversationSummary(
    {
      id: conversationSnapshot.id,
      ...conversationSnapshot.data(),
    } as never,
    meId,
    participants as never,
    presenceByUser,
    contacts,
  )
}
