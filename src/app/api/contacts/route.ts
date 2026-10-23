import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { avatarUrlFor } from '@/lib/dto'
import type { ContactDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * Contacts are ONE-WAY saved friends: saving someone does not grant them
 * message rights, reveal location data or bypass blocks — it only defines the
 * "Friends only" story audience for the saver and stores a private nickname.
 */
export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const rows = await db.contact.findMany({
    where: { ownerId: auth.profile.id },
    include: { contact: { include: { presence: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const contacts: ContactDTO[] = rows.map((r) => ({
    publicId: r.contact.publicId,
    displayName: r.contact.displayName,
    avatarUrl: avatarUrlFor(r.contact.avatarFileId),
    online: r.contact.presence?.isOnline ?? false,
    lastSeenAt: r.contact.presence?.isOnline ? null : r.contact.presence?.lastSeenAt.toISOString() ?? null,
    nickname: r.nickname,
    favorite: r.favorite,
    savedAt: r.createdAt.toISOString(),
  }))
  return ok({ contacts })
})

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`contact:${auth.profile.id}`, LIMITS.contactAdd.limit, LIMITS.contactAdd.windowMs)) {
    throw tooMany('Too many contact updates. Try later.', 600)
  }
  const body = await req.json().catch(() => ({}))
  const publicId = String(body?.publicId ?? '').trim()
  if (!publicId) throw badRequest('A user is required.', 'MISSING_USER')

  const target = await db.profile.findUnique({ where: { publicId } })
  if (!target) throw notFound('That user could not be found.', 'USER_NOT_FOUND')
  if (target.id === auth.profile.id) throw badRequest('You cannot save yourself.', 'SELF_CONTACT')

  const blocked = await db.blockedUser.findFirst({
    where: { OR: [{ blockerId: target.id, blockedId: auth.profile.id }, { blockerId: auth.profile.id, blockedId: target.id }] },
  })
  if (blocked) throw badRequest('This contact is unavailable.', 'BLOCKED')

  const nickname = typeof body?.nickname === 'string' && body.nickname.trim()
    ? body.nickname.trim().slice(0, 40)
    : undefined

  const contact = await db.contact.upsert({
    where: { ownerId_contactId: { ownerId: auth.profile.id, contactId: target.id } },
    create: { ownerId: auth.profile.id, contactId: target.id, nickname },
    update: nickname !== undefined ? { nickname } : {},
  })
  return ok({ publicId: target.publicId, nickname: contact.nickname, saved: true })
})
