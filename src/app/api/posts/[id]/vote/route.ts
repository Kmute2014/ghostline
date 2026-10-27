import { NextRequest } from 'next/server'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, notFound, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore, publishFirebaseUserEvent } from '@/lib/firebase-admin'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { getPostRetentionCutoff } from '@/lib/post-retention'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id
  const { id } = await ctx.params
  if (!rateLimit(`postvote:${meId}`, LIMITS.postVote.limit, LIMITS.postVote.windowMs)) throw tooMany('Too many votes — slow down a little.', 600)
  const body = await req.json().catch(() => ({}))
  const value = typeof body?.value === 'number' ? Math.trunc(body.value) : NaN
  if (value !== 1 && value !== -1 && value !== 0) throw badRequest('Vote must be 1 (like), -1 (dislike) or 0 (clear).', 'INVALID_VOTE')
  const firestore = getFirebaseAdminFirestore()
  const postRef = firestore.collection('posts').doc(id)
  const voteRef = postRef.collection('votes').doc(meId)
  const [postSnap, previousSnap] = await Promise.all([postRef.get(), voteRef.get()])
  const post = postSnap.data()
  if (!postSnap.exists || !post?.createdAt || post.createdAt.toDate().getTime() < getPostRetentionCutoff().getTime()) throw notFound('That post is gone.', 'POST_NOT_FOUND')
  if (post.authorId === meId) throw badRequest('You cannot vote on your own post.', 'SELF_VOTE')
  const previousValue = previousSnap.exists ? Number(previousSnap.data()?.value ?? 0) : 0
  let voteScore = 0
  await firestore.runTransaction(async (tx) => {
    const [freshPost, votesSnap] = await Promise.all([tx.get(postRef), tx.get(postRef.collection('votes'))])
    if (!freshPost.exists) throw notFound('That post is gone.', 'POST_NOT_FOUND')
    if (value === 0) tx.delete(voteRef)
    else tx.set(voteRef, { postId: id, userId: meId, value, createdAt: previousSnap.exists ? previousSnap.data()?.createdAt ?? Timestamp.now() : Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true })
    voteScore = votesSnap.docs.reduce((total, doc) => total + (doc.id === meId ? 0 : Number(doc.data().value ?? 0)), value === 0 ? 0 : value)
    tx.update(postRef, { voteScore, updatedAt: FieldValue.serverTimestamp() })
  })
  if (value !== 0 && previousValue !== value) {
    await publishFirebaseUserEvent([String(post.authorId)], 'buzz:notification', {
      title: 'Buzz', body: 'Someone voted on your post.', tag: `buzz-post-${id}`, url: '/?tab=feed', postId: id,
    })
  }
  return ok({ voteScore, myVote: value })
})
