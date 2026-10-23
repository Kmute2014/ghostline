import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { notifyUsers } from '@/lib/notify'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const MAX_GROUP_MEMBERS = 30

/**
 * Invites users into an existing group. Any member can invite; every added
 * user lands as a full participant. A candidate is skipped (and reported back
 * by display name) when a block exists between them and the inviter — groups
 * are shared spaces, but an invite never becomes a side-channel around a
 * closed contact.
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  if (!rateLimit(`members:${auth.profile.id}`, LIMITS.memberAdd.limit, LIMITS.memberAdd.windowMs)) {
    throw tooMany('Too many invite attempts. Try again later.', 1800)
  }

  const conversation = await db.conversation.findUnique({
    where: { id },
    include: { participants: { select: { userId: true } } },
  })
  if (!conversation || conversation.status !== 'active') {
    throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
  }
  if (conversation.type !== 'group') {
    throw badRequest('Members can only be added to group chats.', 'NOT_A_GROUP')
  }
  if (!conversation.participants.some((p) => p.userId === auth.profile.id)) {
    throw badRequest('You are not a participant of this group.', 'NOT_PARTICIPANT')
  }

  const body = await req.json().catch(() => ({}))
  const rawIds: unknown[] = Array.isArray(body?.memberPublicIds) ? body.memberPublicIds : []
  const publicIds = [
    ...new Set(rawIds.map((v) => String(v ?? '').trim()).filter((s): s is string => Boolean(s))),
  ]
  if (publicIds.length === 0) {
    throw badRequest('Pick at least one person to invite.', 'NO_MEMBERS')
  }

  const existing = new Set(conversation.participants.map((p) => p.userId))
  if (existing.size + publicIds.length > MAX_GROUP_MEMBERS) {
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

  const addedIds: string[] = []
  const addedNames: string[] = []
  const skipped: string[] = []
  for (const publicId of publicIds) {
    const t = found.get(publicId)!
    if (t.id === auth.profile.id) continue // silently drop self
    if (existing.has(t.id)) continue // already in — nothing to do
    const block = await db.blockedUser.findFirst({
      where: {
        OR: [
          { blockerId: t.id, blockedId: auth.profile.id },
          { blockerId: auth.profile.id, blockedId: t.id },
        ],
      },
      select: { id: true },
    })
    if (block) {
      skipped.push(t.displayName)
      continue
    }
    addedIds.push(t.id)
    addedNames.push(t.displayName)
  }

  if (addedIds.length === 0) {
    throw badRequest(
      skipped.length > 0
        ? `Couldn't add: ${skipped.join(', ')} (block active).`
        : 'Everyone selected is already in the group.',
      'NO_ADDABLE_MEMBERS'
    )
  }

  await db.conversationParticipant.createMany({
    data: addedIds.map((userId) => ({ conversationId: id, userId })),
  })

  // Timeline marker every member sees; live-delivered via conversation:updated.
  const joinedList =
    addedNames.length <= 3
      ? addedNames.join(', ')
      : `${addedNames.slice(0, 3).join(', ')} +${addedNames.length - 3} more`
  await db.message.create({
    data: {
      conversationId: id,
      senderId: auth.profile.id,
      type: 'system',
      text: `${auth.profile.displayName} added ${joinedList}`,
    },
  })

  // New members: full conversation appear-event (toast + list refresh + room join).
  await notifyUsers(addedIds, 'conversation:new', {
    conversationId: id,
    byPublicId: auth.profile.publicId,
    groupName: conversation.name ?? '',
  })
  // Everyone (including the newly added): roster + system message refresh.
  await notifyUsers([...existing, ...addedIds], 'conversation:updated', { conversationId: id })

  return ok({
    added: addedNames,
    skipped,
    memberCount: existing.size + addedIds.length,
  })
})
