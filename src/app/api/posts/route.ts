import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { notifyRoom } from '@/lib/notify'
import {
  POST_MAX_LEN,
  HOT_CANDIDATES,
  FEED_TAKE,
  toPostDTO,
  notBlockedAuthor,
  hotRank,
} from '@/lib/posts'

export const dynamic = 'force-dynamic'

/**
 * Buzz feed — every text post on Ghostline, minus block-paired authors.
 * sort=hot ranks by a decayed score (votes + comments); sort=new is plain
 * recency. Votes themselves are not broadcast — the client optimistically
 * patches and a 30s poll reconciles.
 */
export const GET = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id
  const sort = req.nextUrl.searchParams.get('sort') === 'new' ? 'new' : 'hot'

  const rows = await db.post.findMany({
    where: notBlockedAuthor(meId),
    include: {
      author: { include: { presence: true } },
      votes: { where: { userId: meId }, select: { value: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: HOT_CANDIDATES,
  })

  let posts = rows.map((r) => toPostDTO(r, meId))
  if (sort === 'hot') {
    posts = posts.sort((a, b) => hotRank(b) - hotRank(a))
  }
  posts = posts.slice(0, FEED_TAKE)

  return ok({ posts, sort })
})

/** Create a text post (no pictures, no videos — text only by design). */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id

  if (!rateLimit(`post:${meId}`, LIMITS.postCreate.limit, LIMITS.postCreate.windowMs)) {
    throw tooMany('You are posting too fast. Take a breath and try later.', 3600)
  }

  const body = await req.json().catch(() => ({}))
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const isAnonymous = body?.isAnonymous === true
  if (!text) throw badRequest('Say something first — the post cannot be empty.', 'EMPTY_POST')
  if (text.length > POST_MAX_LEN) {
    throw badRequest(`Posts are limited to ${POST_MAX_LEN} characters.`, 'POST_TOO_LONG')
  }

  const post = await db.post.create({
    data: { authorId: meId, text, isAnonymous },
    include: { author: { include: { presence: true } }, votes: { where: { userId: meId }, select: { value: true } } },
  })

  // Everyone connected hears the new post instantly; offline clients poll.
  void notifyRoom('feed', 'feed:update', { reason: 'post', postId: post.id })

  return ok({ post: toPostDTO(post, meId) })
})
