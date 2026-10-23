import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { toConversationSummary, type ContactFlags } from '@/lib/dto'
import { createGroupConversation } from '@/lib/conversation-create'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { notifyUsers } from '@/lib/notify'

export const dynamic = 'force-dynamic'

const MAX_GROUP_NAME = 60
const MAX_GROUP_MEMBERS = 30

/**
 * Creates a group conversation with the caller as creator.
 * Body: { name: string, memberPublicIds: string[] }
 * Members blocked by (or blocking) the creator are skipped and reported back
 * so the UI can explain why someone is missing — groups are shared spaces,
 * but the creator never gets a side-channel to a person who closed contact.
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`conv:${auth.profile.id}`, LIMITS.conversationCreate.limit, LIMITS.conversationCreate.windowMs)) {
    throw tooMany('You are creating too many conversations too quickly.', 600)
  }

  const body = await req.json().catch(() => ({}))
  const name = String(body?.name ?? '').trim().slice(0, MAX_GROUP_NAME)
  if (!name) throw badRequest('A group name is required.', 'MISSING_NAME')

  const rawIds: unknown[] = Array.isArray(body?.memberPublicIds) ? body.memberPublicIds : []
  const publicIds = [
    ...new Set(rawIds.map((v) => String(v ?? '').trim()).filter((s): s is string => Boolean(s))),
  ]
  if (publicIds.length === 0) throw badRequest('Add at least one member to the group.', 'NO_MEMBERS')
  if (publicIds.length > MAX_GROUP_MEMBERS) {
    throw badRequest(`Groups are limited to ${MAX_GROUP_MEMBERS} members.`, 'TOO_MANY_MEMBERS')
  }

  const targets = await db.profile.findMany({
    where: { publicId: { in: publicIds } },
    select: { id: true, publicId: true, displayName: true },
  })
  const found = new Map(targets.map((t) => [t.publicId, t]))
  const missing = publicIds.filter((p) => !found.has(p))
  if (missing.length > 0) {
    throw badRequest('Some selected users could not be found.', 'USER_NOT_FOUND')
  }

  const memberIds: string[] = []
  const skipped: string[] = []
  for (const publicId of publicIds) {
    const t = found.get(publicId)!
    if (t.id === auth.profile.id) continue // silently drop self
    const block = await db.blockedUser.findFirst({
      where: { OR: [{ blockerId: t.id, blockedId: auth.profile.id }, { blockerId: auth.profile.id, blockedId: t.id }] },
      select: { id: true },
    })
    if (block) {
      skipped.push(t.displayName)
      continue
    }
    memberIds.push(t.id)
  }

  if (memberIds.length === 0) {
    throw badRequest('None of the selected users can be added (block active).', 'NO_ADDABLE_MEMBERS')
  }

  const conversation = await createGroupConversation(auth.profile.id, name, memberIds)

  // System marker so everyone sees who created the group in the timeline.
  await db.message.create({
    data: {
      conversationId: conversation.id,
      senderId: auth.profile.id,
      type: 'system',
      text: `${auth.profile.displayName} created the group “${name}”`,
    },
  })

  await notifyUsers([auth.profile.id, ...memberIds], 'conversation:new', {
    conversationId: conversation.id,
    byPublicId: auth.profile.publicId,
    groupName: name,
  })

  const fresh = await db.conversation.findUnique({
    where: { id: conversation.id },
    include: { participants: { include: { user: { include: { presence: true } } } } },
  })
  if (!fresh) throw badRequest('Could not create the group.', 'GROUP_LOST')
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
  return ok({ conversation: summary, skipped })
})
