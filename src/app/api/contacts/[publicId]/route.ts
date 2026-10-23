import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ publicId: string }> }

/**
 * Updates one of my contacts. Accepts a private `nickname` and/or a `favorite`
 * flag. Favouriting auto-saves the contact if they are not saved yet —
 * favourited contacts always pin to the top of the Chats list.
 */
export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { publicId } = await ctx.params
  const body = await req.json().catch(() => ({}))

  const hasNickname = typeof body?.nickname === 'string' && body.nickname.trim().length > 0
  const hasFavorite = typeof body?.favorite === 'boolean'
  if (!hasNickname && !hasFavorite) {
    throw badRequest('Nothing to update — provide a nickname or a favorite flag.', 'EMPTY_UPDATE')
  }
  const nickname = hasNickname ? String(body.nickname).trim().slice(0, 40) : undefined

  const target = await db.profile.findUnique({ where: { publicId } })
  if (!target) throw notFound('That user could not be found.', 'USER_NOT_FOUND')

  const blocked = await db.blockedUser.findFirst({
    where: { OR: [{ blockerId: target.id, blockedId: auth.profile.id }, { blockerId: auth.profile.id, blockedId: target.id }] },
  })
  if (blocked) throw badRequest('This contact is unavailable.', 'BLOCKED')

  const contact = await db.contact.upsert({
    where: { ownerId_contactId: { ownerId: auth.profile.id, contactId: target.id } },
    create: {
      ownerId: auth.profile.id,
      contactId: target.id,
      nickname: nickname ?? null,
      favorite: hasFavorite ? body.favorite : false,
    },
    update: {
      ...(nickname !== undefined ? { nickname } : {}),
      ...(hasFavorite ? { favorite: body.favorite } : {}),
    },
  })
  return ok({ publicId, nickname: contact.nickname, favorite: contact.favorite, saved: true })
})

/** Removing a contact also removes my private nickname + favourite for them. */
export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { publicId } = await ctx.params
  const target = await db.profile.findUnique({ where: { publicId } })
  if (!target) throw notFound('That user could not be found.', 'USER_NOT_FOUND')
  await db.contact.deleteMany({ where: { ownerId: auth.profile.id, contactId: target.id } })
  return ok({ removed: true })
})
