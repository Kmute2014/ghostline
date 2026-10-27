
import {
  FieldValue,
  Timestamp,
} from 'firebase-admin/firestore'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { computeExpiresAt, type ExpirationPolicy } from '@/lib/expire'
import { ApiError } from '@/lib/api-helpers'

function toTimestamp(date: Date | null): Timestamp | null {
  return date ? Timestamp.fromDate(date) : null
}

/**
 * Creates a direct conversation using Firestore.
 * Both participants must not have blocked each other.
 */
export async function createDirectConversation(
  meId: string,
  otherId: string,
  policy: ExpirationPolicy,
) {
  if (meId === otherId) {
    throw new ApiError(
      400,
      'SELF_CONVERSATION',
      'You cannot open a conversation with yourself.',
    )
  }

  const firestore = getFirebaseAdminFirestore()
  const conversationRef = firestore.collection('conversations').doc()
  const myParticipantRef = conversationRef
    .collection('participants')
    .doc(meId)
  const otherParticipantRef = conversationRef
    .collection('participants')
    .doc(otherId)

  const blockCollection = firestore.collection('blockedUsers')

  const [outgoingBlock, incomingBlock] = await Promise.all([
    blockCollection
      .where('blockerId', '==', meId)
      .where('blockedId', '==', otherId)
      .limit(1)
      .get(),
    blockCollection
      .where('blockerId', '==', otherId)
      .where('blockedId', '==', meId)
      .limit(1)
      .get(),
  ])

  if (!outgoingBlock.empty || !incomingBlock.empty) {
    throw new ApiError(
      403,
      'BLOCKED',
      'A direct connection is not available between these users.',
    )
  }

  const now = new Date()
  const expiresAt = computeExpiresAt(policy)

  const conversationData = {
    type: 'direct',
    name: null,
    status: 'active',
    expirationPolicy: policy,
    expiresAt: toTimestamp(expiresAt),
    createdById: meId,
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
  }

  await firestore.runTransaction(async (transaction) => {
    transaction.create(conversationRef, conversationData)

    transaction.create(myParticipantRef, {
      userId: meId,
      lastReadAt: null,
      joinedAt: Timestamp.fromDate(now),
    })

    transaction.create(otherParticipantRef, {
      userId: otherId,
      lastReadAt: null,
      joinedAt: Timestamp.fromDate(now),
    })
  })

  return {
    id: conversationRef.id,
    ...conversationData,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Creates a group conversation in Firestore.
 * Group conversations do not expire automatically.
 * The caller is responsible for validating the requested members.
 */
export async function createGroupConversation(
  meId: string,
  name: string,
  memberIds: string[],
) {
  const firestore = getFirebaseAdminFirestore()
  const conversationRef = firestore.collection('conversations').doc()
  const now = new Date()

  const uniqueMemberIds = [
    ...new Set([meId, ...memberIds].filter(Boolean)),
  ]

  if (uniqueMemberIds.length === 0) {
    throw new ApiError(
      400,
      'INVALID_MEMBERS',
      'A group must have at least one member.',
    )
  }

  const conversationData = {
    type: 'group',
    name,
    status: 'active',
    expirationPolicy: 'never',
    expiresAt: null,
    createdById: meId,
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
  }

  // Firestore transactions have a limit of 500 writes.
  if (uniqueMemberIds.length + 1 > 500) {
    throw new ApiError(
      400,
      'TOO_MANY_MEMBERS',
      'The group has too many members.',
    )
  }

  await firestore.runTransaction(async (transaction) => {
    transaction.create(conversationRef, conversationData)

    for (const userId of uniqueMemberIds) {
      transaction.create(
        conversationRef.collection('participants').doc(userId),
        {
          userId,
          lastReadAt: null,
          joinedAt: Timestamp.fromDate(now),
        },
      )
    }
  })

  return {
    id: conversationRef.id,
    ...conversationData,
    createdAt: now,
    updatedAt: now,
  }
}
