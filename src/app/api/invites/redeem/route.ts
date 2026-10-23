import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound, tooMany, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { normalizeCode, isValidCodeShape } from '@/lib/ids'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { createDirectConversation } from '@/lib/conversation-create'
import { isExpirationPolicy } from '@/lib/expire'
import { toConversationSummary, type ContactFlags } from '@/lib/dto'
import { notifyUsers } from '@/lib/notify'

export const dynamic = 'force-dynamic'

/**
 * Redeems an invite code. The recipient's identity stays private (only a
 * display name + public id are used). Invite messaging works even when the
 * recipient disabled random-chat availability, but NEVER bypasses blocks.
 * Chosen policy: redeemed conversations go straight to both inboxes.
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`redeem:${auth.profile.id}`, LIMITS.inviteRedeem.limit, LIMITS.inviteRedeem.windowMs)) {
    throw tooMany('Too many invite attempts. Try again later.', 1800)
  }
  const body = await req.json().catch(() => ({}))
  const code = normalizeCode(String(body?.code ?? ''))
  if (!isValidCodeShape(code, 7, 8)) {
    throw badRequest('Invite codes look like XK7Q2M9P (7–8 characters).', 'INVALID_INVITE')
  }
  const policy = isExpirationPolicy(body?.expirationPolicy) ? body.expirationPolicy : '24h'

  // Codes are stored in dashed form ("XK7Q-2M9P"); accept dashed or plain input.
  const candidates = [code]
  if (code.length === 8) candidates.unshift(`${code.slice(0, 4)}-${code.slice(4)}`)
  const recipient = await db.profile.findFirst({ where: { inviteCode: { in: candidates } } })
  if (!recipient) throw notFound('This invite code is not valid anymore.', 'INVITE_NOT_FOUND')
  if (recipient.id === auth.profile.id) {
    throw badRequest('That is your own invite code.', 'SELF_INVITE')
  }

  // Block check happens inside createDirectConversation (both directions)
  let conversation
  try {
    conversation = await createDirectConversation(auth.profile.id, recipient.id, policy)
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'BLOCKED') {
      // Deliberately vague to avoid leaking whether the recipient blocked you
      throw forbidden('This invite cannot be used right now.', 'INVITE_UNAVAILABLE')
    }
    throw err
  }

  // Realtime nudge so the recipient sees the new chat immediately
  await notifyUsers([recipient.id, auth.profile.id], 'conversation:new', {
    conversationId: conversation.id,
    byPublicId: auth.profile.publicId,
  })

  const fresh = await db.conversation.findUnique({
    where: { id: conversation.id },
    include: { participants: { include: { user: { include: { presence: true } } } } },
  })
  if (!fresh) throw badRequest('Could not open the conversation.', 'CONVERSATION_LOST')
  const contactRows = await db.contact.findMany({ where: { ownerId: auth.profile.id } })
  const contacts: ContactFlags = new Map(
    contactRows.map((c) => [c.contactId, { nickname: c.nickname, favorite: c.favorite }])
  )
  const presenceByUser = new Map(fresh.participants.map((q) => [q.userId, q.user.presence]))
  const summary = await toConversationSummary(
    fresh,
    auth.profile.id,
    fresh.participants,
    presenceByUser,
    contacts
  )

  return ok({ conversation: summary })
})
