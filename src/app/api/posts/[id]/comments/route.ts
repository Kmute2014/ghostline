import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, notFound, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { notifyRoom } from '@/lib/notify'
import { COMMENT_MAX_LEN, toPostDTO, toCommentDTO, notBlockedAuthor } from '@/lib/posts'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const COMMENT_TAKE = 200

/**
 * Comments under a post. GET returns the post itself plus its visible
 * comments (block-paired authors are hidden) so a thread view is
 * self-sufficient. Comments are ordered oldest → newest (conversation flow).
 */
export const GET = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id
  const { id } = await ctx.params

  const post = await db.post.findUnique({
    where: { id },
    include: {
      author: { include: { presence: true } },
      votes: { where: { userId: meId }, select: { value: true } },
    },
  })
  if (!post) throw notFound('That post is gone.', 'POST_NOT_FOUND')

  const rows = await db.postComment.findMany({
    where: { postId: id, ...notBlockedAuthor(meId) },
    include: { author: { include: { presence: true } } },
    orderBy: { createdAt: 'asc' },
    take: COMMENT_TAKE,
  })

  return ok({ post: toPostDTO(post, meId), comments: rows.map((c) => toCommentDTO(c, meId)) })
})

/** Add a comment under a post. Text only, same length cap as posts. */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id
  const { id } = await ctx.params

  if (!rateLimit(`comment:${meId}`, LIMITS.postComment.limit, LIMITS.postComment.windowMs)) {
    throw tooMany('You are commenting too fast. Try again a bit later.', 1800)
  }

  const body = await req.json().catch(() => ({}))
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) throw badRequest('Comments cannot be empty.', 'EMPTY_COMMENT')
  if (text.length > COMMENT_MAX_LEN) {
    throw badRequest(`Comments are limited to ${COMMENT_MAX_LEN} characters.`, 'COMMENT_TOO_LONG')
  }

  const post = await db.post.findUnique({ where: { id }, select: { id: true } })
  if (!post) throw notFound('That post is gone.', 'POST_NOT_FOUND')

  const [comment, updated] = await db.$transaction([
    db.postComment.create({
      data: { postId: id, authorId: meId, text },
      include: { author: { include: { presence: true } } },
    }),
    db.post.update({ where: { id }, data: { commentCount: { increment: 1 } }, select: { commentCount: true } }),
  ])

  void notifyRoom('feed', 'feed:update', { reason: 'comment', postId: id })

  return ok({ comment: toCommentDTO(comment, meId), commentCount: updated.commentCount })
})
