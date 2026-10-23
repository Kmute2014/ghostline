import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { generateGroupJoinCode } from '@/lib/ids'
import { rateLimit, LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Returns the group's shareable join code, creating it lazily for groups that
 * predate join codes. Body `{ rotate: true }` invalidates the old code and
 * issues a fresh one (rate-limited) — for when a link leaks somewhere it
 * shouldn't have. Participant-only; direct chats don't have join codes.
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params

  const conversation = await db.conversation.findUnique({
    where: { id },
    include: { participants: { select: { userId: true } } },
  })
  if (!conversation || conversation.status !== 'active') {
    throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
  }
  if (conversation.type !== 'group') {
    throw badRequest('Only group chats have invite codes.', 'NOT_A_GROUP')
  }
  if (!conversation.participants.some((p) => p.userId === auth.profile.id)) {
    throw badRequest('You are not a participant of this group.', 'NOT_PARTICIPANT')
  }

  const body = await req.json().catch(() => ({}))
  const rotate = body?.rotate === true

  let joinCode = conversation.joinCode
  if (!joinCode || rotate) {
    if (rotate && !rateLimit(`invite-rotate:${auth.profile.id}`, LIMITS.inviteRotate.limit, LIMITS.inviteRotate.windowMs)) {
      throw tooMany('Too many code refreshes. Try again later.', 1800)
    }
    // Retry on the (astronomically unlikely) unique collision.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const updated = await db.conversation.update({
          where: { id },
          data: { joinCode: generateGroupJoinCode() },
          select: { joinCode: true },
        })
        joinCode = updated.joinCode
        break
      } catch (err) {
        if (attempt === 2) throw err
      }
    }
  }

  return ok({
    joinCode,
    shareUrl: `${new URL(req.url).origin}/?invite=${joinCode}`,
    rotated: rotate,
  })
})
