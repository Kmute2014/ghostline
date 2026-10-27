/**
 * Shared helpers for the Buzz feed (text-only posts à la Jodel):
 * length limits, author/post/comment → DTO mapping, and the "hot" ranking
 * used by the feed (score-weighted with time decay, computed over the most
 * recent slice of posts — plenty for a single-node deployment).
 */
import { db } from '@/lib/db'
import { avatarUrlFor } from '@/lib/dto'
import type { PostDTO, PostCommentDTO, PostAuthorDTO } from '@/lib/types'

export const POST_MAX_LEN = 300
export const COMMENT_MAX_LEN = 300

/** Matches the People directory's freshness window. */
const ONLINE_GRACE_MS = 75_000

/** How many recent posts are considered for the hot ranking. */
export const HOT_CANDIDATES = 150
export const FEED_TAKE = 100

type AuthorRow = {
  publicId: string
  displayName: string
  avatarFileId: string | null
  presence: { isOnline: boolean; lastHeartbeatAt: Date } | null
}

export function toPostAuthor(a: AuthorRow, isAnonymous = false): PostAuthorDTO {
  if (isAnonymous) {
    return {
      publicId: 'anonymous',
      displayName: 'Anonymous',
      avatarUrl: null,
      online: false,
      isAnonymous: true,
    }
  }
  const online = Boolean(
    a.presence?.isOnline && a.presence.lastHeartbeatAt.getTime() > Date.now() - ONLINE_GRACE_MS
  )
  return {
    publicId: a.publicId,
    displayName: a.displayName,
    avatarUrl: avatarUrlFor(a.avatarFileId),
    online,
    isAnonymous: false,
  }
}

type PostRow = {
  id: string
  text: string
  voteScore: number
  commentCount: number
  createdAt: Date
  authorId: string
  isAnonymous: boolean
  author: AuthorRow
  votes?: { value: number }[]
}

export function toPostDTO(post: PostRow, myId: string): PostDTO {
  const my = post.votes?.[0]?.value ?? 0
  return {
    id: post.id,
    text: post.text,
    author: toPostAuthor(post.author, post.isAnonymous),
    voteScore: post.voteScore,
    commentCount: post.commentCount,
    myVote: my === 1 ? 1 : my === -1 ? -1 : 0,
    isOwn: post.authorId === myId,
    createdAt: post.createdAt.toISOString(),
  }
}

type CommentRow = {
  id: string
  text: string
  createdAt: Date
  authorId: string
  isAnonymous: boolean
  author: AuthorRow
}

export function toCommentDTO(c: CommentRow, myId: string): PostCommentDTO {
  return {
    id: c.id,
    text: c.text,
    author: toPostAuthor(c.author, c.isAnonymous),
    isOwn: c.authorId === myId,
    createdAt: c.createdAt.toISOString(),
  }
}

/** Prisma `where` that excludes posts/comments authored by block-paired users. */
export function notBlockedAuthor(meId: string) {
  return {
    author: {
      blocksReceived: { none: { blockerId: meId } },
      blocksMade: { none: { blockedId: meId } },
    },
  }
}

/** Reddit-style decayed score — higher is hotter. */
export function hotRank(p: { voteScore: number; commentCount: number; createdAt: string }): number {
  const hours = Math.max(0.5, (Date.now() - new Date(p.createdAt).getTime()) / 3_600_000)
  return (p.voteScore + p.commentCount) / Math.pow(hours + 2, 1.4)
}

/** Recomputes the cached vote score from the PostVote rows (SQLite aggregate). */
export async function recomputeVoteScore(postId: string): Promise<number> {
  const agg = await db.postVote.aggregate({ where: { postId }, _sum: { value: true } })
  const score = agg._sum.value ?? 0
  await db.post.update({ where: { id: postId }, data: { voteScore: score } }).catch(() => undefined)
  return score
}
