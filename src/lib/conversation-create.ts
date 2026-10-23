import { db } from '@/lib/db'
import { computeExpiresAt, type ExpirationPolicy } from '@/lib/expire'
import { ApiError } from '@/lib/api-helpers'

/**
 * Creates a direct conversation (People directory, Nearby, invite redemption).
 * Expiration policy is chosen by the initiator; the shared policy can later be
 * changed by either participant via PATCH /api/conversations/[id].
 */
export async function createDirectConversation(
  meId: string,
  otherId: string,
  policy: ExpirationPolicy
) {
  if (meId === otherId) {
    throw new ApiError(400, 'SELF_CONVERSATION', 'You cannot open a conversation with yourself.')
  }

  // Blocks are a hard stop in both directions.
  const blocks = await db.blockedUser.findMany({
    where: {
      OR: [
        { blockerId: meId, blockedId: otherId },
        { blockerId: otherId, blockedId: meId },
      ],
    },
  })
  if (blocks.length > 0) {
    throw new ApiError(403, 'BLOCKED', 'A direct connection is not available between these users.')
  }

  const conversation = await db.conversation.create({
    data: {
      type: 'direct',
      status: 'active',
      expirationPolicy: policy,
      expiresAt: computeExpiresAt(policy),
      createdById: meId,
      participants: { create: [{ userId: meId }, { userId: otherId }] },
    },
  })
  return conversation
}

/**
 * Creates a group conversation. Groups never expire (history is kept until
 * the group is deleted) and can be started with any mix of known users.
 * Caller is responsible for validating membership and block-state.
 */
export async function createGroupConversation(meId: string, name: string, memberIds: string[]) {
  const conversation = await db.conversation.create({
    data: {
      type: 'group',
      name,
      status: 'active',
      expirationPolicy: 'never',
      expiresAt: null,
      createdById: meId,
      participants: {
        create: [{ userId: meId }, ...memberIds.map((userId) => ({ userId }))],
      },
    },
  })
  return conversation
}
