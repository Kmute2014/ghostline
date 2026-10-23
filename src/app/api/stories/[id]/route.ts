import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { destroyFileRow } from '@/lib/uploads'
import { notifyUsers } from '@/lib/notify'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** Owners can delete their stories at any time. */
export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const story = await db.story.findUnique({ where: { id } })
  if (!story || story.ownerId !== auth.profile.id) throw notFound('Story not found.', 'STORY_NOT_FOUND')

  await db.story.delete({ where: { id } }) // cascades views
  await destroyFileRow(story.fileId)
  return ok({ deleted: true })
})
