import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { avatarUrlFor } from '@/lib/dto'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** Viewer list — owner only (privacy setting could disable this later). */
export const GET = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const story = await db.story.findUnique({ where: { id } })
  if (!story || story.ownerId !== auth.profile.id) throw notFound('Story not found.', 'STORY_NOT_FOUND')

  const views = await db.storyView.findMany({
    where: { storyId: id },
    include: { viewer: { include: { presence: true } } },
    orderBy: { viewedAt: 'desc' },
    take: 100,
  })

  return ok({
    viewers: views.map((v) => ({
      publicId: v.viewer.publicId,
      displayName: v.viewer.displayName,
      avatarUrl: avatarUrlFor(v.viewer.avatarFileId),
      online: v.viewer.presence?.isOnline ?? false,
      viewedAt: v.viewedAt.toISOString(),
    })),
  })
})
