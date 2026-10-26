import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, notFound, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { notifyRoom } from '@/lib/notify'
import { getPostRetentionCutoff } from '@/lib/post-retention'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string; commentId: string }> }

/**
 * Delete a comment. Allowed for its author — and for the post author
 * (thread owner moderates their own post). Keeps the cached counter at 0+.
 */
export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id
  const { id, commentId } = await ctx.params

  const [post, comment] = await Promise.all([
    db.post.findFirst({
      where: { id, createdAt: { gte: getPostRetentionCutoff() } },
      select: { id: true, authorId: true },
    }),
    db.postComment.findFirst({ where: { id: commentId, postId: id }, select: { id: true, authorId: true } }),
  ])
  if (!post) throw notFound('That post is gone.', 'POST_NOT_FOUND')
  if (!comment) throw notFound('That comment is gone.', 'COMMENT_NOT_FOUND')

  const canDelete = comment.authorId === meId || post.authorId === meId
  if (!canDelete) {
    throw forbidden('Only the comment author or the post author can remove a comment.', 'NOT_COMMENT_AUTHOR')
  }

  const [, updated] = await db.$transaction([
    db.postComment.delete({ where: { id: comment.id } }),
    db.post.update({ where: { id }, data: { commentCount: { decrement: 1 } }, select: { commentCount: true } }),
  ])

  void notifyRoom('feed', 'feed:update', { reason: 'comment_deleted', postId: id })

  return ok({ deleted: true, commentCount: Math.max(0, updated.commentCount) })
})
