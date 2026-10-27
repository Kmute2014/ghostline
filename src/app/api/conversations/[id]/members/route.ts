
import { NextRequest } from 'next/server'
import {
  handle,
  ok,
  unauthorized,
  badRequest,
  tooMany,
} from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import {
  getFirebaseAdminFirestore,
  publishFirebaseUserEvent,
} from '@/lib/firebase-admin'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const MAX_GROUP_MEMBERS = 30

/**
 * Invites users into an existing group.
 * Any current participant may invite. Users blocked in either direction
 * are skipped, and the member limit is checked transactionally.
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id } = await ctx.params

  if (
    !rateLimit(
      `members:${auth.profile.id}`,
      LIMITS.memberAdd.limit,
      LIMITS.memberAdd.windowMs,
    )
  ) {
    throw tooMany('Too many invite attempts. Try again later.', 1800)
  }

  const firestore = getFirebaseAdminFirestore()
  const conversationRef = firestore.collection('conversations').doc(id)
  const participantCollection = conversationRef.collection('participants')

  const [conversationSnapshot, participantSnapshot] = await Promise.all([
    conversationRef.get(),
    participantCollection.get(),
  ])

  if (
    !conversationSnapshot.exists ||
    conversationSnapshot.data()?.status !== 'active'
  ) {
    throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
  }

  const conversation = conversationSnapshot.data()!

  if (conversation.type !== 'group') {
    throw badRequest(
      'Members can only be added to group chats.',
      'NOT_A_GROUP',
    )
  }

  if (!participantSnapshot.docs.some(
    (doc) => String(doc.data().userId ?? doc.id) === auth.profile.id,
  )) {
    throw badRequest(
      'You are not a participant of this group.',
      'NOT_PARTICIPANT',
    )
  }

  const body = await req.json().catch(() => ({}))
  const rawIds: unknown[] = Array.isArray(body?.memberPublicIds)
    ? body.memberPublicIds
    : []

  const publicIds = [
    ...new Set(
      rawIds
        .map((value) => String(value ?? '').trim())
        .filter(Boolean),
    ),
  ]

  if (publicIds.length === 0) {
    throw badRequest('Pick at least one person to invite.', 'NO_MEMBERS')
  }

  if (publicIds.length > MAX_GROUP_MEMBERS) {
    throw badRequest(
      `You can select at most ${MAX_GROUP_MEMBERS} people at a time.`,
      'TOO_MANY_MEMBERS',
    )
  }

  const existing = new Set(
    participantSnapshot.docs.map((doc) =>
      String(doc.data().userId ?? doc.id),
    ),
  )

  if (existing.size + publicIds.filter((publicId) => publicId).length > MAX_GROUP_MEMBERS) {
    // A more precise check below accounts for duplicates, self, and existing members.
    // Do not reject solely because the request contains existing members.
  }

  const profilesSnapshot = await firestore
    .collection('profiles')
    .where('publicId', 'in', publicIds)
    .get()

  const profilesByPublicId = new Map(
    profilesSnapshot.docs.map((doc) => [
      String(doc.data().publicId),
      {
        id: doc.id,
        publicId: String(doc.data().publicId),
        displayName: String(doc.data().displayName ?? 'Unknown user'),
      },
    ]),
  )

  const missing = publicIds.filter(
    (publicId) => !profilesByPublicId.has(publicId),
  )

  if (missing.length > 0) {
    throw badRequest(
      'Some selected users could not be found.',
      'USER_NOT_FOUND',
    )
  }

  const candidates = publicIds
    .map((publicId) => profilesByPublicId.get(publicId)!)
    .filter((profile) => profile.id !== auth.profile.id)
    .filter((profile) => !existing.has(profile.id))

  const skipped: string[] = []
  const eligible: typeof candidates = []

  // Preserve the existing rule: a block in either direction prevents an invite.
  for (const candidate of candidates) {
    const [blockedByCandidate, blockedByInviter] = await Promise.all([
      firestore
        .collection('blockedUsers')
        .where('blockerId', '==', candidate.id)
        .where('blockedId', '==', auth.profile.id)
        .limit(1)
        .get(),
      firestore
        .collection('blockedUsers')
        .where('blockerId', '==', auth.profile.id)
        .where('blockedId', '==', candidate.id)
        .limit(1)
        .get(),
    ])

    if (!blockedByCandidate.empty || !blockedByInviter.empty) {
      skipped.push(candidate.displayName)
      continue
    }

    eligible.push(candidate)
  }

  if (eligible.length === 0) {
    throw badRequest(
      skipped.length > 0
        ? `Couldn't add: ${skipped.join(', ')} (block active).`
        : 'Everyone selected is already in the group.',
      'NO_ADDABLE_MEMBERS',
    )
  }

  const messageRef = conversationRef.collection('messages').doc()
  const now = Timestamp.now()
  const addedIds: string[] = []
  const addedNames: string[] = []

  await firestore.runTransaction(async (transaction) => {
    const [latestConversation, latestParticipants, inviterParticipant] =
      await Promise.all([
        transaction.get(conversationRef),
        transaction.get(participantCollection),
        transaction.get(participantCollection.doc(auth.profile.id)),
      ])

    if (
      !latestConversation.exists ||
      latestConversation.data()?.status !== 'active'
    ) {
      throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
    }

    if (latestConversation.data()?.type !== 'group') {
      throw badRequest(
        'Members can only be added to group chats.',
        'NOT_A_GROUP',
      )
    }

    if (!inviterParticipant.exists) {
      throw badRequest(
        'You are not a participant of this group.',
        'NOT_PARTICIPANT',
      )
    }

    const currentIds = new Set(
      latestParticipants.docs.map((doc) =>
        String(doc.data().userId ?? doc.id),
      ),
    )

    const toAdd = eligible.filter(
      (profile) => !currentIds.has(profile.id),
    )

    if (currentIds.size + toAdd.length > MAX_GROUP_MEMBERS) {
      throw badRequest(
        `Groups are limited to ${MAX_GROUP_MEMBERS} members.`,
        'TOO_MANY_MEMBERS',
      )
    }

    if (toAdd.length === 0) {
      throw badRequest(
        'Everyone selected is already in the group.',
        'NO_ADDABLE_MEMBERS',
      )
    }

    // Firestore transaction reads are complete; now write the new memberships.
    for (const profile of toAdd) {
      transaction.set(participantCollection.doc(profile.id), {
        userId: profile.id,
        lastReadAt: null,
        joinedAt: now,
      })

      addedIds.push(profile.id)
      addedNames.push(profile.displayName)
    }

    const joinedList =
      addedNames.length <= 3
        ? addedNames.join(', ')
        : `${addedNames.slice(0, 3).join(', ')} +${addedNames.length - 3} more`

    transaction.set(messageRef, {
      conversationId: id,
      senderId: auth.profile.id,
      type: 'system',
      text: `${auth.profile.displayName} added ${joinedList}`,
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

  // Newly added members receive the conversation appearance event.
  await publishFirebaseUserEvent(
    addedIds,
    'conversation:new',
    {
      conversationId: id,
      byPublicId: auth.profile.publicId,
      groupName: conversation.name ?? '',
    },
  )

  // Existing and new members refresh their group roster and timeline.
  await publishFirebaseUserEvent(
    [...new Set([...existing, ...addedIds])],
    'conversation:updated',
    { conversationId: id },
  )

  return ok({
    added: addedNames,
    skipped,
    memberCount: existing.size + addedIds.length,
  })
})
