import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound, tooMany, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { normalizeCode, isValidCodeShape } from '@/lib/ids'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { toConversationSummary, type ContactFlags } from '@/lib/dto'
import { notifyUsers } from '@/lib/notify'

export const dynamic = 'force-dynamic'

const MAX_GROUP_MEMBERS = 30

/**
 * Joins a group through its shareable join code ("GXK7-2M9P", dashed or
 * plain). Idempotent for existing members. Never bypasses blocks: if a block
 * exists between the joiner and ANY current member, the join is refused with
 * a deliberately vague error — a shared code must not become a way around a
 * closed contact.
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`group-join:${auth.profile.id}`, LIMITS.inviteRedeem.limit, LIMITS.inviteRedeem.windowMs)) {
    throw tooMany('Too many invite attempts. Try again later.', 1800)
  }

  const body = await req.json().catch(() => ({}))
  const code = normalizeCode(String(body?.code ?? ''))
  if (!isValidCodeShape(code, 7, 12) || !code.startsWith('G') || code.length !== 9) {
    throw badRequest('Group invite codes look like GXK72M9P.', 'INVALID_INVITE')
  }

  // Stored dashed ("GXK7-2M9P"); accept dashed or plain input.
  const candidates = [code, `G${code.slice(1, 5)}-${code.slice(5)}`]
  const conversation = await db.conversation.findFirst({
    where: { joinCode: { in: candidates }, type: 'group', status: 'active' },
    include: { participants: { select: { userId: true } } },
  })
  if (!conversation) {
    throw notFound('This group invite is not valid anymore.', 'INVITE_NOT_FOUND')
  }

  const mePart = conversation.participants.find((p) => p.userId === auth.profile.id)
  if (mePart) {
    // Already a member — just hand back the conversation (idempotent join).
    const summary = await buildSummary(conversation.id, auth.profile.id)
    return ok({ conversation: summary, joined: false })
  }

  if (conversation.participants.length >= MAX_GROUP_MEMBERS) {
    throw badRequest('This group is full.', 'TOO_MANY_MEMBERS')
  }

  // Block safety across every current member (either direction).
  const memberIds = conversation.participants.map((p) => p.userId)
  const block = await db.blockedUser.findFirst({
    where: {
      OR: [
        ...memberIds.map((m) => ({ blockerId: m, blockedId: auth.profile.id })),
        ...memberIds.map((m) => ({ blockerId: auth.profile.id, blockedId: m })),
      ],
    },
    select: { id: true },
  })
  if (block) {
    throw forbidden('This group invite cannot be used right now.', 'INVITE_UNAVAILABLE')
  }

  await db.conversationParticipant.create({
    data: { conversationId: conversation.id, userId: auth.profile.id },
  })

  await db.message.create({
    data: {
      conversationId: conversation.id,
      senderId: auth.profile.id,
      type: 'system',
      text: `${auth.profile.displayName} joined via invite code`,
    },
  })

  await notifyUsers([...memberIds, auth.profile.id], 'conversation:updated', {
    conversationId: conversation.id,
  })

  const summary = await buildSummary(conversation.id, auth.profile.id)
  return ok({ conversation: summary, joined: true })
})

async function buildSummary(conversationId: string, meId: string) {
  const fresh = await db.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: { include: { user: { include: { presence: true } } } } },
  })
  if (!fresh) throw badRequest('Could not open the group.', 'GROUP_LOST')
  const contactRows = await db.contact.findMany({ where: { ownerId: meId } })
  const contacts: ContactFlags = new Map(
    contactRows.map((c) => [c.contactId, { nickname: c.nickname, favorite: c.favorite }])
  )
  const presenceByUser = new Map(fresh.participants.map((q) => [q.userId, q.user.presence]))
  return toConversationSummary(fresh, meId, fresh.participants, presenceByUser, contacts)
}
