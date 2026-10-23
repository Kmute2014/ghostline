import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { normalizeCode, isValidCodeShape } from '@/lib/ids'
import { rateLimit, LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * Previews what an invite code points to BEFORE acting on it:
 *  - user codes   ("XK7Q2M9P", 8 chars)  → who the person is (minimal profile)
 *  - group codes  ("GXK72M9P", 9 chars, leading G) → group name + member count
 *
 * Deliberately minimal. Blocks (either direction, checked against every group
 * member for group codes) return 404 so a blocked user cannot probe whether a
 * code exists; self codes return 400.
 */
export const GET = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`invite-lookup:${auth.profile.id}`, LIMITS.inviteLookup.limit, LIMITS.inviteLookup.windowMs)) {
    throw tooMany('Too many lookups. Slow down for a moment.', 60)
  }

  const raw = new URL(req.url).searchParams.get('code') ?? ''
  const code = normalizeCode(raw)

  // ── Group codes: leading "G", 9 normalized chars ──────────────────────────
  if (code.length === 9 && code.startsWith('G')) {
    if (!isValidCodeShape(code, 9, 9)) {
      throw badRequest('Group invite codes look like GXK72M9P.', 'INVALID_INVITE')
    }
    const candidates = [code, `G${code.slice(1, 5)}-${code.slice(5)}`]
    const group = await db.conversation.findFirst({
      where: { joinCode: { in: candidates }, type: 'group', status: 'active' },
      include: { participants: { select: { userId: true } } },
    })
    if (!group || !group.name) {
      throw notFound('No group is using this code. Check it and try again.', 'INVITE_NOT_FOUND')
    }
    const memberIds = group.participants.map((p) => p.userId)
    if (memberIds.includes(auth.profile.id)) {
      // Already a member — preview is harmless; joining is idempotent.
      return ok({ type: 'group', group: { name: group.name, memberCount: memberIds.length, isMember: true } })
    }
    const blockedEitherWay = await db.blockedUser.findFirst({
      where: {
        OR: [
          ...memberIds.map((m) => ({ blockerId: auth.profile.id, blockedId: m })),
          ...memberIds.map((m) => ({ blockerId: m, blockedId: auth.profile.id })),
        ],
      },
      select: { id: true },
    })
    if (blockedEitherWay) {
      // Vague on purpose — same wording the join flow uses.
      throw notFound('This invite code is not valid anymore.', 'INVITE_NOT_FOUND')
    }
    return ok({ type: 'group', group: { name: group.name, memberCount: memberIds.length, isMember: false } })
  }

  // ── User codes (existing flow) ─────────────────────────────────────────────
  if (!isValidCodeShape(code, 7, 8)) {
    throw badRequest('Invite codes look like XK7Q2M9P (7–8 characters).', 'INVALID_INVITE')
  }

  // Codes are stored dashed ("XK7Q-2M9P"); accept dashed or plain input.
  const candidates = [code]
  if (code.length === 8) candidates.unshift(`${code.slice(0, 4)}-${code.slice(4)}`)

  const owner = await db.profile.findFirst({
    where: { inviteCode: { in: candidates } },
    select: {
      id: true,
      publicId: true,
      displayName: true,
      avatarFileId: true,
      presence: { select: { isOnline: true, lastSeenAt: true } },
    },
  })
  if (!owner) throw notFound('No one is using this code. Check it and try again.', 'INVITE_NOT_FOUND')
  if (owner.id === auth.profile.id) {
    throw badRequest('That is your own invite code — share it with a friend!', 'SELF_INVITE')
  }

  const blockedEitherWay = await db.blockedUser.findFirst({
    where: { OR: [{ blockerId: auth.profile.id, blockedId: owner.id }, { blockerId: owner.id, blockedId: auth.profile.id }] },
    select: { id: true },
  })
  if (blockedEitherWay) {
    // Vague on purpose — same wording the redeem flow uses.
    throw notFound('This invite code is not valid anymore.', 'INVITE_NOT_FOUND')
  }

  return ok({
    type: 'user',
    profile: {
      publicId: owner.publicId,
      displayName: owner.displayName,
      avatarUrl: owner.avatarFileId ? `/api/files/${owner.avatarFileId}` : null,
      online: owner.presence?.isOnline ?? false,
      lastSeenAt: owner.presence?.lastSeenAt?.toISOString() ?? null,
    },
  })
})
