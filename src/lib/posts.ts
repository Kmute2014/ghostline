/**
 * Shared helpers for the Buzz feed: length limits, author/post/comment DTO
 * mapping, and hot ranking. This module uses Firestore instead of Prisma.
 */
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
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

  const lastHeartbeat = a.presence?.lastHeartbeatAt
  const heartbeatMs = lastHeartbeat instanceof Date ? lastHeartbeat.getTime() : Number.NaN
  const online = Boolean(
    a.presence?.isOnline && heartbeatMs > Date.now() - ONLINE_GRACE_MS,
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
    voteScore: Number(post.voteScore ?? 0),
    commentCount: Number(post.commentCount ?? 0),
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

/** Reddit-style decayed score — higher is hotter. */
export function hotRank(p: { voteScore: number; commentCount: number; createdAt: string }): number {
  const hours = Math.max(0.5, (Date.now() - new Date(p.createdAt).getTime()) / 3_600_000)
  return (p.voteScore + p.commentCount) / Math.pow(hours + 2, 1.4)
}

/**
 * Recomputes the cached vote score from posts/{postId}/votes and writes it to
 * the parent post document. The vote endpoint maintains the score in its
 * transaction; this helper is retained for maintenance or future callers.
 */
export async function recomputeVoteScore(postId: string): Promise<number> {
  const firestore = getFirebaseAdminFirestore()
  const postRef = firestore.collection('posts').doc(postId)
  const [postSnapshot, votesSnapshot] = await Promise.all([
    postRef.get(),
    postRef.collection('votes').get(),
  ])

  const score = votesSnapshot.docs.reduce(
    (total, vote) => total + Number(vote.data().value ?? 0),
    0,
  )

  if (postSnapshot.exists) {
    await postRef.update({ voteScore: score })
  }

  return score
}
