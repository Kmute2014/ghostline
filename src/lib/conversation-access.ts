
import {
  Timestamp,
  type DocumentData,
} from 'firebase-admin/firestore'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { ApiError, forbidden, notFound, gone } from '@/lib/api-helpers'
import { isConversationExpired } from '@/lib/expire'

export type OtherParticipant = {
  id: string
  lastReadAt: Date | null
  profile: {
    publicId: string
    displayName: string
    avatarFileId: string | null
    showInPeople: boolean
  }
}

export type ConversationAccess = {
  conversation: {
    id: string
    type: string
    name: string | null
    status: string
    expirationPolicy: string
    expiresAt: Date | null
    createdById: string
    createdAt: Date
    updatedAt: Date
  }
  meParticipant: { id: string; lastReadAt: Date | null }
  others: OtherParticipant[]
  isGroup: boolean
  iBlockedThem: boolean
  theyBlockedMe: boolean
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (value instanceof Timestamp) return value.toDate()

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof value.toDate === 'function'
  ) {
    return value.toDate()
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date
  }

  return null
}

function requiredDate(value: unknown, field: string): Date {
  const date = asDate(value)
  if (!date) {
    throw new Error(`Invalid or missing conversation field: ${field}`)
  }
  return date
}

function conversationFromData(
  id: string,
  data: DocumentData,
): ConversationAccess['conversation'] {
  return {
    id,
    type: String(data.type ?? 'direct'),
    name: data.name ?? null,
    status: String(data.status ?? 'active'),
    expirationPolicy: String(data.expirationPolicy ?? '24h'),
    expiresAt: asDate(data.expiresAt),
    createdById: String(data.createdById ?? ''),
    createdAt: requiredDate(data.createdAt, 'createdAt'),
    updatedAt: requiredDate(data.updatedAt, 'updatedAt'),
  }
}

/** Loads a conversation and verifies that the caller is a participant. */
export async function getConversationAccess(
  conversationId: string,
  meId: string,
): Promise<ConversationAccess> {
  const firestore = getFirebaseAdminFirestore()
  const conversationRef = firestore.collection('conversations').doc(conversationId)
  const conversationSnap = await conversationRef.get()

  if (!conversationSnap.exists) {
    throw notFound('Conversation not found.')
  }

  const conversation = conversationFromData(
    conversationSnap.id,
    conversationSnap.data()!,
  )

  const participantsSnap = await conversationRef
    .collection('participants')
    .get()

  const participants = participantsSnap.docs.map((doc) => ({
    id: doc.id,
    userId: String(doc.data().userId ?? doc.id),
    lastReadAt: asDate(doc.data().lastReadAt),
  }))

  const mePart = participants.find((participant) => participant.userId === meId)

  if (!mePart) {
    throw forbidden(
      'You are not a participant of this conversation.',
      'NOT_PARTICIPANT',
    )
  }

  const isGroup = conversation.type === 'group'
  const otherParticipantRows = participants.filter(
    (participant) => participant.userId !== meId,
  )

  if (!isGroup && otherParticipantRows.length === 0) {
    throw notFound('The other participant is no longer available.')
  }

  const others: OtherParticipant[] = []

  for (const participant of otherParticipantRows) {
    const profileSnap = await firestore
      .collection('profiles')
      .doc(participant.userId)
      .get()

    if (!profileSnap.exists) continue

    const profile = profileSnap.data()!

    others.push({
      id: participant.userId,
      lastReadAt: participant.lastReadAt,
      profile: {
        publicId: String(profile.publicId ?? ''),
        displayName: String(profile.displayName ?? 'Anonymous'),
        avatarFileId: profile.avatarFileId ?? null,
        showInPeople: profile.showInPeople ?? true,
      },
    })
  }

  if (!isGroup && others.length === 0) {
    throw notFound('The other participant is no longer available.')
  }

  let iBlockedThem = false
  let theyBlockedMe = false

  if (!isGroup && others[0]) {
    const otherId = others[0].id
    const blocks = firestore.collection('blockedUsers')

    const [outgoingBlock, incomingBlock] = await Promise.all([
      blocks
        .where('blockerId', '==', meId)
        .where('blockedId', '==', otherId)
        .limit(1)
        .get(),
      blocks
        .where('blockerId', '==', otherId)
        .where('blockedId', '==', meId)
        .limit(1)
        .get(),
    ])

    iBlockedThem = !outgoingBlock.empty
    theyBlockedMe = !incomingBlock.empty
  }

  return {
    conversation,
    meParticipant: {
      id: mePart.id,
      lastReadAt: mePart.lastReadAt,
    },
    others,
    isGroup,
    iBlockedThem,
    theyBlockedMe,
  }
}

/** Rejects sending messages to ended, expired, or blocked direct conversations. */
export function assertCanSend(access: ConversationAccess) {
  if (access.conversation.status !== 'active') {
    throw gone(
      'This conversation has ended and no longer accepts messages.',
      'CONVERSATION_ENDED',
    )
  }

  if (isConversationExpired(access.conversation)) {
    throw gone(
      'This conversation has expired and no longer accepts messages.',
      'CONVERSATION_EXPIRED',
    )
  }

  if (
    !access.isGroup &&
    (access.iBlockedThem || access.theyBlockedMe)
  ) {
    throw forbidden(
      'Messaging is unavailable between blocked users.',
      'BLOCKED',
    )
  }
}

/** Looks up a profile by its public ID and includes its presence record. */
export async function findProfileByPublicId(publicId: string) {
  const firestore = getFirebaseAdminFirestore()

  const profileQuery = await firestore
    .collection('profiles')
    .where('publicId', '==', publicId)
    .limit(1)
    .get()

  if (profileQuery.empty) return null

  const profileDoc = profileQuery.docs[0]
  const profile = profileDoc.data()

  const presenceSnap = await firestore
    .collection('presences')
    .doc(profileDoc.id)
    .get()

  const presenceData = presenceSnap.exists ? presenceSnap.data()! : null

  return {
    id: profileDoc.id,
    ...profile,
    createdAt: asDate(profile.createdAt) ?? new Date(),
    updatedAt: asDate(profile.updatedAt) ?? new Date(),
    presence: presenceData
      ? {
          userId: profileDoc.id,
          isOnline: presenceData.isOnline ?? false,
          lastHeartbeatAt: asDate(presenceData.lastHeartbeatAt),
          lastSeenAt: asDate(presenceData.lastSeenAt) ?? new Date(),
        }
      : null,
  }
}

export { ApiError }
