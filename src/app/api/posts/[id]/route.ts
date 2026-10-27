import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, notFound, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore, publishFirebaseBroadcastEvent } from '@/lib/firebase-admin'
import { getPostRetentionCutoff } from '@/lib/post-retention'
import { deleteQueryInBatches } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const firestore = getFirebaseAdminFirestore()
  const ref = firestore.collection('posts').doc(id)
  const postSnap = await ref.get()
  const post = postSnap.data()
  if (!postSnap.exists || !post?.createdAt || post.createdAt.toDate().getTime() < getPostRetentionCutoff().getTime()) throw notFound('That post is gone.', 'POST_NOT_FOUND')
  if (post.authorId !== auth.profile.id) throw forbidden('Only the author can delete this post.', 'NOT_POST_AUTHOR')
  await deleteQueryInBatches(firestore, ref.collection('votes'))
  await deleteQueryInBatches(firestore, ref.collection('comments'))
  await ref.delete()
  void publishFirebaseBroadcastEvent('feed', 'feed:update', { reason: 'post_deleted', postId: id }).catch(() => {})
  return ok({ deleted: true })
})
