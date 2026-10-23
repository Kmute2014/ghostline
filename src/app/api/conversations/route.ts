import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { toConversationSummary, type ContactFlags } from '@/lib/dto'
import { isConversationExpired, isExpirationPolicy } from '@/lib/expire'
import { createDirectConversation } from '@/lib/conversation-create'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { notifyUsers } from '@/lib/notify'
import type { ConversationSummary } from '@/lib/types'

export const dynamic = 'force-dynamic'

const CONV_INCLUDE = {
  participants: { include: { user: { include: { presence: true } } } },
} satisfies Prisma.ConversationInclude

export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id

  const participations = await db.conversationParticipant.findMany({
    where: { userId: meId },
    include: { conversation: { include: CONV_INCLUDE } },
  })

  const contactRows = await db.contact.findMany({ where: { ownerId: meId } })
  const contacts: ContactFlags = new Map(
    contactRows.map((c) => [c.contactId, { nickname: c.nickname, favorite: c.favorite }])
  )

  const active: ConversationSummary[] = []
  for (const p of participations) {
    const conv = p.conversation
    // Expired conversations are hidden from the list and lazily cleaned.
    if (isConversationExpired(conv)) continue
    if (conv.type !== 'group' && !conv.participants.some((q) => q.userId !== meId)) continue
    const presenceByUser = new Map(conv.participants.map((q) => [q.userId, q.user.presence]))
    active.push(await toConversationSummary(conv, meId, conv.participants, presenceByUser, contacts))
  }

  // Favourited users always float to the top, then most recently active.
  active.sort((a, b) => {
    const fa = a.other?.favorited ? 1 : 0
    const fb = b.other?.favorited ? 1 : 0
    if (fa !== fb) return fb - fa
    return a.updatedAt < b.updatedAt ? 1 : -1
  })
  return ok({ conversations: active })
})

/**
 * Starts a direct conversation with a user (e.g. from Nearby or Contacts).
 * The initiator picks the shared expiration policy. Blocks are a hard stop.
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`conv:${auth.profile.id}`, LIMITS.conversationCreate.limit, LIMITS.conversationCreate.windowMs)) {
    throw tooMany('You are opening too many conversations too quickly.', 600)
  }
  const body = await req.json().catch(() => ({}))
  const publicId = String(body?.publicId ?? '').trim()
  if (!publicId) throw badRequest('A target user is required.', 'MISSING_USER')
  const policy = isExpirationPolicy(body?.expirationPolicy) ? body.expirationPolicy : '24h'

  const target = await db.profile.findUnique({ where: { publicId } })
  if (!target) throw badRequest('That user could not be found.', 'USER_NOT_FOUND')

  const conversation = await createDirectConversation(auth.profile.id, target.id, policy)

  const [meId, targetId] = [auth.profile.id, target.id]
  await notifyUsers([targetId, meId], 'conversation:new', {
    conversationId: conversation.id,
    byPublicId: auth.profile.publicId,
  })

  const fresh = await db.conversation.findUnique({
    where: { id: conversation.id },
    include: CONV_INCLUDE,
  })
  if (!fresh) throw badRequest('Could not open the conversation.', 'CONVERSATION_LOST')
  const contactRows = await db.contact.findMany({ where: { ownerId: meId } })
  const contacts: ContactFlags = new Map(
    contactRows.map((c) => [c.contactId, { nickname: c.nickname, favorite: c.favorite }])
  )
  const presenceByUser = new Map(fresh.participants.map((q) => [q.userId, q.user.presence]))
  const summary = await toConversationSummary(fresh, meId, fresh.participants, presenceByUser, contacts)
  return ok({ conversation: summary })
})
