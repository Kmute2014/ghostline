import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, notFound, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { recomputeVoteScore } from '@/lib/posts'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Vote on a post: { value: 1 } like, { value: -1 } dislike, { value: 0 }
 * clears my vote. One vote per user per post (unique constraint) — voting the
 * other way switches it. Self-votes are refused (no score farming).
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id
  const { id } = await ctx.params

  if (!rateLimit(`postvote:${meId}`, LIMITS.postVote.limit, LIMITS.postVote.windowMs)) {
    throw tooMany('Too many votes — slow down a little.', 600)
  }

  const body = await req.json().catch(() => ({}))
  const value = typeof body?.value === 'number' ? Math.trunc(body.value) : NaN
  if (value !== 1 && value !== -1 && value !== 0) {
    throw badRequest('Vote must be 1 (like), -1 (dislike) or 0 (clear).', 'INVALID_VOTE')
  }

  const post = await db.post.findUnique({ where: { id }, select: { id: true, authorId: true } })
  if (!post) throw notFound('That post is gone.', 'POST_NOT_FOUND')
  if (post.authorId === meId) {
    throw badRequest('You cannot vote on your own post.', 'SELF_VOTE')
  }

  if (value === 0) {
    await db.postVote.deleteMany({ where: { postId: id, userId: meId } })
  } else {
    // Upsert — switching direction updates the existing row in place.
    await db.postVote.upsert({
      where: { postId_userId: { postId: id, userId: meId } },
      create: { postId: id, userId: meId, value },
      update: { value },
    })
  }

  const voteScore = await recomputeVoteScore(id)
  return ok({ voteScore, myVote: value })
})
