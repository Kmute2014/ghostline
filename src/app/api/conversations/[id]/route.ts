import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, gone, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getConversationAccess } from '@/lib/conversation-access'
import { db } from '@/lib/db'
import { toConversationSummary, type ContactFlags } from '@/lib/dto'
import { EXPIRATION_POLICIES, computeExpiresAt, isExpirationPolicy, isConversationExpired } from '@/lib/expire'
import { notifyUsers } from '@/lib/notify'
import { unlinkByStoragePath } from '@/lib/uploads'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

async function loadSummary(conversationId: string, meId: string) {
  const fresh = await db.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: { include: { user: { include: { presence: true } } } } },
  })
  if (!fresh) return null
  const contactRows = await db.contact.findMany({ where: { ownerId: meId } })
  const contacts: ContactFlags = new Map(
    contactRows.map((c) => [c.contactId, { nickname: c.nickname, favorite: c.favorite }])
  )
  const presenceByUser = new Map(fresh.participants.map((q) => [q.userId, q.user.presence]))
  return toConversationSummary(fresh, meId, fresh.participants, presenceByUser, contacts)
}

export const GET = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)

  if (isConversationExpired(access.conversation)) {
    throw gone('This conversation has expired.', 'CONVERSATION_EXPIRED')
  }

  const summary = await loadSummary(id, auth.profile.id)
  if (!summary) throw gone('This conversation has expired.', 'CONVERSATION_EXPIRED')
  return ok({ conversation: summary, iBlockedThem: access.iBlockedThem, theyBlockedMe: access.theyBlockedMe })
})

/** Shared conversation-level settings. Direct: either participant. Groups: no shared timers. */
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)
  const body = await req.json().catch(() => ({}))

  if (body.expirationPolicy !== undefined) {
    if (access.isGroup) {
      throw badRequest('Groups keep their history until deleted — expiration does not apply.', 'GROUP_NO_EXPIRY')
    }
    if (access.conversation.status !== 'active') {
      throw gone('Ended conversations cannot be changed.', 'CONVERSATION_ENDED')
    }
    if (!isExpirationPolicy(body.expirationPolicy)) {
      throw badRequest('Unknown expiration policy.', 'INVALID_POLICY')
    }
    const policy = body.expirationPolicy as (typeof EXPIRATION_POLICIES)[number]
    const expiresAt = computeExpiresAt(policy)
    const updated = await db.conversation.update({
      where: { id: access.conversation.id },
      data: { expirationPolicy: policy, expiresAt, status: 'active' },
    })
    await notifyUsers(
      [auth.profile.id, access.others[0].id],
      'conversation:updated',
      { conversationId: updated.id, expirationPolicy: policy, expiresAt: expiresAt?.toISOString() ?? null }
    )
  }

  if (body.end === true) {
    if (access.isGroup) {
      throw badRequest('Groups cannot be ended — leave the group or delete it if you created it.', 'GROUP_NO_END')
    }
    if (access.conversation.status !== 'active') {
      throw gone('Conversation already ended.', 'CONVERSATION_ENDED')
    }
    const updated = await db.conversation.update({
      where: { id: access.conversation.id },
      data: { status: 'ended' },
    })
    await notifyUsers(
      [auth.profile.id, access.others[0].id],
      'conversation:updated',
      { conversationId: updated.id, status: 'ended' }
    )
  }

  const summary = await loadSummary(id, auth.profile.id)
  if (!summary) throw gone('This conversation has expired.', 'CONVERSATION_EXPIRED')
  return ok({ conversation: summary })
})

/** Deletes the conversation for everyone (messages + media are removed). */
export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)

  if (access.isGroup && access.conversation.createdById !== auth.profile.id) {
    throw forbidden('Only the group creator can delete the group. You can leave it instead.', 'GROUP_DELETE_CREATOR_ONLY')
  }

  const messages = await db.message.findMany({ where: { conversationId: access.conversation.id }, select: { fileId: true } })
  await db.conversation.delete({ where: { id: access.conversation.id } })

  await notifyUsers(
    [auth.profile.id, ...access.others.map((o) => o.id)],
    'conversation:deleted',
    { conversationIds: [access.conversation.id], reason: 'deleted' }
  )

  // Media cleanup after rows are gone
  const fileIds = messages.map((m) => m.fileId).filter((v): v is string => Boolean(v))
  if (fileIds.length) {
    const files = await db.file.findMany({ where: { id: { in: fileIds } } })
    await db.file.deleteMany({ where: { id: { in: fileIds } } })
    for (const f of files) await unlinkByStoragePath(f.storagePath)
  }
  return ok({ deleted: true })
})
