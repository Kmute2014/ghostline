import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ publicId: string }> }

export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { publicId } = await ctx.params
  const target = await db.profile.findUnique({ where: { publicId } })
  if (!target) throw notFound('That user could not be found.', 'USER_NOT_FOUND')
  await db.blockedUser.deleteMany({
    where: { blockerId: auth.profile.id, blockedId: target.id },
  })
  return ok({ blocked: false })
})
