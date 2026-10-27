import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, notFound, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Records a view. Access rule is enforced here (same as the feed): audience
 * 'friends' requires the creator to have saved the viewer as a contact.
 */
export const POST = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const story = await db.story.findUnique({ where: { id }, include: { owner: true } })
  if (!story || story.status !== 'active' || story.expiresAt.getTime() <= Date.now()) {
    throw notFound('This story is no longer available.', 'STORY_NOT_FOUND')
  }

  if (story.ownerId !== auth.profile.id) {
    if (story.audience === 'friends') {
      const saved = await db.contact.findFirst({
        where: { ownerId: story.ownerId, contactId: auth.profile.id },
      })
      if (!saved) throw forbidden('This story is only visible to friends of its creator.', 'STORY_FORBIDDEN')
    }
    const blocked = await db.blockedUser.findFirst({
      where: { OR: [{ blockerId: story.ownerId, blockedId: auth.profile.id }, { blockerId: auth.profile.id, blockedId: story.ownerId }] },
    })
    if (blocked) throw forbidden('This story is not available.', 'STORY_FORBIDDEN')
  }

  await db.storyView.upsert({
    where: { storyId_viewerId: { storyId: id, viewerId: auth.profile.id } },
    create: { storyId: id, viewerId: auth.profile.id },
    update: { viewedAt: new Date() },
  })

  const count = await db.storyView.count({ where: { storyId: id } })
  return ok({ viewCount: count })
})
