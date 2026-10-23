import { db } from '@/lib/db'
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
  /** Every other participant (one for direct chats, many for groups). */
  others: OtherParticipant[]
  isGroup: boolean
  /** Block state — only meaningful for direct chats (always false for groups). */
  iBlockedThem: boolean
  theyBlockedMe: boolean
}

/** Loads a conversation and enforces that the caller is a participant. */
export async function getConversationAccess(conversationId: string, meId: string): Promise<ConversationAccess> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: { include: { user: { include: { presence: true } } } } },
  })
  if (!conversation) throw notFound('Conversation not found.')

  const mePart = conversation.participants.find((p) => p.userId === meId)
  if (!mePart) throw forbidden('You are not a participant of this conversation.', 'NOT_PARTICIPANT')

  const isGroup = conversation.type === 'group'
  const others = conversation.participants
    .filter((p) => p.userId !== meId)
    .map((p) => ({
      id: p.userId,
      lastReadAt: p.lastReadAt,
      profile: p.user,
    }))
  // Direct conversations have exactly one other participant. If they are gone
  // (deletion race), the conversation is effectively over.
  if (!isGroup && others.length === 0) throw notFound('The other participant is no longer available.')

  // Blocks gate direct messaging in both directions. Group chats are shared
  // spaces — a member blocking another member mutes their DM, not the group.
  let iBlockedThem = false
  let theyBlockedMe = false
  if (!isGroup && others[0]) {
    const blocks = await db.blockedUser.findMany({
      where: {
        OR: [
          { blockerId: meId, blockedId: others[0].id },
          { blockerId: others[0].id, blockedId: meId },
        ],
      },
      select: { blockerId: true },
    })
    iBlockedThem = blocks.some((b) => b.blockerId === meId)
    theyBlockedMe = blocks.some((b) => b.blockerId === others[0].id)
  }

  return {
    conversation,
    meParticipant: { id: mePart.id, lastReadAt: mePart.lastReadAt },
    others,
    isGroup,
    iBlockedThem,
    theyBlockedMe,
  }
}

/** For sending: expired or ended conversations reject new messages. */
export function assertCanSend(access: ConversationAccess) {
  if (access.conversation.status !== 'active') {
    throw gone('This conversation has ended and no longer accepts messages.', 'CONVERSATION_ENDED')
  }
  if (isConversationExpired(access.conversation)) {
    throw gone('This conversation has expired and no longer accepts messages.', 'CONVERSATION_EXPIRED')
  }
  if (!access.isGroup && (access.iBlockedThem || access.theyBlockedMe)) {
    throw forbidden('Messaging is unavailable between blocked users.', 'BLOCKED')
  }
}

/** Partner lookup by publicId → profile id. */
export async function findProfileByPublicId(publicId: string) {
  return db.profile.findUnique({ where: { publicId }, include: { presence: true } })
}

export { ApiError }
