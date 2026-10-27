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
  tooMany,
} from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore, publishFirebaseUserEvent } from '@/lib/firebase-admin'
import { toConversationSummary, type ContactFlags } from '@/lib/dto'
import { createGroupConversation } from '@/lib/conversation-create'
import { rateLimit, LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const MAX_GROUP_NAME = 60
const MAX_GROUP_MEMBERS = 30

/**
 * Creates a group conversation with the caller as creator.
 * Body: { name: string, memberPublicIds: string[] }
 * Users blocked in either direction are skipped and reported.
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
      'You are creating too many conversations too quickly.',
      600,
    )
  }

  const body = await req.json().catch(() => ({}))
  const name = String(body?.name ?? '').trim().slice(0, MAX_GROUP_NAME)

  if (!name) {
    throw badRequest('A group name is required.', 'MISSING_NAME')
  }

  const rawIds: unknown[] = Array.isArray(body?.memberPublicIds)
    ? body.memberPublicIds
    : []

  const publicIds = [
    ...new Set(
      rawIds
        .map((value) => String(value ?? '').trim())
        .filter((value) => Boolean(value)),
    ),
  ]

  if (publicIds.length === 0) {
    throw badRequest(
      'Add at least one member to the group.',
      'NO_MEMBERS',
    )
  }

  if (publicIds.length > MAX_GROUP_MEMBERS) {
    throw badRequest(
      `Groups are limited to ${MAX_GROUP_MEMBERS} members.`,
      'TOO_MANY_MEMBERS',
    )
  }

  const firestore = getFirebaseAdminFirestore()

  // Resolve the selected public IDs to Firestore profile documents.
  const targetSnapshot = await firestore
    .collection('profiles')
    .where('publicId', 'in', publicIds)
    .get()

  const found = new Map(
    targetSnapshot.docs.map((doc) => [
      String(doc.data().publicId),
      {
        id: doc.id,
        publicId: String(doc.data().publicId),
        displayName: String(doc.data().displayName ?? 'Anonymous'),
      },
    ]),
  )

  const missing = publicIds.filter((publicId) => !found.has(publicId))

  if (missing.length > 0) {
    throw badRequest(
      'Some selected users could not be found.',
      'USER_NOT_FOUND',
    )
  }

  const memberIds: string[] = []
  const skipped: string[] = []

  for (const publicId of publicIds) {
    const target = found.get(publicId)!

    // Do not add the caller to the group twice.
    if (target.id === auth.profile.id) continue

    // Check blocks in both directions.
    const [blockedByTarget, blockedByCaller] = await Promise.all([
      firestore
        .collection('blockedUsers')
        .where('blockerId', '==', target.id)
        .where('blockedId', '==', auth.profile.id)
        .limit(1)
        .get(),
      firestore
        .collection('blockedUsers')
        .where('blockerId', '==', auth.profile.id)
        .where('blockedId', '==', target.id)
        .limit(1)
        .get(),
    ])

    if (!blockedByTarget.empty || !blockedByCaller.empty) {
      skipped.push(target.displayName)
      continue
    }

    memberIds.push(target.id)
  }

  if (memberIds.length === 0) {
    throw badRequest(
      'None of the selected users can be added (block active).',
      'NO_ADDABLE_MEMBERS',
    )
  }

  const conversation = await createGroupConversation(
    auth.profile.id,
    name,
    memberIds,
  )

  const now = Timestamp.now()
  const messagesRef = firestore
    .collection('conversations')
    .doc(conversation.id)
    .collection('messages')

  // Add the system message to the group timeline.
  await messagesRef.add({
    conversationId: conversation.id,
    senderId: auth.profile.id,
    type: 'system',
    text: `${auth.profile.displayName} created the group â€œ${name}â€`,
    fileId: null,
    clientId: null,
    replyToId: null,
    editedAt: null,
    deletedForEveryoneAt: null,
    hiddenForUserIds: [],
    createdAt: now,
  })

  await firestore
    .collection('conversations')
    .doc(conversation.id)
    .update({
      updatedAt: FieldValue.serverTimestamp(),
    })

  // Notify the creator and the newly added members.
  await publishFirebaseUserEvent(
    [auth.profile.id, ...memberIds],
    'conversation:new',
    {
      conversationId: conversation.id,
      byPublicId: auth.profile.publicId,
      groupName: name,
    },
  )

  // Reload the conversation and participants from Firestore.
  const conversationRef = firestore
    .collection('conversations')
    .doc(conversation.id)

  const [conversationSnapshot, participantSnapshot, contactSnapshot] =
    await Promise.all([
      conversationRef.get(),
      conversationRef.collection('participants').get(),
      firestore
        .collection('contacts')
        .where('ownerId', '==', auth.profile.id)
        .get(),
    ])

  if (!conversationSnapshot.exists) {
    throw badRequest('Could not create the group.', 'GROUP_LOST')
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

  const contactRows = contactSnapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }))

  const contacts: ContactFlags = new Map(
    contactRows.map((contact: any) => [
      contact.contactId,
      {
        nickname: contact.nickname ?? null,
        favorite: Boolean(contact.favorite),
      },
    ]),
  )

  const summary = await toConversationSummary(
    {
      id: conversationSnapshot.id,
      ...conversationSnapshot.data(),
    } as never,
    auth.profile.id,
    participants as never,
    presenceByUser as Parameters<typeof toConversationSummary>[3],
    contacts,
  )

  return ok({ conversation: summary, skipped })
})

