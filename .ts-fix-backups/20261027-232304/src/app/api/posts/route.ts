import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore, publishFirebaseBroadcastEvent } from '@/lib/firebase-admin'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { getPostRetentionCutoff } from '@/lib/post-retention'
import { POST_MAX_LEN, HOT_CANDIDATES, FEED_TAKE, toPostDTO, hotRank } from '@/lib/posts'
import { avatarUrlFor } from '@/lib/dto'
import { blockedIdsFor, normalizeFirestoreValue } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'

export const GET = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const firestore = getFirebaseAdminFirestore()
  const meId = auth.profile.id
  const sort = req.nextUrl.searchParams.get('sort') === 'new' ? 'new' : 'hot'
  const cutoff = Timestamp.fromDate(getPostRetentionCutoff())
  const [postSnapshot, blockedIds] = await Promise.all([
    firestore.collection('posts').where('createdAt', '>=', cutoff).orderBy('createdAt', 'desc').limit(HOT_CANDIDATES).get(),
    blockedIdsFor(firestore, meId),
  ])
  const postRows = await Promise.all(postSnapshot.docs.map(async (doc) => {
    const data = normalizeFirestoreValue(doc.data())
    if (blockedIds.has(String(data.authorId))) return null
    const [authorSnap, presenceSnap, voteSnap] = await Promise.all([
      firestore.collection('profiles').doc(String(data.authorId)).get(),
      firestore.collection('presences').doc(String(data.authorId)).get(),
      doc.ref.collection('votes').doc(meId).get(),
    ])
    if (!authorSnap.exists) return null
    const author = normalizeFirestoreValue({ id: authorSnap.id, ...authorSnap.data() })
    author.presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
    const votes = voteSnap.exists ? [{ value: Number(voteSnap.data()?.value ?? 0) }] : []
    return { id: doc.id, ...data, author, votes }
  }))
  let posts = postRows.filter(Boolean).map((row: any) => toPostDTO(row, meId))
  if (sort === 'hot') posts = posts.sort((a: any, b: any) => hotRank(b) - hotRank(a))
  posts = posts.slice(0, FEED_TAKE)
  return ok({ posts, sort })
})

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id
  if (!rateLimit(`post:${meId}`, LIMITS.postCreate.limit, LIMITS.postCreate.windowMs)) throw tooMany('You are posting too fast. Take a breath and try later.', 3600)
  const body = await req.json().catch(() => ({}))
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const isAnonymous = body?.isAnonymous === true
  if (!text) throw badRequest('Say something first — the post cannot be empty.', 'EMPTY_POST')
  if (text.length > POST_MAX_LEN) throw badRequest(`Posts are limited to ${POST_MAX_LEN} characters.`, 'POST_TOO_LONG')
  const firestore = getFirebaseAdminFirestore()
  const now = Timestamp.now()
  const ref = firestore.collection('posts').doc()
  await ref.set({ authorId: meId, text, isAnonymous, createdAt: now, updatedAt: now, commentCount: 0, voteScore: 0 })
  void publishFirebaseBroadcastEvent('feed', 'feed:update', { reason: 'post', postId: ref.id }).catch(() => {})
  const [authorSnap, presenceSnap] = await Promise.all([
    firestore.collection('profiles').doc(meId).get(), firestore.collection('presences').doc(meId).get(),
  ])
  const author = normalizeFirestoreValue({ id: meId, ...(authorSnap.data() ?? auth.profile) })
  author.presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
  const post = { id: ref.id, authorId: meId, text, isAnonymous, createdAt: now.toDate(), updatedAt: now.toDate(), commentCount: 0, voteScore: 0, author, votes: [] }
  return ok({ post: toPostDTO(post as never, meId) })
})
