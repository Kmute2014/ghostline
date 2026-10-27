import { NextRequest } from 'next/server'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, notFound, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore, publishFirebaseBroadcastEvent, publishFirebaseUserEvent } from '@/lib/firebase-admin'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { getPostRetentionCutoff } from '@/lib/post-retention'
import { COMMENT_MAX_LEN, toPostDTO, toCommentDTO } from '@/lib/posts'
import { blockedIdsFor, normalizeFirestoreValue } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }
const COMMENT_TAKE = 200

async function loadPostForDTO(firestore: FirebaseFirestore.Firestore, postId: string, meId: string) {
  const ref = firestore.collection('posts').doc(postId)
  const snap = await ref.get()
  if (!snap.exists || !snap.data()?.createdAt || snap.data()!.createdAt.toDate().getTime() < getPostRetentionCutoff().getTime()) return null
  const data = normalizeFirestoreValue(snap.data())
  const [authorSnap, presenceSnap, voteSnap] = await Promise.all([
    firestore.collection('profiles').doc(String(data.authorId)).get(),
    firestore.collection('presences').doc(String(data.authorId)).get(),
    ref.collection('votes').doc(meId).get(),
  ])
  if (!authorSnap.exists) return null
  const author = normalizeFirestoreValue({ id: authorSnap.id, ...authorSnap.data() })
  author.presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
  return { id: snap.id, ...data, author, votes: voteSnap.exists ? [{ value: voteSnap.data()?.value }] : [] }
}

async function loadCommentDTO(firestore: FirebaseFirestore.Firestore, doc: FirebaseFirestore.QueryDocumentSnapshot, meId: string) {
  const c = normalizeFirestoreValue(doc.data())
  const [authorSnap, presenceSnap] = await Promise.all([
    firestore.collection('profiles').doc(String(c.authorId)).get(),
    firestore.collection('presences').doc(String(c.authorId)).get(),
  ])
  if (!authorSnap.exists) return null
  const author = normalizeFirestoreValue({ id: authorSnap.id, ...authorSnap.data() })
  author.presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
  return toCommentDTO({ id: doc.id, ...c, author } as never, meId)
}

export const GET = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id
  const { id } = await ctx.params
  const firestore = getFirebaseAdminFirestore()
  const post = await loadPostForDTO(firestore, id, meId)
  if (!post) throw notFound('That post is gone.', 'POST_NOT_FOUND')
  const [commentsSnap, blockedIds] = await Promise.all([
    firestore.collection('posts').doc(id).collection('comments').orderBy('createdAt', 'asc').limit(COMMENT_TAKE).get(),
    blockedIdsFor(firestore, meId),
  ])
  const comments = await Promise.all(commentsSnap.docs.filter((d) => !blockedIds.has(String(d.data().authorId))).map((d) => loadCommentDTO(firestore, d, meId)))
  return ok({ post: toPostDTO(post as never, meId), comments: comments.filter(Boolean) })
})

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id
  const { id } = await ctx.params
  if (!rateLimit(`comment:${meId}`, LIMITS.postComment.limit, LIMITS.postComment.windowMs)) throw tooMany('You are commenting too fast. Try again a bit later.', 1800)
  const body = await req.json().catch(() => ({}))
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const isAnonymous = body?.isAnonymous === true
  if (!text) throw badRequest('Comments cannot be empty.', 'EMPTY_COMMENT')
  if (text.length > COMMENT_MAX_LEN) throw badRequest(`Comments are limited to ${COMMENT_MAX_LEN} characters.`, 'COMMENT_TOO_LONG')
  const firestore = getFirebaseAdminFirestore()
  const postRef = firestore.collection('posts').doc(id)
  const postSnap = await postRef.get()
  if (!postSnap.exists || !postSnap.data()?.createdAt || postSnap.data()!.createdAt.toDate().getTime() < getPostRetentionCutoff().getTime()) throw notFound('That post is gone.', 'POST_NOT_FOUND')
  const post = postSnap.data()!
  const priorComments = await postRef.collection('comments').limit(1000).get()
  const otherCommenters = [...new Set(priorComments.docs.map((d) => String(d.data().authorId ?? '')).filter((authorId) => authorId && authorId !== meId && authorId !== post.authorId))]
  const commentRef = postRef.collection('comments').doc()
  const now = Timestamp.now()
  const batch = firestore.batch()
  batch.set(commentRef, { postId: id, authorId: meId, text, isAnonymous, createdAt: now, updatedAt: now })
  batch.update(postRef, { commentCount: FieldValue.increment(1), updatedAt: now })
  await batch.commit()
  void publishFirebaseBroadcastEvent('feed', 'feed:update', { reason: 'comment', postId: id }).catch(() => {})
  const notifyPromises: Promise<void>[] = []
  if (post.authorId !== meId) notifyPromises.push(publishFirebaseUserEvent([String(post.authorId)], 'buzz:notification', { title: 'Buzz', body: 'Someone commented on your post.', tag: `buzz-post-${id}`, url: '/?tab=feed', postId: id }))
  if (otherCommenters.length) notifyPromises.push(publishFirebaseUserEvent(otherCommenters, 'buzz:notification', { title: 'Buzz', body: 'Someone commented on a post you contributed to.', tag: `buzz-post-${id}`, url: '/?tab=feed', postId: id }))
  await Promise.all(notifyPromises)
  const commentSnap = await commentRef.get()
  const comment = await loadCommentDTO(firestore, commentSnap as never, meId)
  const updatedPost = await postRef.get()
  return ok({ comment, commentCount: Number(updatedPost.data()?.commentCount ?? 0) })
})
