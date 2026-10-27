
import { NextRequest } from 'next/server'
import {
  handle,
  ok,
  unauthorized,
  badRequest,
} from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import {
  getFirebaseAdminFirestore,
  publishFirebaseUserEvent,
} from '@/lib/firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

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

/**
 * Leaves a group conversation. A system message records the departure.
 * If the last member leaves, the group is deleted.
 */
export const POST = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id } = await ctx.params
  const meId = auth.profile.id
  const firestore = getFirebaseAdminFirestore()
  const conversationRef = firestore.collection('conversations').doc(id)
  const participantRef = conversationRef
    .collection('participants')
    .doc(meId)

  const [conversationSnapshot, participantSnapshot, participantsSnapshot] =
    await Promise.all([
      conversationRef.get(),
      participantRef.get(),
      conversationRef.collection('participants').get(),
    ])

  if (!conversationSnapshot.exists) {
    throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
  }

  const conversation = conversationSnapshot.data()!

  if (conversation.type !== 'group') {
    throw badRequest(
      'Only group chats can be left.',
      'NOT_A_GROUP',
    )
  }

  if (!participantSnapshot.exists) {
    throw badRequest(
      'You are not a participant of this conversation.',
      'NOT_PARTICIPANT',
    )
  }

  const remainingUserIds = participantsSnapshot.docs
    .map((doc) => String(doc.data().userId ?? doc.id))
    .filter((userId) => userId !== meId)

  const messageRef = conversationRef.collection('messages').doc()
  const now = Timestamp.now()

  // Record the departure and remove membership atomically.
  await firestore.runTransaction(async (transaction) => {
    const [latestConversation, latestParticipant, latestParticipants] =
      await Promise.all([
        transaction.get(conversationRef),
        transaction.get(participantRef),
        transaction.get(conversationRef.collection('participants')),
      ])

    if (!latestConversation.exists) {
      throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
    }

    if (latestConversation.data()?.type !== 'group') {
      throw badRequest(
        'Only group chats can be left.',
        'NOT_A_GROUP',
      )
    }

    if (!latestParticipant.exists) {
      throw badRequest(
        'You are not a participant of this conversation.',
        'NOT_PARTICIPANT',
      )
    }

    const currentRemaining = latestParticipants.docs.filter(
      (doc) => String(doc.data().userId ?? doc.id) !== meId,
    )

    transaction.set(messageRef, {
      conversationId: id,
      senderId: meId,
      type: 'system',
      text: `${auth.profile.displayName} left the group`,
      fileId: null,
      clientId: null,
      replyToId: null,
      editedAt: null,
      deletedForEveryoneAt: null,
      hiddenForUserIds: [],
      createdAt: now,
    })

    transaction.delete(participantRef)

    transaction.update(conversationRef, {
      updatedAt: FieldValue.serverTimestamp(),
    })

    // If this was the last member, the caller deletes the group and
    // its subcollections after this transaction commits.
    if (currentRemaining.length === 0) {
      transaction.update(conversationRef, {
        status: 'ended',
      })
    }
  })

  if (remainingUserIds.length === 0) {
    // Firestore does not cascade-delete subcollections when a parent
    // document is deleted. Remove messages and participants explicitly.
    await deleteSubcollection(conversationRef.path, 'messages')
    await deleteSubcollection(conversationRef.path, 'participants')
    await conversationRef.delete()

    return ok({ left: true, deleted: true })
  }

  await publishFirebaseUserEvent(
    remainingUserIds,
    'conversation:updated',
    {
      conversationId: id,
      memberLeft: auth.profile.publicId,
    },
  )

  return ok({ left: true, deleted: false })
})
