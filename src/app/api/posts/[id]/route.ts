import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, notFound, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { notifyRoom } from '@/lib/notify'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** Delete own post. Votes and comments cascade away with it. */
export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params

  const post = await db.post.findUnique({ where: { id }, select: { id: true, authorId: true } })
  if (!post) throw notFound('That post is gone.', 'POST_NOT_FOUND')
  if (post.authorId !== auth.profile.id) {
    throw forbidden('Only the author can delete this post.', 'NOT_POST_AUTHOR')
  }

  await db.post.delete({ where: { id } })
  void notifyRoom('feed', 'feed:update', { reason: 'post_deleted', postId: id })

  return ok({ deleted: true })
})
