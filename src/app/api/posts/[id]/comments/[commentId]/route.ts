import { NextRequest } from 'next/server'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, notFound, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore, publishFirebaseBroadcastEvent } from '@/lib/firebase-admin'
import { getPostRetentionCutoff } from '@/lib/post-retention'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string; commentId: string }> }

export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id, commentId } = await ctx.params
  const firestore = getFirebaseAdminFirestore()
  const postRef = firestore.collection('posts').doc(id)
  const commentRef = postRef.collection('comments').doc(commentId)
  const [postSnap, commentSnap] = await Promise.all([postRef.get(), commentRef.get()])
  const post = postSnap.data()
  const comment = commentSnap.data()
  if (!postSnap.exists || !post?.createdAt || post.createdAt.toDate().getTime() < getPostRetentionCutoff().getTime()) throw notFound('That post is gone.', 'POST_NOT_FOUND')
  if (!commentSnap.exists) throw notFound('That comment is gone.', 'COMMENT_NOT_FOUND')
  if (comment?.authorId !== auth.profile.id && post.authorId !== auth.profile.id) throw forbidden('Only the comment author or the post author can remove a comment.', 'NOT_COMMENT_AUTHOR')
  await firestore.runTransaction(async (tx) => {
    const [freshPost, freshComment] = await Promise.all([tx.get(postRef), tx.get(commentRef)])
    if (!freshPost.exists || !freshComment.exists) throw notFound('That comment is gone.', 'COMMENT_NOT_FOUND')
    tx.delete(commentRef)
    tx.update(postRef, { commentCount: FieldValue.increment(-1), updatedAt: Timestamp.now() })
  })
  const updatedPost = await postRef.get()
  const rawCount = Math.max(0, Number(updatedPost.data()?.commentCount ?? 0))
  if (Number(updatedPost.data()?.commentCount ?? 0) < 0) await postRef.update({ commentCount: 0 })
  void publishFirebaseBroadcastEvent('feed', 'feed:update', { reason: 'comment_deleted', postId: id }).catch(() => {})
  return ok({ deleted: true, commentCount: rawCount })
})
