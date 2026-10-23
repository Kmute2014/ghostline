import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { avatarUrlFor } from '@/lib/dto'
import type { BlockDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const rows = await db.blockedUser.findMany({
    where: { blockerId: auth.profile.id },
    include: { blocked: true },
    orderBy: { createdAt: 'desc' },
  })
  const blocks: BlockDTO[] = rows.map((r) => ({
    publicId: r.blocked.publicId,
    displayName: r.blocked.displayName,
    avatarUrl: avatarUrlFor(r.blocked.avatarFileId),
    blockedAt: r.createdAt.toISOString(),
  }))
  return ok({ blocks })
})

/**
 * Blocking stops discovery, matching, invites and messaging between the pair
 * (both directions). Existing conversations reject new messages.
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const body = await req.json().catch(() => ({}))
  const publicId = String(body?.publicId ?? '').trim()
  if (!publicId) throw badRequest('A user is required.', 'MISSING_USER')
  const target = await db.profile.findUnique({ where: { publicId } })
  if (!target) throw notFound('That user could not be found.', 'USER_NOT_FOUND')
  if (target.id === auth.profile.id) throw badRequest('You cannot block yourself.', 'SELF_BLOCK')

  await db.blockedUser.upsert({
    where: { blockerId_blockedId: { blockerId: auth.profile.id, blockedId: target.id } },
    create: { blockerId: auth.profile.id, blockedId: target.id },
    update: {},
  })
  return ok({ blocked: true, publicId })
})
